import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID, WEBHOOK_KEYS } from "./constants.js";
import { createSeenChecker, handlePlaneWebhook } from "./webhook-handler.js";

/**
 * Plane Sync worker.
 *
 * Implemented:
 *  - PCLIP-1  Webhook intake + HMAC verification (constant-time), dedupe, delivery log
 * Backlog (Plane project PCLIP, module "Plane Plugin"):
 *  - PCLIP-2  Sync rules: Plane project -> Paperclip project mapping + label filter
 *  - PCLIP-3  Agent tools (get/search/create/comment/update)
 *  - PCLIP-4  Outbound mirror with echo-loop guard
 *  - PCLIP-5  Reconciliation job (heals #4097/#6848 webhook gaps)
 *  - PCLIP-6  ID mapping in plugin entities with sync cursor
 */
let context: PluginContext | undefined;

const INSTANCE_SCOPE = { scopeKind: "instance" } as const;

export default definePlugin({
  async setup(ctx: PluginContext) {
    context = ctx;
    ctx.logger.info(`${PLUGIN_ID} starting`);

    ctx.jobs.register(JOB_KEYS.reconcile, async (job) => {
      ctx.logger.info("reconcile run", { runId: job.runId });
      // TODO(PCLIP-5): page Plane API, diff against entity mapping, heal drift, log healed count.
    });

    // TODO(PCLIP-3): ctx.tools.register(TOOL_NAMES.getWorkItem, async (input) => { ... });
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    const ctx = context;
    if (!ctx) throw new Error("plugin context not initialized");
    if (input.endpointKey !== WEBHOOK_KEYS.plane) {
      ctx.logger.info("unknown webhook endpoint", { endpointKey: input.endpointKey });
      return;
    }

    const state = {
      get: (stateKey: string) => ctx.state.get({ ...INSTANCE_SCOPE, stateKey }),
      set: (stateKey: string, value: unknown) => ctx.state.set({ ...INSTANCE_SCOPE, stateKey }, value),
    };

    await handlePlaneWebhook(
      { headers: input.headers, rawBody: input.rawBody, requestId: input.requestId },
      {
        getSecret: async () => {
          const config = (await ctx.config.get()) as { webhookSecret?: string };
          return config.webhookSecret ?? "";
        },
        checkAndMarkSeen: createSeenChecker(state),
        recordDelivery: async (entry) => {
          await state.set("last-delivery", { ...entry, at: new Date().toISOString() });
        },
        routeEvent: async (event) => {
          // TODO(PCLIP-2): apply project mapping + label filter, upsert Paperclip issue via ID mapping (PCLIP-6).
          ctx.logger.info("plane event routed", {
            event: event.event,
            action: event.action,
            entityId: event.entityId,
          });
        },
        log: (message, fields) => ctx.logger.info(message, fields),
      },
    );
  },
});
