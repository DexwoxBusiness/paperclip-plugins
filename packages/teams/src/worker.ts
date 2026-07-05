import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, WEBHOOK_KEYS } from "./constants.js";
import { createConversationStore } from "./bot-conversations.js";
import { createTeamsBot, type TeamsBot } from "./bot.js";
import { BOT_FRAMEWORK_ISSUERS } from "./bot-auth.js";
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
      // Emit a distinct metric for AUTH rejections so operators can tell a
      // 502-from-auth apart from a 502-from-error in monitoring (the status alone
      // can't, given the host limitation). Never let metrics failure mask the reject.
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("unauthorized")) {
        try {
          await ctx.metrics.write("teams.bot.inbound.rejected", 1, { reason: "auth" });
        } catch {
          /* metrics are best-effort */
        }
      }
      throw e; // re-throw so the host records the rejection (502)
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
      // Outbound (proactive) credentials — resolved from a secret-ref, never logged.
      let clientSecret = "";
      const credRef = (cfg as { botAppCredentialsRef?: string }).botAppCredentialsRef;
      if (credRef) {
        try {
          clientSecret = (await ctx.secrets.resolve(credRef)) || "";
        } catch {
          ctx.logger.info("teams bot: could not resolve botAppCredentialsRef (proactive send will be unauthenticated until fixed)");
        }
      }
      // Raw auth config (clientId/tenantId/clientSecret) — bot.ts normalizes it via the
      // SDK's getAuthConfigWithDefaults (populates the audience/connections map used by
      // authorizeJWT, and carries clientSecret into the adapter's OUTBOUND auth). No
      // `as never` cast: the shape matches the SDK env-loader config.
      const authConfig = { clientId: botAppId, tenantId: (cfg.botTenantId ?? "").trim() || undefined, clientSecret };
      const conversations = createConversationStore({
        get: (k: string) => ctx.state.get({ scopeKind: "instance", stateKey: k }),
        set: (k: string, v: unknown) => ctx.state.set({ scopeKind: "instance", stateKey: k }, v),
      });
      return createTeamsBot({
        authConfig,
        botAppId,
        allowedIssuers: [...BOT_FRAMEWORK_ISSUERS, ...extraIssuers],
        conversations,
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
