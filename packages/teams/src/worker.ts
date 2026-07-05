import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, WEBHOOK_KEYS } from "./constants.js";
import { createConversationStore } from "./bot-conversations.js";
import { createTeamsBot, type TeamsBot } from "./bot.js";
import { BOT_FRAMEWORK_ISSUERS, BotInboundUnauthorizedError } from "./bot-auth.js";
import { describeMessagingEndpoint } from "./messaging-endpoint.js";
import { resolveSecretRef } from "./secret-resolve.js";
import { createApprovalsClient, extractDecidedApprovalRef, type ApprovalFetch } from "./approvals.js";
import { createApprovalStore } from "./approval-store.js";
import { toWorkflowsMessage } from "./adaptive-card.js";
import { buildNotificationCard, channelFor, createBudgetDedupe, type ChannelKind, type TeamsNotification } from "./notifications.js";
import { classifyWorkflowRef, resolveWorkflowRef, type TeamsInstanceConfig } from "./routing.js";
import { buildDeepLink } from "./links.js";
import { createWorkflowsClient, deliverWithRetry, deliveryMetricPoints, type FetchLike, type RetriedDelivery } from "./delivery.js";
import { createDeliveryHealth } from "./delivery-health.js";
import { buildDigestCard, createDigestAccumulator, digestDateKey, digestHourInZone } from "./digest.js";
import {
  adaptAgentError,
  adaptApprovalCreated,
  adaptBudgetThreshold,
  adaptIssueCreated,
  adaptIssueDone,
  extractCompletedAgent,
  extractCostCents,
  type RawPluginEvent,
} from "./event-adapters.js";

/**
 * Microsoft Teams Chat OS worker.
 *
 * Implemented (v1):
 *  - PCLIP-18 (T1) v1 Adaptive Card notifications via Power Automate Workflows
 *    webhooks (issue.created, issue.updated→done, approval.created,
 *    agent.run.failed, budget.incident.opened). Cards are v1.5, delivered in the
 *    Workflows envelope, budget cards deduped per threshold, never block the core flow.
 *  - PCLIP-19 (T2) per-event-type channel routing   - PCLIP-20 (T3) deep links
 *  - PCLIP-21 (T4) daily digest
 *  - PCLIP-22 (T5) delivery retries (transient ×3 w/ backoff, permanent no-retry) +
 *    success/failure metrics (ctx.metrics) + per-URL degraded-delivery status
 *    surfaced to settings via ctx.data("delivery-health").
 * Backlog (Plane project PCLIP, module "Teams Plugin"):
 *  - PCLIP-23..28 (T6..T11) v2 bot on the Microsoft 365 Agents SDK
 */
let context: PluginContext | undefined;
/** Lazily-constructed v2 bot (PCLIP-23), cached across webhook deliveries. */
let botPromise: Promise<TeamsBot> | undefined;

const INSTANCE_SCOPE = { scopeKind: "instance" } as const;

/** Plugin-state key: the date (server-local) the digest last posted, for once-a-day throttling. */
const DIGEST_LAST_RUN_DATE_KEY = "digest:last-run-date";

