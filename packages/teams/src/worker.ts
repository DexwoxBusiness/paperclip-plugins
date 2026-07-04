import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID } from "./constants.js";
import { toWorkflowsMessage } from "./adaptive-card.js";
import { buildNotificationCard, createBudgetDedupe, type TeamsNotification } from "./notifications.js";
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
      const cfg = (await ctx.config.get()) as { defaultWorkflowUrl?: string };
      const url = cfg.defaultWorkflowUrl ?? "";
      if (!url) {
        log("teams notification skipped: no default Workflows URL configured", { kind: n.kind });
        return false;
      }
      const message = toWorkflowsMessage(buildNotificationCard(n));
      const outcome = await safeDeliver(client, url, message, log, { kind: n.kind });
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
