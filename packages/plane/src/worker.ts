import { definePlugin, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { JOB_KEYS, PLUGIN_ID, WEBHOOK_KEYS } from "./constants.js";
import {
  createDeliveryRecorder,
  createPlaneWebhookHandler,
  createSeenStore,
  resolveEmitCompanyId,
  resolveEnabledEvents,
  type PlaneWebhookHandler,
} from "./webhook-handler.js";
import { createIdMappingStore, type IdMappingStore } from "./id-mapping.js";

/**
 * Plane Sync worker.
 *
 * Implemented:
 *  - PCLIP-1  Webhook intake + HMAC verification (constant-time), dedupe, delivery history
 *  - PCLIP-6  Bidirectional ID mapping in plugin_entities with sync cursor (id-mapping.ts)
 * Backlog (Plane project PCLIP, module "Plane Plugin"):
 *  - PCLIP-2  Sync rules: Plane project -> Paperclip project mapping + label filter (consumes idMapping.link/resolve)
 *  - PCLIP-3  Agent tools (get/search/create/comment/update)
 *  - PCLIP-4  Outbound mirror with echo-loop guard (uses idMapping.resolveByPaperclipId)
 *  - PCLIP-5  Reconciliation job (heals #4097/#6848 webhook gaps; uses cursor + markStale)
 */
let context: PluginContext | undefined;
let webhookHandler: PlaneWebhookHandler | undefined;
// PCLIP-6 bidirectional ID mapping (plane_id <-> paperclip_issue_id) with sync
// cursor, backed by plugin_entities. PCLIP-2 (mapping/upsert) and PCLIP-5
// (reconciliation) consume this.
let idMapping: IdMappingStore | undefined;

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
    // PCLIP-6: entity-backed ID mapping store (Postgres-persisted, survives restart).
    idMapping = createIdMappingStore(ctx.entities);

    webhookHandler = createPlaneWebhookHandler({
      getSecret: async () => {
        const config = (await ctx.config.get()) as { webhookSecret?: string };
        return config.webhookSecret ?? "";
      },
      isSeen: seenStore.isSeen,
      markSeen: seenStore.markSeen,
      // Bounded history + last-delivery mirror (PCLIP-8 reads this).
      recordDelivery: createDeliveryRecorder(state),
      // Event-type allowlist read fresh per delivery (live config, like the
      // secret). Default: issue + issue_comment; project/cycle/module opt-in.
      isEventTypeEnabled: async (eventType) => {
        const config = (await ctx.config.get()) as { enabledEvents?: unknown };
        return resolveEnabledEvents(config).has(eventType);
      },
      routeEvent: async (event) => {
        // AC #1 "routed to the event handler": verified deliveries are emitted
        // onto the plugin event bus as `plugin.dexwox.plane-sync.plane-event`
        // (requires `events.emit`, declared in the manifest). PCLIP-2 subscribes
        // to apply project mapping + label filter and upsert via PCLIP-6;
        // until per-mapping company resolution lands there, the emit target
        // company comes from `defaultCompanyId` config.
        // Scope note: routeEvent only ever sees ENABLED event types — the
        // handler's isEventTypeEnabled gate ignores optional types
        // (project/cycle/module) before this point unless opted into config.
        const config = (await ctx.config.get()) as { defaultCompanyId?: string };
        // Fail loudly if unconfigured: throwing makes the handler record
        // "failed" and the host return 502, so the delivery stays retryable —
        // a verified event is never dropped behind an HTTP 200.
        const companyId = resolveEmitCompanyId(config);
        await ctx.events.emit("plane-event", companyId, {
          event: event.event,
          action: event.action,
          entityId: event.entityId,
          projectId: event.projectId,
          workspaceId: event.workspaceId,
          payload: event.payload,
        });
        ctx.logger.info("plane event routed", {
          event: event.event,
          action: event.action,
          entityId: event.entityId,
        });
      },
      log: (message, fields) => ctx.logger.info(message, fields),
    });

    ctx.jobs.register(JOB_KEYS.reconcile, async (job) => {
      // PCLIP-6: the sync cursor persists across restarts in plugin_entities.
      // PCLIP-5 will page the Plane API from this watermark, diff against the ID
      // mapping, mark orphans stale (never delete), and advance the cursor.
      const cursor = await idMapping!.getCursor();
      ctx.logger.info("reconcile run", { runId: job.runId, cursor: cursor ?? "(unset)" });
      // TODO(PCLIP-5): page Plane API from cursor, diff against mapping via
      // resolveByPlaneId/resolveByPaperclipId, markStaleByPlaneId on orphans,
      // then idMapping.setCursor(newWatermark) once the page is fully processed.
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
      // Same silent-drop class as the companyId guard: a declared-but-unhandled
      // endpoint must fail loudly (host 502), not vanish behind a 200.
      throw new Error(`no handler for declared webhook endpoint '${input.endpointKey}'`);
    }
    await handler.handle({ headers: input.headers, rawBody: input.rawBody, requestId: input.requestId });
  },
});
