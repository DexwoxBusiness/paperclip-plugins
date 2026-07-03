import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID } from "./constants.js";

/**
 * Test Context Registry worker.
 *
 * Implementation backlog (Plane project PCLIP, module "Test Context Registry"):
 *  - PCLIP-10 Data model: environments[], seedManifest (typed facts), stubMap, conventionsRef (POINTER only), secretEnvVars[]
 *  - PCLIP-11 get_test_context tool — CRITICAL INVARIANT: returns secret NAMES only; values resolve
 *             into the sandbox env via secret-refs (designed against the in-tree Daytona driver, see PCLIP-38)
 *  - PCLIP-12 Settings UI editor with SecretBindingPicker
 *  - PCLIP-13 Ephemeral env webhook (register/deregister per PR, auto-expiry, idempotent)
 *  - PCLIP-14 Freshness job (health pings, cred probes, seed staleness)
 *  - PCLIP-15 Versioned/auditable changes
 *  - PCLIP-16 Read API route for CI (same bundle shape as the tool)
 */
let context: PluginContext | undefined;

export default definePlugin({
  async setup(ctx: PluginContext) {
    context = ctx;
    ctx.logger.info(`${PLUGIN_ID} starting`);

    ctx.jobs.register(JOB_KEYS.freshness, async (job) => {
      ctx.logger.info("freshness run", { runId: job.runId });
      // TODO(PCLIP-14): ping health endpoints, probe creds (log secret NAMES only), flag stale seeds,
      // emit plugin events on failures. Failures must never block context reads.
    });

    // TODO(PCLIP-11): ctx.tools.register(TOOL_NAMES.getTestContext, async (input) => { ... });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    // TODO(PCLIP-13): authenticate via ciWebhookTokenRef, upsert/remove {prNumber, baseUrl, expiresAt}.
    context?.logger.info("ephemeral-env webhook received", { endpointKey: input.endpointKey });
  },
});
