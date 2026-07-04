import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID } from "./constants.js";
import { toWorkflowsMessage } from "./adaptive-card.js";
import { buildNotificationCard, channelFor, createBudgetDedupe, type TeamsNotification } from "./notifications.js";
import { classifyWorkflowRef, resolveWorkflowRef, type TeamsUrlConfig } from "./routing.js";
import { buildDeepLink } from "./links.js";
import { createWorkflowsClient, safeDeliver, type FetchLike } from "./delivery.js";
import {
  adaptAgentError,
  adaptApprovalCreated,
  adaptBudgetThreshold,
  adaptIssueCreated,
  adaptIssueDone,
  type RawPluginEvent,
} from "./event-adapters.js";

/**
 * Microsoft Teams Chat OS worker.
 *
 * Implemented:
 *  - PCLIP-18 (T1) v1 Adaptive Card notifications via Power Automate Workflows
 *    webhooks: issue.created, agent.task_completed (done), approval.created,
 *    agent.run.failed, budget soft/hard threshold crossings. Cards are v1.5,
 *    delivered in the Workflows message envelope, budget cards deduped per
 *    threshold, and delivery NEVER blocks the core flow.
 * Backlog (Plane project PCLIP, module "Teams Plugin"):
 *  - PCLIP-19 (T2) per-event-type channel routing   - PCLIP-20 (T3) deep links
 *  - PCLIP-21 (T4) daily digest                      - PCLIP-22 (T5) retries + observability
 *  - PCLIP-23..28 (T6..T11) v2 bot on the Microsoft 365 Agents SDK
 */
let context: PluginContext | undefined;

const INSTANCE_SCOPE = { scopeKind: "instance" } as const;

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

    // Resolve the target URL fresh per event (live config; per-type routing is T2,
    // so v1 always posts to the default Workflows URL).
    // Returns true only when a card was actually delivered (2xx). A missing URL or
    // a failed post returns false — the budget dedupe uses this to avoid marking a
    // threshold seen when nothing was posted.
    const deliver = async (n: TeamsNotification): Promise<boolean> => {
      // Route per event type to its channel's Workflows URL, falling back to the
      // default (T2). Config is read fresh so routing edits apply without a restart.
      const channel = channelFor(n);
      const cfg = (await ctx.config.get()) as TeamsUrlConfig & { allowPlaintextWorkflowUrl?: boolean };
      const ref = resolveWorkflowRef(channel, cfg);
      if (!ref) {
        log("teams notification skipped: no Workflows URL configured for channel", { kind: n.kind, channel });
        return false;
      }
      // Secure by default (Kody): only secret-refs are honored. A RAW plaintext URL
      // is delivered directly ONLY when the operator explicitly opts into the legacy
      // migration bridge (allowPlaintextWorkflowUrl) — otherwise it is refused, so a
      // config-writer can't defeat the secret-ref trust boundary and POST notification
      // content to an arbitrary host.
      let url: string;
      const decision = classifyWorkflowRef(ref, cfg.allowPlaintextWorkflowUrl === true);
      if (decision === "raw-blocked") {
        log("teams notification skipped: Workflows URL is a plaintext URL but allowPlaintextWorkflowUrl is off — store it as a secret reference (recommended), or enable the legacy flag to migrate", { kind: n.kind, channel });
        return false;
      }
      if (decision === "raw-allowed") {
        url = ref; // legacy plaintext mode, explicitly enabled by the operator
      } else {
        // Resolve the capability URL from its secret-ref at CALL TIME — never cached
        // or logged (AC #3). A resolution failure most likely means plugin secret-refs
        // are kill-switched (not the pinned build) — skip, never block (PAP-2394).
        try {
          url = await ctx.secrets.resolve(ref);
        } catch {
          log("teams notification skipped: could not resolve Workflows URL secret-ref (requires the pinned build, PAP-2394)", { kind: n.kind, channel });
          return false;
        }
      }
      if (!url) {
        log("teams notification skipped: empty Workflows URL from secret-ref", { kind: n.kind, channel });
        return false;
      }
      // PCLIP-20: attach a deep link to the exact entity (built from the public
      // base URL + company prefix, derived from the card's issue id when present).
      const linkCfg = cfg as { paperclipBaseUrl?: string; paperclipCompanyPrefix?: string };
      const link = buildDeepLink(n, { baseUrl: linkCfg.paperclipBaseUrl, companyPrefix: linkCfg.paperclipCompanyPrefix });
      const message = toWorkflowsMessage(buildNotificationCard({ ...n, link }));
      const outcome = await safeDeliver(client, url, message, log, { kind: n.kind, channel });
      return outcome.ok;
    };

    // Every handler is wrapped so a notification path NEVER throws into the core
    // Paperclip flow that emitted the event (AC #4).
    const on = (eventName: string, adapt: (ev: RawPluginEvent) => TeamsNotification | null): void => {
      ctx.events.on(eventName, async (ev) => {
        try {
          const n = adapt(ev);
          if (n) await deliver(n);
        } catch (e) {
          log("teams event handler error (swallowed)", { eventName, error: e instanceof Error ? e.message : String(e) });
        }
      });
    };

    on("issue.created", adaptIssueCreated);
    on("agent.task_completed", adaptIssueDone);
    on("approval.created", adaptApprovalCreated);
    on("agent.run.failed", adaptAgentError);

    // Budget thresholds: post at most once per (budget, threshold). The threshold is
    // marked seen only AFTER a successful delivery (postOnce), so a crossing before
    // the URL is set or during an outage is not permanently suppressed (AC #3).
    const onBudget = (eventName: string): void => {
      ctx.events.on(eventName, async (ev) => {
        try {
          const n = adaptBudgetThreshold(ev);
          if (!n || n.kind !== "budget-threshold") return;
          const result = await dedupe.postOnce(n.budgetId, n.threshold, () => deliver(n));
          if (result === "deduped") {
            log("teams budget card deduped (already posted for this threshold)", { budgetId: n.budgetId, threshold: n.threshold });
          }
        } catch (e) {
          log("teams budget handler error (swallowed)", { eventName, error: e instanceof Error ? e.message : String(e) });
        }
      });
    };
    onBudget("budget.soft_threshold_crossed");
    onBudget("budget.hard_threshold_crossed");

    ctx.jobs.register(JOB_KEYS.dailyDigest, async (job) => {
      ctx.logger.info("daily digest run", { runId: job.runId });
      // TODO(PCLIP-21/T4): pull stats from the Paperclip API, post a digest card,
      // and a compact "no activity" card when the last 24h were quiet.
    });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    // TODO(PCLIP-25/T8): v2 bot messaging endpoint — validate the Entra token and
    // route Teams activities / Action.Execute invokes.
    context?.logger.info("teams webhook received", { endpointKey: input.endpointKey });
  },
});
