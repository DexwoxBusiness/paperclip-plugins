import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID, WEBHOOK_KEYS } from "./constants.js";
import {
  createDeliveryRecorder,
  createPlaneWebhookHandler,
  createSeenStore,
  type PlaneWebhookHandler,
} from "./webhook-handler.js";

/**
 * Plane Sync worker.
 *
 * Implemented:
 *  - PCLIP-1  Webhook intake + HMAC verification (constant-time), dedupe, delivery history
 * Backlog (Plane project PCLIP, module "Plane Plugin"):
 *  - PCLIP-2  Sync rules: Plane project -> Paperclip project mapping + label filter
 *  - PCLIP-3  Agent tools (get/search/create/comment/update)
 *  - PCLIP-4  Outbound mirror with echo-loop guard
 *  - PCLIP-5  Reconciliation job (heals #4097/#6848 webhook gaps)
 *  - PCLIP-6  ID mapping in plugin entities with sync cursor
 */
let context: PluginContext | undefined;
let webhookHandler: PlaneWebhookHandler | undefined;

const INSTANCE_SCOPE = { scopeKind: "instance" } as const;

export default definePlugin({
  async setup(ctx: PluginContext) {
    context = ctx;
    ctx.logger.info(`${PLUGIN_ID} starting`);

    const state = {
      get: (stateKey: string) => ctx.state.get({ ...INSTANCE_SCOPE, stateKey }),
      set: (stateKey: string, value: unknown) => ctx.state.set({ ...INSTANCE_SCOPE, stateKey }, value),
    };
    const seenStore = createSeenStore(state);

    webhookHandler = createPlaneWebhookHandler({
      getSecret: async () => {
        const config = (await ctx.config.get()) as { webhookSecret?: string };
        return config.webhookSecret ?? "";
      },
      isSeen: seenStore.isSeen,
      markSeen: seenStore.markSeen,
      // Bounded history + last-delivery mirror (PCLIP-8 reads this).
      recordDelivery: createDeliveryRecorder(state),
      routeEvent: async (event) => {
        // AC #1 "routed to the event handler": verified deliveries are emitted
        // onto the plugin event bus as `plugin.dexwox.plane-sync.plane-event`
        // (requires `events.emit`, declared in the manifest). PCLIP-2 subscribes
        // to apply project mapping + label filter and upsert via PCLIP-6;
        // until per-mapping company resolution lands there, the emit target
        // company comes from `defaultCompanyId` config.
        // Scope note: `issue` and `issue_comment` events are the sync surface;
        // `project` events are OPTIONAL per PCLIP-1 and may be ignored unless configured.
        const config = (await ctx.config.get()) as { defaultCompanyId?: string };
        if (config.defaultCompanyId) {
          await ctx.events.emit("plane-event", config.defaultCompanyId, {
            event: event.event,
            action: event.action,
            entityId: event.entityId,
            projectId: event.projectId,
            workspaceId: event.workspaceId,
            payload: event.payload,
          });
        } else {
          ctx.logger.info("plane event received but defaultCompanyId is not configured; event not emitted", {
            event: event.event,
            action: event.action,
          });
        }
        ctx.logger.info("plane event routed", {
          event: event.event,
          action: event.action,
          entityId: event.entityId,
        });
      },
      log: (message, fields) => ctx.logger.info(message, fields),
    });

    ctx.jobs.register(JOB_KEYS.reconcile, async (job) => {
      ctx.logger.info("reconcile run", { runId: job.runId });
      // TODO(PCLIP-5): page Plane API, diff against entity mapping, heal drift, log healed count.
    });

    // TODO(PCLIP-3): ctx.tools.register(TOOL_NAMES.getWorkItem, async (input) => { ... });
  },

  /**
   * Host routing contract (verified in server/src/routes/plugins.ts):
   * ONLY `POST /api/plugins/:pluginId/webhooks/:endpointKey` dispatches here,
   * and the host rejects (404) any endpointKey not declared in the manifest
   * before the worker is invoked. Method and path enforcement are therefore
   * host-owned; the endpointKey check below is defense-in-depth for the
   * multi-endpoint future, not a routing gate.
   */
  async onWebhook(input: PluginWebhookInput): Promise<void> {
    const ctx = context;
    const handler = webhookHandler;
    if (!ctx || !handler) throw new Error("plugin context not initialized");
    if (input.endpointKey !== WEBHOOK_KEYS.plane) {
      ctx.logger.info("unknown webhook endpoint", { endpointKey: input.endpointKey });
      return;
    }
    await handler.handle({ headers: input.headers, rawBody: input.rawBody, requestId: input.requestId });
  },
});
