import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID } from "./constants.js";

/**
 * Plane Sync worker.
 *
 * Implementation backlog (Plane project PCLIP, module "Plane Plugin"):
 *  - PCLIP-1  Webhook intake + HMAC verification (X-Plane-Signature, constant-time compare, dedupe)
 *  - PCLIP-2  Sync rules: Plane project -> Paperclip project mapping + label filter
 *  - PCLIP-3  Agent tools (get/search/create/comment/update)
 *  - PCLIP-4  Outbound mirror with echo-loop guard
 *  - PCLIP-5  Reconciliation job (heals #4097/#6848 webhook gaps)
 *  - PCLIP-6  ID mapping in plugin entities with sync cursor
 */
let context: PluginContext | undefined;

export default definePlugin({
  async setup(ctx: PluginContext) {
    context = ctx;
    ctx.logger.info(`${PLUGIN_ID} starting`);

    // PCLIP-4: mirror Paperclip -> Plane on issue/comment domain events.
    // ctx.events.on("issue.updated", async (event) => { /* mirror status w/ echo-loop guard */ });
    // ctx.events.on("issue.comment.created", async (event) => { /* mirror comment */ });

    // PCLIP-5: reconciliation backstop.
    ctx.jobs.register(JOB_KEYS.reconcile, async (job) => {
      ctx.logger.info("reconcile run", { runId: job.runId });
      // TODO(PCLIP-5): page Plane API, diff against entity mapping, heal drift, log healed count.
    });

    // PCLIP-3: agent tool handlers.
    // ctx.tools.register(TOOL_NAMES.getWorkItem, async (input) => { ... });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    // TODO(PCLIP-1): verify HMAC from X-Plane-Signature before touching the body;
    // reject invalid signatures; dedupe by delivery id; route Issue / Issue Comment events.
    context?.logger.info("plane webhook received", { endpointKey: input.endpointKey });
  },
});
