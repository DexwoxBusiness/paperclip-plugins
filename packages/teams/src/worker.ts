import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID } from "./constants.js";

/**
 * Microsoft Teams Chat OS worker.
 *
 * Implementation backlog (Plane project PCLIP, module "Teams Plugin"):
 *  v1 (Workflows webhooks, no bot):
 *   - PCLIP-18 Adaptive Card notifications (v1.5 schema) on issue/approval/error/budget events
 *   - PCLIP-19 Per-event-type channel routing with default fallback
 *   - PCLIP-20 Action.OpenUrl deep links into Paperclip
 *   - PCLIP-21 Daily digest job
 *   - PCLIP-22 Retries (x3, backoff) + delivery observability
 *  v2 (Microsoft 365 Agents SDK bot — Bot Framework SDK is retired, do NOT use):
 *   - PCLIP-23 Entra app + Azure Bot on @microsoft/agents-hosting(+extensions-teams)
 *   - PCLIP-24 Universal Action (Action.Execute) approvals, actor logged as teams:{aadObjectId}
 *   - PCLIP-25 Public HTTPS messaging endpoint through this plugin's webhook route
 *   - PCLIP-27 @Paperclip command set
 */
let context: PluginContext | undefined;

export default definePlugin({
  async setup(ctx: PluginContext) {
    context = ctx;
    ctx.logger.info(`${PLUGIN_ID} starting`);

    // PCLIP-18: subscribe and post cards.
    // ctx.events.on("issue.created", async (event) => { /* postCard(routeFor("issue"), formatIssueCreated(event)) */ });
    // ctx.events.on("approval.created", async (event) => { /* postCard(routeFor("approval"), ...) */ });

    ctx.jobs.register(JOB_KEYS.dailyDigest, async (job) => {
      ctx.logger.info("daily digest run", { runId: job.runId });
      // TODO(PCLIP-21): pull stats from Paperclip API, post digest card; post "no activity" card when quiet.
    });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    // TODO(PCLIP-25): v2 bot messaging endpoint — validate Entra token, route activities/invokes.
    context?.logger.info("teams webhook received", { endpointKey: input.endpointKey });
  },
});