export default definePlugin({
  async setup(ctx: PluginContext) {
    context = ctx;
    ctx.logger.info(`${PLUGIN_ID} starting`);

    const log = (message: string, fields?: Record<string, unknown>) => ctx.logger.info(message, fields);
    const state = {
      get: (stateKey: string) => ctx.state.get({ ...INSTANCE_SCOPE, stateKey }),
      set: (stateKey: string, value: unknown) => ctx.state.set({ ...INSTANCE_SCOPE, stateKey }, value),
    };
    const client = createWorkflowsClient({ fetchFn: ((url, init) => fetch(url, init)) as FetchLike });
    const dedupe = createBudgetDedupe(state);
    // PCLIP-22 (T5): per-URL delivery health for degraded-delivery status (AC #3).
    // The threshold ("repeated failures" = consecutive FINAL failures on one URL,
    // reset by any success) is operator-configurable; read once at startup (an ops
    // knob, not a hot path — a restart applies a change, same as a capability list).
    const startupCfg = (await ctx.config.get()) as TeamsInstanceConfig;
    const health = createDeliveryHealth(state, { threshold: startupCfg.degradedDeliveryThreshold });
    // Surface degraded-delivery status to the plugin's settings UI (AC #3). No
    // capability required; usePluginData("delivery-health") reads this. The snapshot
    // is sanitized — URLs are fingerprinted, never returned raw (capability-URL safety).
    ctx.data.register("delivery-health", async () => health.snapshot());
    // PCLIP-25 (T8): surface the v2 bot's public messaging endpoint URL to settings so
    // operators can copy the exact value into the Azure Bot "Messaging endpoint" field and
    // see immediately if the configured public origin is missing/invalid/non-HTTPS. The URL
    // is derived (not stored) from the public origin + static route, so it is stable across
    // restarts (AC #5). No capability required; no secrets in the payload.
    ctx.data.register("messaging-endpoint", async () => {
      const cfg = (await ctx.config.get()) as TeamsInstanceConfig;
      return describeMessagingEndpoint(cfg.paperclipBaseUrl ?? "", PLUGIN_ID, WEBHOOK_KEYS.botMessages);
    });
    // PCLIP-21: accumulate the daily-digest rollup from events into plugin state.
    const digest = createDigestAccumulator(state);
    // Accumulate ONLY while the digest is enabled, so a disabled digest is fully
    // quiescent (no state growth). The `enableDailyDigest` flag is CACHED with a
    // short TTL (Kody perf): high-volume events (agent.run.finished,
    // cost_event.created) must not each hit ctx.config.get(). A ≤60s lag on an
    // enable/disable toggle is fine for a daily digest; no timer is used (lazy TTL).
    // Single-flight refresh: while the cache is stale, concurrent events share ONE
    // in-flight ctx.config.get() rather than each firing their own — otherwise a
    // burst of agent.run.finished at the TTL boundary would re-introduce the exact
    // config-store load the cache exists to remove (Kody). The promise is cleared
    // once it settles so the next stale window refreshes again.
    let digestEnabledCache = { value: false, at: 0 };
    let digestRefresh: Promise<void> | null = null;
    const isDigestEnabled = async (): Promise<boolean> => {
      if (Date.now() - digestEnabledCache.at <= 60_000) return digestEnabledCache.value;
      if (!digestRefresh) {
        // The real read; updates the cache when it resolves (even if the guard below
        // already timed out — a late value still refreshes the flag). The trailing
        // .catch is REQUIRED: if ctx.config.get() rejects AFTER the 5s race has
        // already settled on the timeout, this promise would otherwise reject with no
        // handler and trip Node's unhandled-rejection policy (Kody critical). The
        // deadline wrapper below owns the fallback, so here we just swallow the late
        // error (the stale cached flag is kept).
        const started = (async () => {
          const cfg = (await ctx.config.get()) as { enableDailyDigest?: boolean };
          digestEnabledCache = { value: cfg.enableDailyDigest === true, at: Date.now() };
        })().catch(() => {
          /* config-read error handled by the deadline wrapper; suppress late rejection */
        });
        // DEADLINE the shared refresh (Kody perf, high): all event handlers await
        // this ONE promise, so an un-deadlined hang in ctx.config.get() would block
        // digest accumulation across every handler indefinitely. On timeout we swallow
        // and fall back to the last cached flag so accumulation keeps flowing. The
        // in-flight ref is cleared in `finally` (unconditionally — a new refresh is
        // only ever created while it's null, and this worker is single-node/single-
        // threaded), so the NEXT stale check re-refreshes rather than reusing a
        // resolved promise forever (the identity-guard in the review snippet never
        // matched, which would have frozen the flag after the first read).
        digestRefresh = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              started,
              new Promise<void>((_, reject) => {
                timer = setTimeout(() => reject(new Error("digest config refresh timed out")), 5_000);
              }),
            ]);
          } catch {
            /* timeout or config-read error — keep the last cached value */
          } finally {
            if (timer) clearTimeout(timer);
            digestRefresh = null;
          }
        })();
      }
      await digestRefresh;
      return digestEnabledCache.value;
    };
    const accumulateIfEnabled = async (fn: () => Promise<void>): Promise<void> => {
      if (await isDigestEnabled()) await fn();
    };

    /**
     * Resolve the actual Workflows URL for a channel from live config: pick the ref
     * (per-type or default, T2), enforce the secret-ref trust boundary (Kody, T2),
     * and resolve secret-refs at call time (never cached/logged). Returns null when
     * nothing safe to post to. Shared by notification delivery and the digest job.
     */
    const resolveChannelUrl = async (
      cfg: TeamsInstanceConfig,
      channel: ChannelKind,
      logCtx: Record<string, unknown>,
    ): Promise<string | null> => {
      const ref = resolveWorkflowRef(channel, cfg);
      if (!ref) {
        log("teams delivery skipped: no Workflows URL configured for channel", { ...logCtx, channel });
        return null;
      }
      const decision = classifyWorkflowRef(ref, cfg.allowPlaintextWorkflowUrl === true);
      if (decision === "raw-blocked") {
        log("teams delivery skipped: Workflows URL is plaintext but allowPlaintextWorkflowUrl is off — store it as a secret reference, or enable the legacy flag to migrate", { ...logCtx, channel });
        return null;
      }
      if (decision === "raw-allowed") return ref; // legacy plaintext mode, explicitly enabled
      try {
        const url = await ctx.secrets.resolve(ref);
        return url || null;
      } catch {
        log("teams delivery skipped: could not resolve Workflows URL secret-ref (requires the pinned build, PAP-2394)", { ...logCtx, channel });
        return null;
      }
    };

    // PCLIP-22 (T5): deliver with retries, then record observability + health. This is
    // the single delivery path for BOTH notifications and the digest, so retry/backoff,
    // success-failure metrics, and degraded-URL tracking apply uniformly.
    //  - Retries: transient (429/5xx/timeout/network) ×3 with backoff; permanent (4xx)
    //    is returned immediately and logged with event type + channel (AC #1/#2).
    //  - Metrics: success/failure/retry points tagged by event type + channel (AC #4).
    //  - Health: consecutive failures per URL flip it to degraded past a threshold; a
    //    success recovers it. Surfaced via ctx.data (AC #3).
    // Observability side effects NEVER throw into the caller (non-blocking, AC #4 of T1).
    const deliverTracked = async (
      url: string,
      message: ReturnType<typeof toWorkflowsMessage>,
      meta: { eventType: string; channel: ChannelKind },
    ): Promise<RetriedDelivery> => {
      const r = await deliverWithRetry(client, url, message, log, { kind: meta.eventType, channel: meta.channel });
      // AC #4: success/failure rates in plugin observability. Metric writes must not
      // break delivery — swallow per point.
      for (const p of deliveryMetricPoints(r, meta)) {
        try {
          await ctx.metrics.write(p.name, p.value, p.tags);
        } catch (e) {
          log("teams metrics.write failed (swallowed)", { name: p.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // AC #3: update per-URL degraded status (fingerprinted; raw URL never stored).
      try {
        const transition = await health.record(url, r.outcome.ok, {
          channel: meta.channel,
          eventType: meta.eventType,
          status: r.outcome.status,
          error: r.outcome.ok ? undefined : r.outcome.error,
        });
        if (transition.justTripped) {
          log("teams delivery DEGRADED: repeated failures on a channel URL — surfaced in settings (delivery-health)", {
            channel: meta.channel,
            urlFingerprint: transition.urlFingerprint,
          });
        } else if (transition.justRecovered) {
          log("teams delivery recovered from degraded", { channel: meta.channel, urlFingerprint: transition.urlFingerprint });
        }
      } catch (e) {
        log("teams delivery-health update failed (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
      // AC #2: a permanent failure is logged with event type + channel (no retries were spent).
      if (!r.outcome.ok && !r.outcome.transient) {
        log("teams delivery permanent failure (not retried)", {
          eventType: meta.eventType,
          channel: meta.channel,
          status: r.outcome.status,
          error: r.outcome.error,
        });
      }
      return r;
    };

    // Deliver a notification card. Returns true only when a card was actually
    // delivered (2xx) — the budget dedupe uses this to avoid marking a threshold
    // seen when nothing was posted. Config is read fresh (routing edits need no restart).
    const deliver = async (n: TeamsNotification): Promise<boolean> => {
      const channel = channelFor(n);
      const cfg = (await ctx.config.get()) as TeamsInstanceConfig;
      const url = await resolveChannelUrl(cfg, channel, { kind: n.kind });
      if (!url) return false;
      // PCLIP-20: attach a deep link to the exact entity (public base URL + prefix).
      const link = buildDeepLink(n, { baseUrl: cfg.paperclipBaseUrl, companyPrefix: cfg.paperclipCompanyPrefix });
      const message = toWorkflowsMessage(buildNotificationCard({ ...n, link }));
      const r = await deliverTracked(url, message, { eventType: n.kind, channel });
      return r.outcome.ok;
    };

    // Every handler is wrapped so a notification path NEVER throws into the core
    // Paperclip flow that emitted the event (AC #4).
    // eventName is the plugin event-name union ctx.events.on expects (not a bare string),
    // so the literal calls below type-check against the host's event catalog.
    const on = (eventName: Parameters<typeof ctx.events.on>[0], adapt: (ev: RawPluginEvent) => TeamsNotification | null): void => {
      ctx.events.on(eventName, async (ev) => {
        try {
          const n = adapt(ev);
          if (n) await deliver(n);
        } catch (e) {
          log("teams event handler error (swallowed)", { eventName, error: e instanceof Error ? e.message : String(e) });
        }
      });
    };

    on("approval.created", adaptApprovalCreated);
    on("agent.run.failed", adaptAgentError); // real agent-error event (payload {agentId, issueId, error})
    // "Issue done" is an issue.updated transition INTO the done state (there is no
    // agent.task_completed event); adaptIssueDone returns null for non-done updates.
    on("issue.updated", adaptIssueDone);

    // issue.created also feeds the daily-digest "tasks created" counter (PCLIP-21).
    // Delivery and digest accumulation are in SEPARATE try/catch scopes (Kody), so a
    // failure in one path never skips the other (e.g. a delivery error must not drop
    // the event from the digest count, and vice versa).
    ctx.events.on("issue.created", async (ev) => {
      try {
        const n = adaptIssueCreated(ev);
        if (n) await deliver(n);
      } catch (e) {
        log("teams issue.created delivery error (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
      try {
        await accumulateIfEnabled(() => digest.onIssueCreated());
      } catch (e) {
        log("teams issue.created digest accumulation error (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
    });
    // DIGEST "tasks completed" SOURCE (per the task definition): agent.run.finished
    // is the SOLE source of the digest completion count. digest.onTaskCompleted
    // increments BOTH r.tasksCompleted AND the per-agent tally (active agents + top
    // performer) — see digest.ts. Reviewer note: issue.updated→done (above) is a
    // NOTIFICATION card only and deliberately does NOT feed the digest, because
    // counting both events would double-count completions. No card here (digest only).
    ctx.events.on("agent.run.finished", async (ev) => {
      try {
        await accumulateIfEnabled(() => digest.onTaskCompleted(extractCompletedAgent(ev)));
      } catch (e) {
        log("teams agent.run.finished handler error (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
    });
    // cost_event.created feeds only the digest cost total (AC #3). NOTE: the host
    // does not currently emit this event (cost logs `cost.reported`, unmapped), so
    // this is inert until the upstream gap is fixed — the digest cost stays $0 today.
    ctx.events.on("cost_event.created", async (ev) => {
      try {
        const cents = extractCostCents(ev);
        if (cents !== undefined) await accumulateIfEnabled(() => digest.onCostCents(cents));
      } catch (e) {
        log("teams cost_event.created handler error (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
    });

    // Budget thresholds arrive as a single budget.incident.opened event (soft AND
    // hard both map to it); dedupe once per (budget, derived threshold). Marked seen
    // only AFTER a successful delivery so an outage doesn't permanently suppress it.
    ctx.events.on("budget.incident.opened", async (ev) => {
      try {
        const n = adaptBudgetThreshold(ev);
        if (!n || n.kind !== "budget-threshold") return;
        const result = await dedupe.postOnce(n.budgetId, n.threshold, () => deliver(n));
        if (result === "deduped") {
          log("teams budget card deduped (already posted for this threshold)", { budgetId: n.budgetId, threshold: n.threshold });
        }
      } catch (e) {
        log("teams budget handler error (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
    });

    // PCLIP-24: when an approval is decided (in Paperclip, or via a Teams click that
    // called the REST API), refresh the interactive card in place via the bot
    // (updateActivity) — the event-driven path that mirrors Discord's editMessage. Only
    // acts when the bot is configured and we posted an interactive card for this approval.
    //
    // There is exactly ONE plugin event for a decision: `approval.decided`. The activity
    // ACTIONS `approval.approved` / `approval.rejected` (and `approval.revision_requested`)
    // all map to it (verified in host activity-log.ts) — they are NOT plugin events and are
    // NOT in PLUGIN_EVENT_TYPES, so `ctx.events.on("approval.approved", …)` is a compile
    // error. Do NOT add handlers for them; the outcome is read via getStatus below.
    // NOTE: the exact approval.decided payload shape is extracted defensively and should be
    // reconfirmed against the host at integration (see PCLIP-24 description).
    ctx.events.on("approval.decided", async (ev) => {
      try {
        const ref = extractDecidedApprovalRef(ev);
        if (!ref) {
          // No approval id on the event → nothing to refresh. Log so payload drift is
          // visible at integration (the event carries entityId = approval.id today).
          log("teams approval.decided: no approval id extracted (reconfirm payload)", {
            entityId: (ev as { entityId?: unknown }).entityId,
          });
          return;
        }
        const bot = await getBot(ctx);
        // The event doesn't carry approve-vs-reject; the bot reads it via getStatus.
        await bot.onApprovalDecided({ approvalId: ref.approvalId, byName: ref.decidedBy });
      } catch (e) {
        log("teams approval.decided handler error (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
    });

    // PCLIP-24 "Both" delivery: in ADDITION to the T1 Workflows approval notification
    // (the on("approval.created", …) above), post the INTERACTIVE bot card so it can be
    // Approved/Rejected in place. Only when the bot is configured AND an approvals
    // conversation is set (the bot must already be installed there). Separate try/catch
    // so a bot-post failure never affects the Workflows notification.
    // approval.created semantically means a NEW pending approval, so we post the actionable
    // card without a pre-check; if it was decided in the tiny window before posting, the
    // approval.decided handler above refreshes it to the decided state (self-healing).
    ctx.events.on("approval.created", async (ev) => {
      try {
        const cfg = (await ctx.config.get()) as TeamsInstanceConfig;
        const target = (cfg.botApprovalsConversationId ?? "").trim();
        if (!(cfg.botAppId ?? "").trim() || !target) return; // interactive approvals off
        const n = adaptApprovalCreated(ev);
        if (!n || n.kind !== "approval") return;
        const link = buildDeepLink(n, { baseUrl: cfg.paperclipBaseUrl, companyPrefix: cfg.paperclipCompanyPrefix });
        const bot = await getBot(ctx);
        await bot.postApprovalCard(target, {
          approvalId: n.approvalId,
          title: n.title,
          requester: n.requester,
          issueIdentifier: n.issueIdentifier,
          link: link ?? undefined,
        });
      } catch (e) {
        log("teams approval bot-post error (swallowed)", { error: e instanceof Error ? e.message : String(e) });
      }
    });

    // PCLIP-21: daily digest. The manifest ticks this HOURLY; we self-throttle to
    // the configured digestHour (in digestTimezone, else server-local) and post once
    // per day — so the time is adjustable at runtime (a static cron can't read
    // config). It fires from digestHour onward and retries hourly on failure until
    // it succeeds that day, so a transient outage doesn't drop the day's stats.
    ctx.jobs.register(JOB_KEYS.dailyDigest, async (job) => {
      try {
        const cfg = (await ctx.config.get()) as TeamsInstanceConfig;
        if (!cfg.enableDailyDigest) return;
        const nowDate = new Date();
        const hour = typeof cfg.digestHour === "number" ? cfg.digestHour : DEFAULT_CONFIG.digestHour;
        const tz = cfg.digestTimezone || undefined;
        // Reviewer note: `>= hour` (not `=== hour`) is INTENTIONAL. Posting is gated
        // to once/day by DIGEST_LAST_RUN_DATE_KEY, and firing "from digestHour
        // onward" is what lets the hourly tick RETRY later the same day if the exact
        // hour was missed or delivery failed (worker busy/down). `=== hour` would give
        // a single shot that can't recover. "09:00" therefore means "at/after 09:00".
        if (digestHourInZone(nowDate, tz) < hour) return; // not the digest hour yet today
        const today = digestDateKey(nowDate, tz);
        if ((await state.get(DIGEST_LAST_RUN_DATE_KEY)) === today) return; // already posted today

        const url = await resolveChannelUrl(cfg, "digest", { kind: "digest" });
        if (!url) {
          log("teams digest skipped: no channel configured", { runId: job.runId });
          return; // don't consume the window; retry next hour
        }
        // Snapshot the window, deliver, and only mark-the-day/keep-the-reset when
        // delivery SUCCEEDS — otherwise merge the snapshot back so it's retried
        // next hour rather than silently dropped (Codex/Kody).
        const rollup = await digest.readAndReset();
        const message = toWorkflowsMessage(buildDigestCard(rollup));
        // PCLIP-22: same retry + metrics + degraded-health path as notifications.
        const { outcome } = await deliverTracked(url, message, { eventType: "digest", channel: "digest" });
        if (!outcome.ok) {
          // The window was already reset by readAndReset, so the snapshot lives ONLY
          // in `rollup` until mergeBack persists it. If mergeBack itself fails (store
          // write error) the outer catch would swallow it and the next hourly run
          // would start from an empty rollup — the day's stats vanish silently.
          // Give mergeBack its own scope and RE-THROW on failure so the host records
          // the job as failed (surfacing the data-loss) instead of masking it (Kody).
          try {
            await digest.mergeBack(rollup);
          } catch (mergeErr) {
            log("teams digest mergeBack FAILED after delivery failure — stats for this window may be lost", {
              runId: job.runId,
              error: mergeErr instanceof Error ? mergeErr.message : String(mergeErr),
            });
            throw mergeErr;
          }
          log("teams digest delivery failed — snapshot merged back, will retry next hour", { runId: job.runId, ...outcome });
          return;
        }
        await state.set(DIGEST_LAST_RUN_DATE_KEY, today);
        ctx.logger.info("teams digest posted", {
          runId: job.runId,
          tasksCompleted: rollup.tasksCompleted,
          tasksCreated: rollup.tasksCreated,
          totalCostCents: rollup.totalCostCents,
        });
        // Operator reminder: cost stays $0 until the host emits cost_event.created
        // (it currently logs cost.reported, unmapped — see PCLIP-21 description).
        if (rollup.totalCostCents === 0) {
          log("teams digest total cost is $0 — host does not yet emit cost_event.created (cost.reported unmapped)", { runId: job.runId });
        }
      } catch (e) {
        // RE-THROW so the host records this job run as FAILED (Kody, critical).
        // This is essential for the mergeBack path: after readAndReset the window
        // snapshot lives ONLY in the local `rollup`, so if mergeBack re-throws
        // (persist failed), swallowing here would let the host mark the run
        // successful while the day's stats are gone — silent data loss. Failing the
        // run surfaces it and lets the host's job machinery retry.
        log("teams digest job failed", { error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    const ctx = context;
    if (!ctx) throw new Error("teams plugin not initialized");
    // The bot messaging endpoint (PCLIP-23). Only this endpointKey is a bot inbound;
    // anything else is ignored (undeclared keys are already 404'd by the host).
    if (input.endpointKey !== WEBHOOK_KEYS.botMessages) {
      ctx.logger.info("teams webhook received (non-bot endpoint, ignored)", { endpointKey: input.endpointKey });
      return;
    }
    const bot = await getBot(ctx);
    // handleInbound authenticates the Entra/Bot-Framework token and dispatches to the
    // Agents SDK adapter. On auth failure it THROWS — the host maps that to HTTP 502,
    // which rejects the unauthenticated call (AC #3). The plugin webhook cannot return
    // 401 or an inline response body (host contract), so replies go via the Connector
    // and Action.Execute invokes (T7) await an HTTP-response-capable webhook upstream.
    try {
      await bot.handleInbound(input.headers, input.rawBody);
    } catch (e) {
      if (e instanceof BotInboundUnauthorizedError) {
        // Unauthenticated / invalid-token probe (AC #2). Log the DETAILED reason
        // internally (health dashboard), correlated by the host requestId — it is NEVER
        // surfaced to the caller. Re-throw the SAME error so only its GENERIC
        // "unauthorized" message reaches the host's 502 body (no stack traces / internals).
        // The distinct auth metric lets operators separate a 502-from-auth from a
        // 502-from-error, since the fixed host envelope can't return a 401/403. Metrics
        // are best-effort and must not mask the rejection.
        ctx.logger.info("teams bot inbound rejected", { requestId: input.requestId, reason: e.reason });
        // `ctx.metrics.write` is FREE-FORM: the host contract is {name, value, tags} gated
        // ONLY by the `metrics.write` capability (declared in the manifest) — there is no
        // per-metric pre-declaration/allowlist/registry to add a metric name to (verified
        // against the plugin-sdk protocol + host). This emits the same way as the shipped
        // T5 `teams.delivery.*` metrics. Auth-path only; JWKS/infra vs bad-token detail is
        // in the log line above (e.reason). Best-effort: a metrics failure must not mask the reject.
        try {
          await ctx.metrics.write("teams.bot.inbound.rejected", 1, { reason: "auth" });
        } catch {
          /* metrics are best-effort */
        }
        throw e;
      }
      // Post-auth operational failure (e.g. malformed activity body, adapter error). The
      // caller is already-authenticated Teams, so the controlled error message is safe to
      // record and aids delivery-record/log correlation; re-throw so the host records a
      // 502 and can retry. (parseActivityBody etc. throw curated messages, never a stack.)
      ctx.logger.info("teams bot inbound processing error", {
        requestId: input.requestId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },
});

/**
 * Build (once) the v2 Teams bot from live config: bot app id, tenant, allowed issuers,
 * and the outbound credentials secret-ref, plus a conversation store over instance
 * state for proactive posting. Cached in `botPromise` so the CloudAdapter/JWKS client
 * is reused across deliveries. SDK-coupled (Agents SDK) — see bot.ts.
 */
function getBot(ctx: PluginContext): Promise<TeamsBot> {
  if (!botPromise) {
    botPromise = (async () => {
      const cfg = (await ctx.config.get()) as TeamsInstanceConfig;
      const botAppId = (cfg.botAppId ?? "").trim();
      if (!botAppId) throw new Error("bot not configured: set botAppId (Bot Microsoft App Id)");
      const extraIssuers = (cfg.botAllowedIssuers ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Outbound (proactive) credentials — resolved from a secret-ref via the leak-safe helper
      // (PCLIP-26): held in memory only, never logged/persisted; a failed resolve logs only the
      // error class. `unset` (no ref) is intentional — proactive send stays unauthenticated.
      const cred = await resolveSecretRef(
        (r) => ctx.secrets.resolve(r),
        cfg.botAppCredentialsRef,
        (m, f) => ctx.logger.info(m, f),
        "teams bot: could not resolve botAppCredentialsRef (proactive send will be unauthenticated until fixed)",
      );
      const clientSecret = cred.value;
      const tenantId = (cfg.botTenantId ?? "").trim() || undefined;
      // Raw auth config mapped onto the SDK's AuthConfiguration fields (verified against
      // @microsoft/agents-hosting auth/settings.d.ts). bot.ts normalizes it via
      // getAuthConfigWithDefaults. Field usage in the auth path:
      //   - clientId   → inbound token AUDIENCE (jwt-middleware verifies aud === clientId).
      //   - tenantId   → inbound: builds the Entra JWKS discovery URL
      //       (resolveAuthority(authority, tenantId)/discovery/v2.0/keys) that validates a
      //       single-tenant token's SIGNATURE; also scopes OUTBOUND MSAL token requests.
      //   - clientSecret → OUTBOUND (proactive) auth via the adapter's connection manager.
      // Deliberately NOT setting authConfig.issuers — do NOT "restore" it (verified
      // against the installed @microsoft/agents-hosting source):
      //   1. jwt-middleware.js NEVER reads authConfig.issuers. Inbound validation is
      //      audience (=== clientId) + RS256 signature (JWKS keyed off the token's OWN
      //      iss) + expiry. Setting issuers is INERT for inbound auth.
      //   2. getAuthConfigWithDefaults → applyDefaultSettings AUTO-FILLS issuers via
      //      getDefaultIssuers(tenantId) = [api.botframework.com, sts.windows.net/{t}/,
      //      login.microsoftonline.com/{t}/v2.0] when left unset. Hard-coding our own
      //      list would OVERRIDE those SDK-computed, authority-aware defaults (the
      //      default-set-replacement regression flagged in an earlier review). Leaving
      //      it unset yields the correct set.
      // The issuer allow-list that actually gates INBOUND is our assertBotClaims policy
      // (allowedIssuers below), which mirrors getDefaultIssuers for consistency.
      const authConfig = { clientId: botAppId, tenantId, clientSecret };
      // Issuers accepted by assertBotClaims (the real issuer gate). Include the tenant-
      // derived Entra issuers (v2 login.microsoftonline.com + v1 sts.windows.net) when a
      // tenant is configured, so SINGLE-TENANT tokens pass without the operator having to
      // list them; Teams channel/multi-tenant tokens use the Bot Framework issuer.
      const tenantIssuers = tenantId
        ? [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`]
        : [];
      const stateBackend = {
        get: (k: string) => ctx.state.get({ scopeKind: "instance", stateKey: k }),
        set: (k: string, v: unknown) => ctx.state.set({ scopeKind: "instance", stateKey: k }, v),
      };
      const conversations = createConversationStore(stateBackend);
      // PCLIP-24: interactive approvals. Board API key (optional in local_trusted) auths
      // the approve/reject REST calls. Uses NATIVE fetch, not ctx.http — the Paperclip API
      // often runs on localhost and ctx.http rejects private/reserved IPs (same reason the
      // Discord plugin uses native fetch). The base URL is the same paperclipBaseUrl used
      // for deep links.
      //
      // local_trusted vs production is distinguished by whether the ref is SET, not by a
      // mode flag the plugin can't see: NO ref → intentionally unauthenticated (local_trusted),
      // no warning, Authorization header omitted; ref SET but unresolvable → a real
      // misconfiguration, so we warn. The host decides whether the key is actually required.
      const board = await resolveSecretRef(
        (r) => ctx.secrets.resolve(r),
        cfg.paperclipBoardApiKeyRef,
        (m, f) => ctx.logger.info(m, f),
        "teams approvals: could not resolve paperclipBoardApiKeyRef (approve/reject may be unauthenticated)",
      );
      const boardApiKey = board.value || undefined;
      const approvals = {
        client: createApprovalsClient({
          baseUrl: cfg.paperclipBaseUrl ?? "",
          apiKey: boardApiKey,
          // Native fetch (not ctx.http) — ctx.http rejects private/reserved IPs and the
          // Paperclip API often runs on localhost. Params typed to avoid implicit any;
          // the native Response satisfies ApprovalFetchResponse (status + text()).
          fetchFn: ((url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
            fetch(url, init as RequestInit)) as ApprovalFetch,
        }),
        store: createApprovalStore(stateBackend),
      };
      // PCLIP-27 (T10): @Paperclip command data, backed by ctx reads. Company resolved once
      // (first visible company — matches the Slack plugin's fallback). Empty company or a
      // read failure yields empty lists → the cards render their no-data state, never silence.
      let cachedCompanyId: string | undefined;
      const resolveCompanyId = async (): Promise<string> => {
        if (cachedCompanyId === undefined) {
          const companies = await ctx.companies.list({ limit: 1, offset: 0 });
          cachedCompanyId = companies[0]?.id ?? "";
        }
        return cachedCompanyId;
      };
      const commands: CommandDeps = {
        listAgents: async () => {
          const cid = await resolveCompanyId();
          if (!cid) return [];
          const agents = await ctx.agents.list({ companyId: cid, limit: 100, offset: 0 });
          return agents.map((a) => ({ name: a.name, status: a.status }));
        },
        listRecentCompletions: async () => {
          const cid = await resolveCompanyId();
          if (!cid) return [];
          const issues = await ctx.issues.list({ companyId: cid, status: "done", limit: 5, offset: 0 });
          return issues.map((i) => ({ title: i.title ?? "(untitled)", status: i.status ?? "done" }));
        },
        listIssues: async (filter) => {
          const cid = await resolveCompanyId();
          if (!cid) return [];
          const status = filter === "done" ? ("done" as const) : filter === "open" ? ("todo" as const) : undefined;
          const issues = await ctx.issues.list({ companyId: cid, status, limit: 10, offset: 0 });
          return issues.map((i) => ({
            title: i.title ?? "(untitled)",
            status: i.status ?? "",
            url: buildDeepLink(
              { kind: "issue-created", issueId: i.id, issueIdentifier: i.identifier ?? undefined, title: i.title ?? "" },
              { baseUrl: cfg.paperclipBaseUrl ?? "", companyPrefix: cfg.paperclipCompanyPrefix },
            ),
          }));
        },
        // approve is enabled only when a Paperclip base URL is set (approvals reachable);
        // otherwise omit it so the command replies with the polite "not enabled" card.
        approve: (cfg.paperclipBaseUrl ?? "").trim()
          ? async (approvalId) => {
              const r = await approvals.client.decide("approve", approvalId, { actor: "teams:command" });
              return { ok: r.ok, verb: r.verb, error: r.error };
            }
          : undefined,
      };
      return createTeamsBot({
        authConfig,
        botAppId,
        allowedIssuers: [...BOT_FRAMEWORK_ISSUERS, ...tenantIssuers, ...extraIssuers],
        conversations,
        approvals,
        commands,
        onCommand: (command) => {
          // Best-effort metric (parity with Slack's slack.commands.handled); never blocks.
          void ctx.metrics.write("teams.commands.handled", 1, { command }).catch(() => undefined);
        },
        log: (m, f) => ctx.logger.info(m, f),
      });
    })().catch((e) => {
      // Don't cache a failed construction — allow a later delivery to retry once config is fixed.
      botPromise = undefined;
      throw e;
    });
  }
  return botPromise;
}
