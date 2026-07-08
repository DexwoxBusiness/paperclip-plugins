import { definePlugin, runWorker, type PluginContext, type PluginEvent, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, ISSUE_ORIGIN_KIND, JOB_KEYS, PLUGIN_ID, TOOL_NAMES, WEBHOOK_KEYS } from "./constants.js";
import pluginManifest from "./manifest.js";
import { createAgentTools, registerPlaneTools, type ToolRegistrar } from "./agent-tools.js";
import { createUnconfiguredPlaneClient, type PlaneClientPort, type PlaneReconcilePort } from "./plane-client.js";
import { createPlaneRestClient, type FetchLike, type PlaneRestClient } from "./plane-rest-client.js";
import { createReconciler, type Reconciler, type ReconcileRunSummary } from "./reconcile.js";
import {
  createOutboundMirrorHandler,
  createOutboundQueue,
  type OutboundEvent,
  type OutboundMirrorHandler,
} from "./outbound-mirror.js";
import {
  createDeliveryRecorder,
  createPlaneWebhookHandler,
  createSeenStore,
  resolveEmitCompanyId,
  resolveEnabledEvents,
  type PlaneWebhookHandler,
} from "./webhook-handler.js";
import { createIdMappingStore, type IdMappingStore } from "./id-mapping.js";
import {
  createSyncRulesHandler,
  normalizeSyncRules,
  validateSyncRulesConfig,
  type IssuesPort,
  type ProjectLookupPort,
  type SyncRulesHandler,
} from "./sync-rules.js";

/**
 * Plane Sync worker.
 *
 * Implemented:
 *  - PCLIP-1  Webhook intake + HMAC verification (constant-time), dedupe, delivery history
 *  - PCLIP-2  Sync rules: Plane project -> Paperclip project + label filter (sync-rules.ts)
 *  - PCLIP-3  Agent tools (get/search/create/comment/update, agent-tools.ts)
 *  - PCLIP-4  Outbound mirror: Paperclip status/comments -> Plane, echo guard + durable retry (outbound-mirror.ts)
 *  - PCLIP-6  Bidirectional ID mapping in plugin_entities with sync cursor (id-mapping.ts)
 *  - PCLIP-7  Authenticated Plane REST client + secret-ref auth (plane-rest-client.ts)
 * Backlog (Plane project PCLIP, module "Plane Plugin"):
 *  - PCLIP-5  Reconciliation job (heals #4097/#6848 webhook gaps; uses cursor + markStale)
 */
let context: PluginContext | undefined;
let webhookHandler: PlaneWebhookHandler | undefined;
// PCLIP-6 bidirectional ID mapping (plane_id <-> paperclip_issue_id) with sync
// cursor, backed by plugin_entities. PCLIP-2 (mapping/upsert) and PCLIP-5
// (reconciliation) consume this.
let idMapping: IdMappingStore | undefined;
// PCLIP-2 sync-rules handler (project mapping + label filter -> upsert Paperclip issue).
let syncHandler: SyncRulesHandler | undefined;
// PCLIP-3 agent tools talk to Plane through this client. Defaults to an
// "unconfigured" stub that returns a structured error until auth lands.
// TODO(PCLIP-7): replace with the authenticated Plane REST client (secret-ref
// API key via ctx.secrets, base URL, workspace slug, <=5s request timeout);
// wiring it here lights up the registered tools for live agent runs (AC3/AC5).
let planeClient: PlaneClientPort = createUnconfiguredPlaneClient();
// PCLIP-4 outbound mirror (Paperclip status/comments -> Plane). Set only when
// the Plane client is configured; drains a durable retry queue on a schedule.
let outboundMirror: OutboundMirrorHandler | undefined;

const INSTANCE_SCOPE = { scopeKind: "instance" } as const;

// PCLIP-5 reconciliation: plugin-state keys for the interval throttle + the run
// history that makes job runs observable (AC #4/#5).
const RECONCILE_LAST_RUN_KEY = "reconcile:last-run-at";
const RECONCILE_LAST_KEY = "reconcile:last";
const RECONCILE_HISTORY_KEY = "reconcile:runs";
const RECONCILE_HISTORY_LIMIT = 20;

type ReconcileStateAccess = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };

/** Persist the last run + a bounded run history to plugin state (AC #4 observability). */
async function recordReconcileRun(state: ReconcileStateAccess, summary: ReconcileRunSummary): Promise<void> {
  await state.set(RECONCILE_LAST_KEY, summary);
  const raw = await state.get(RECONCILE_HISTORY_KEY);
  const history = Array.isArray(raw) ? (raw as ReconcileRunSummary[]) : [];
  history.push(summary);
  while (history.length > RECONCILE_HISTORY_LIMIT) history.shift();
  await state.set(RECONCILE_HISTORY_KEY, history);
}

