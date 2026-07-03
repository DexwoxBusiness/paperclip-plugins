import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID } from "./constants.js";

/**
 * Kiwi TCMS worker.
 *
 * Implementation backlog (Plane project PCLIP, module "Kiwi TCMS Plugin"):
 *  - PCLIP-29 JSON-RPC client with session handling (login, cache, single re-auth retry)
 *  - PCLIP-30 Agent tools: create/update/search cases, add to plan
 *  - PCLIP-31 CI results ingest: JUnit/Playwright -> TestRun.create + TestExecution.update (+comments)
 *  - PCLIP-32 plane:<id> tagging on every case/run; plane:unlinked for leakage visibility
 *  - PCLIP-33 Idempotent ingest keyed by build ID (plugin entities)
 *  - PCLIP-34 Nightly summary event
 *
 * Design note: one-way flow only (code -> Kiwi). Manual case content lives ONLY in Kiwi.
 * Kiwi RPC has no bulk endpoint: batch + rate-limit large ingests (1000+ tests).
 */
let context: PluginContext | undefined;

export default definePlugin({
  async setup(ctx: PluginContext) {
    context = ctx;
    ctx.logger.info(`${PLUGIN_ID} starting`);

    ctx.jobs.register(JOB_KEYS.nightlySummary, async (job) => {
      ctx.logger.info("nightly summary run", { runId: job.runId });
      // TODO(PCLIP-34): compute day stats from plugin state, emit plugin event (zero-activity still emits).
    });

    // TODO(PCLIP-30): ctx.tools.register(TOOL_NAMES.createTestCase, async (input) => { ... });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    // TODO(PCLIP-31/33): parse JUnit XML / Playwright JSON, validate, map via productMappings,
    // upsert TestRun by build ID, batch TestExecution updates with rate limiting.
    context?.logger.info("kiwi ci-results webhook received", { endpointKey: input.endpointKey });
  },
});