/**
 * Adapt a raw `issue.updated` domain event into the decoupled OutboundEvent.
 * Payload field names are defensive (confirmed against the host on connect).
 */
function adaptStatusEvent(ev: PluginEvent): OutboundEvent {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const issue = (p.issue ?? {}) as Record<string, unknown>;
  const old = (p.old ?? p.previous ?? {}) as Record<string, unknown>;
  const nw = (p.new ?? {}) as Record<string, unknown>;
  const changedRaw = p.changed_fields ?? p.changedFields ?? p.updated_fields;
  const changedFields = Array.isArray(changedRaw) ? changedRaw.map((f) => String(f)) : undefined;
  const newStatus = String(p.status ?? p.new_status ?? nw.status ?? issue.status ?? "");
  const oldStatus =
    p.old_status !== undefined ? String(p.old_status) : old.status !== undefined ? String(old.status) : undefined;
  // Only mirror a REAL status transition (Codex P2): if the event lists changed
  // fields and status/state is not among them, signal no-change (old == new) so
  // the handler skips. Otherwise compare old vs new when available; with no
  // change info at all, mirror best-effort (reconciliation PCLIP-5 is the backstop).
  const statusUnchanged = changedFields ? !changedFields.some((f) => f === "status" || f === "state") : undefined;
  return {
    kind: "status",
    paperclipIssueId: String(ev.entityId ?? issue.id ?? p.issueId ?? ""),
    actorType: ev.actorType,
    actorId: ev.actorId,
    newStatus: newStatus || undefined,
    oldStatus: statusUnchanged === true ? newStatus : oldStatus,
  };
}

/** Adapt a raw `issue.comment.created` domain event into an OutboundEvent. */
function adaptCommentEvent(ev: PluginEvent): OutboundEvent {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const comment = (p.comment ?? {}) as Record<string, unknown>;
  const issue = (p.issue ?? {}) as Record<string, unknown>;
  return {
    kind: "comment",
    // The event entityId may be the comment id, so prefer the payload's issue id.
    paperclipIssueId: String(p.issueId ?? p.issue_id ?? issue.id ?? ev.entityId ?? ""),
    actorType: ev.actorType,
    actorId: ev.actorId,
    commentBody: String(p.body ?? comment.body ?? p.comment_html ?? comment.comment_html ?? p.content ?? ""),
    commentAuthor: typeof p.author === "string" ? p.author : ev.actorId,
  };
}

const planePlugin = definePlugin({
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
    // PCLIP-5: reconciliation Plane data port + reconciler, wired only when the
    // Plane REST client is configured (below, and after the issues port exists).
    let planeReconcile: PlaneReconcilePort | undefined;
    let reconciler: Reconciler | undefined;

    // PCLIP-7: when auth + endpoint config is present, replace the unconfigured
    // stub with the authenticated Plane REST client. The API key is resolved
    // from its secret-ref at CALL TIME (never cached or logged); a rotated key or
    // ref is picked up automatically because getApiKey re-reads config each call.
    const authCfg = (await ctx.config.get()) as {
      planeApiKeyRef?: string;
      planeBaseUrl?: string;
      planeWorkspaceSlug?: string;
    };
    if (authCfg.planeApiKeyRef && authCfg.planeBaseUrl && authCfg.planeWorkspaceSlug) {
      const restClient = createPlaneRestClient({
        baseUrl: authCfg.planeBaseUrl,
        workspaceSlug: authCfg.planeWorkspaceSlug,
        getApiKey: async () => {
          const c = (await ctx.config.get()) as { planeApiKeyRef?: string };
          return c.planeApiKeyRef ? ctx.secrets.resolve(c.planeApiKeyRef) : "";
        },
        fetchFn: ((url, init) => fetch(url, init)) as FetchLike,
        timeoutMs: 5000,
      });
      planeClient = restClient;
      // PCLIP-5 pages Plane through the same authenticated client.
      planeReconcile = restClient;
      ctx.logger.info("Plane REST client configured (PCLIP-7)");

      // PCLIP-4: outbound mirror. Only wired when the Plane client is live.
      const outboundQueue = createOutboundQueue(state);
      outboundMirror = createOutboundMirrorHandler({
        idMapping,
        plane: planeClient,
        queue: outboundQueue,
        getConfig: async () => {
          const c = (await ctx.config.get()) as { outboundStateMap?: Record<string, string> };
          return { stateMap: c.outboundStateMap ?? {}, pluginId: PLUGIN_ID };
        },
        log: (message, fields) => ctx.logger.info(message, fields),
        // Dead-letters (permanent mirror failures) are operationally significant
        // — surface them at error level so they're not lost in info noise.
        logError: (message, fields) => ctx.logger.error(message, fields),
      });
      // Subscribe to Paperclip domain events. The adapters map the raw payload
      // shapes (field names confirmed against the host on connect) to the
      // decoupled OutboundEvent the handler consumes.
      ctx.events.on("issue.updated", async (ev) => {
        await outboundMirror!.handle(adaptStatusEvent(ev));
      });
      ctx.events.on("issue.comment.created", async (ev) => {
        await outboundMirror!.handle(adaptCommentEvent(ev));
      });
    } else {
      ctx.logger.info("Plane API not configured — agent tools return a 'not configured' error until the API key secret-ref is set");
    }

    // PCLIP-2: sync-rules handler. IssuesPort wraps ctx.issues; origin
    // (kind+id) gives idempotent create so a link failure never duplicates.
    const issuesPort: IssuesPort = {
      findByOrigin: async ({ companyId, projectId, originKind, originId }) => {
        const found = await ctx.issues.list({ companyId, projectId, originKind, originId, limit: 1 });
        return found[0] ? { id: found[0].id } : null;
      },
      create: async (input) => {
        const issue = await ctx.issues.create({
          companyId: input.companyId,
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          // Honor the caller's originKind (typed `plugin:${string}`) rather than
          // hardcoding, so origin-based idempotency/traceability is faithful.
          originKind: input.originKind,
          originId: input.originId,
        });
        return { id: issue.id };
      },
      update: async ({ issueId, companyId, title, description }) => {
        await ctx.issues.update(issueId, { title, description }, companyId);
      },
    };
    syncHandler = createSyncRulesHandler({
      // Read config fresh per event: ctx.config.get() returns the live saved
      // value, so settings-UI edits to syncRules apply without a restart (AC #4).
      getRules: async () => normalizeSyncRules((await ctx.config.get() as { syncRules?: unknown }).syncRules),
      idMapping,
      issues: issuesPort,
      originKind: ISSUE_ORIGIN_KIND,
      log: (message, fields) => ctx.logger.info(message, fields),
    });

    // PCLIP-5: reconciliation backstop. Built only when Plane is configured; it
    // reuses the SAME idempotent upsert as the webhook path (upsertMappedIssue —
    // no drift, no duplicates) and pages Plane through the authenticated client.
    if (planeReconcile) {
      reconciler = createReconciler({
        getRules: async () => normalizeSyncRules(((await ctx.config.get()) as { syncRules?: unknown }).syncRules),
        plane: planeReconcile,
        upsert: {
          idMapping: idMapping!,
          issues: issuesPort,
          originKind: ISSUE_ORIGIN_KIND,
          log: (message, fields) => ctx.logger.info(message, fields),
        },
        idMapping: idMapping!,
        state,
        log: (message, fields) => ctx.logger.info(message, fields),
      });
    }

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
        // PCLIP-2 is the AUTHORITATIVE consumer: apply sync rules and upsert the
        // mapped Paperclip issue IN-PROCESS. Running it here (not via a bus
        // self-subscription) means a sync failure throws -> host 502 -> Plane
        // retries, and the upsert is idempotent (origin + PCLIP-6 mapping), so
        // retries never duplicate. Scope note: only ENABLED event types reach
        // here (the isEventTypeEnabled gate ran upstream).
        await syncHandler!.handle(event);

        // Also emit onto the plugin event bus for any external subscribers
        // (telemetry / other plugins). defaultCompanyId is required in the
        // manifest; keep the fail-loud resolution so a misconfig is visible.
        const config = (await ctx.config.get()) as { defaultCompanyId?: string };
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
      if (!reconciler) return; // Plane not configured -> nothing to reconcile.
      // Configurable interval (AC #5): the manifest fires this on a 1-minute base
      // cadence; self-throttle to reconcileIntervalMinutes (default 15) since the
      // last run, so the effective interval follows live config without a restart.
      const cfg = (await ctx.config.get()) as { reconcileIntervalMinutes?: number };
      const intervalMin =
        typeof cfg.reconcileIntervalMinutes === "number" && cfg.reconcileIntervalMinutes > 0
          ? cfg.reconcileIntervalMinutes
          : DEFAULT_CONFIG.reconcileIntervalMinutes;
      const lastRunAt = Number((await state.get(RECONCILE_LAST_RUN_KEY)) ?? 0);
      const nowMs = Date.now();
      // 30s tolerance so cron jitter at the boundary doesn't defer a whole tick.
      if (lastRunAt && nowMs - lastRunAt < intervalMin * 60_000 - 30_000) return;
      // Stamp the attempt time BEFORE running so a slow run doesn't overlap the
      // next tick (the reconcile is idempotent, but we avoid concurrent scans).
      await state.set(RECONCILE_LAST_RUN_KEY, nowMs);

      // The reconciler logs a structured completion line; persist the full summary
      // (incl. any per-project error messages) to plugin state for observability.
      const summary = await reconciler.reconcile(job.runId);
      await recordReconcileRun(state, summary);
    });

    // PCLIP-4: drain the outbound-mirror retry queue (transient Plane outages).
    ctx.jobs.register(JOB_KEYS.outboundDrain, async (job) => {
      if (!outboundMirror) return; // not configured -> nothing queued
      // Per-dead-letter detail is already error-logged inside drainDue; keep this
      // summary line to counts only (the deadLetters array is not re-logged here).
      const res = await outboundMirror.drainDue();
      if (res.delivered || res.retried || res.deadLettered) {
        ctx.logger.info("outbound drain", {
          runId: job.runId,
          delivered: res.delivered,
          retried: res.retried,
          deadLettered: res.deadLettered,
        });
      }
    });

    // PCLIP-3: register the five agent tools. Handlers delegate to `planeClient`
    // via a getter so PCLIP-7 can swap in the authenticated client without
    // re-registering. Declarations (schema/description) come from the manifest.
    // registerPlaneTools does the register→invoke wiring (unit-tested with a fake
    // registrar). The adapter bridges our SDK-decoupled ToolRegistrar to
    // ctx.tools; the declaration cast is safe because the schema comes from the
    // manifest (a real JsonSchema).
    const registrar: ToolRegistrar = {
      register: (name, declaration, fn) =>
        ctx.tools.register(name, declaration as Parameters<typeof ctx.tools.register>[1], fn),
    };
    registerPlaneTools(
      registrar,
      createAgentTools(() => planeClient),
      pluginManifest.tools ?? [],
      TOOL_NAMES,
      (name) => ctx.logger.error("tool declaration missing from manifest", { name }),
    );
  },

  /**
   * PCLIP-2 AC #5: the host calls this after start, on save, and on "Test
   * Connection". Reject sync rules that reference unknown Paperclip projects
   * (checked via ctx.projects.get) or are malformed, with clear messages, so an
   * invalid mapping never persists.
   */
  async onValidateConfig(config: Record<string, unknown>) {
    const ctx = context;
    const lookup: ProjectLookupPort = {
      projectExists: async (companyId, projectId) => {
        // Before setup / without context we can only validate structure; skip
        // the existence check rather than block (host calls this post-start).
        if (!ctx) return true;
        try {
          return (await ctx.projects.get(projectId, companyId)) !== null;
        } catch {
          return false;
        }
      },
    };
    const result = await validateSyncRulesConfig(config.syncRules, lookup);
    const warnings = [...result.warnings];

    // PCLIP-7 AC #3: probe the Plane connection so the settings UI shows an
    // invalid/revoked key with a re-auth hint. Surfaced as a WARNING (visible,
    // non-blocking) so a transient Plane outage doesn't prevent saving config.
    const auth = config as { planeApiKeyRef?: string; planeBaseUrl?: string; planeWorkspaceSlug?: string };
    if (ctx && auth.planeApiKeyRef && auth.planeBaseUrl && auth.planeWorkspaceSlug) {
      const probe = createPlaneRestClient({
        baseUrl: auth.planeBaseUrl,
        workspaceSlug: auth.planeWorkspaceSlug,
        getApiKey: () => ctx.secrets.resolve(auth.planeApiKeyRef!),
        fetchFn: ((url, init) => fetch(url, init)) as FetchLike,
        timeoutMs: 5000,
      });
      const conn = await (probe as PlaneRestClient).testConnection();
      if (!conn.ok && conn.error) warnings.push(conn.error);
    }
    return { ok: result.ok, errors: result.errors, warnings };
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

export default planePlugin;
// Boot the SDK worker RPC host: the Paperclip host launches the worker with
// `node dist/worker.js`, so the entrypoint must start the IPC host and keep the
// process alive to answer the `initialize` handshake. Without this the worker
// exits (code 0) before initialize and activation fails.
runWorker(planePlugin, import.meta.url);
