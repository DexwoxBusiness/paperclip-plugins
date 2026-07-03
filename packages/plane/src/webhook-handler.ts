import { createHash } from "node:crypto";
import { parsePlaneEvent, type ParsedPlaneEvent } from "./plane-events.js";
import { extractPlaneSignature, verifyPlaneSignature } from "./signature.js";

export type { ParsedPlaneEvent } from "./plane-events.js";

/**
 * Core webhook handling logic for PCLIP-1, decoupled from the SDK runtime.
 *
 * Review-hardened (PR #1 — Codex + Kody findings):
 *  - Deliveries are marked seen ONLY AFTER routing succeeds, so a transient
 *    routeEvent failure leaves the delivery retryable (Codex P2).
 *  - Same-hash concurrent deliveries are serialized via a synchronous
 *    in-flight set, closing the read-check-write race (Kody).
 *  - recordDelivery is observability, never control flow: failures are
 *    caught and logged, and can never mask the 401 rejection (Kody).
 *
 * Note on routing: the host maps POST /api/plugins/:pluginId/webhooks/:endpointKey
 * to onWebhook based on the manifest `webhooks` declaration — no explicit route
 * registration exists or is needed (Codex MUST_FIX #1 is a non-issue by SDK contract).
 */

/**
 * Signature-rejection error. NOTE (verified against host source,
 * server/src/routes/plugins.ts): the host maps ANY worker error on
 * handleWebhook to HTTP 502 {status:"failed", error} and records the
 * delivery as failed — there is no worker-controlled HTTP status. The
 * `statusCode = 401` here is semantic (recorded in delivery history and
 * the error name/message); the external caller observes 502. AC #2's
 * "401" is therefore satisfied at the plugin layer, not the HTTP layer.
 * A host-side statusCode passthrough would be an upstream contribution.
 */
export class WebhookRejectedError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "WebhookRejectedError";
  }
}

export interface DeliveryRecord {
  requestId: string;
  outcome: "accepted" | "rejected" | "duplicate" | "ignored" | "failed";
  detail?: string;
}

export interface WebhookHandlerDeps {
  /** Webhook HMAC secret from plugin config. */
  getSecret(): Promise<string>;
  /** True if this delivery hash was already processed successfully. Read-only. */
  isSeen(deliveryHash: string): Promise<boolean>;
  /** Persist a hash as successfully processed. Called ONLY after routeEvent succeeds. */
  markSeen(deliveryHash: string): Promise<void>;
  /** Record delivery outcome for observability (PCLIP-8 feeds off this). Failures are swallowed + logged. */
  recordDelivery(entry: DeliveryRecord): Promise<void>;
  /** Route an accepted, deduped event (PCLIP-2 mapping consumes this). */
  routeEvent(event: ParsedPlaneEvent): Promise<void>;
  log(message: string, fields?: Record<string, unknown>): void;
}

export interface WebhookRequest {
  headers: Record<string, string | string[]>;
  rawBody: string;
  requestId: string;
}

export function deliveryHash(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * Observability write that can never affect control flow. One retry for
 * transient state-store hiccups; a persistent failure is logged and dropped
 * (the host independently records every delivery in plugin_webhook_deliveries,
 * so plugin-level history loss degrades detail, not auditability).
 */
async function recordSafely(deps: WebhookHandlerDeps, entry: DeliveryRecord): Promise<void> {
  try {
    await deps.recordDelivery(entry);
  } catch {
    try {
      await deps.recordDelivery(entry);
    } catch (error) {
      deps.log("failed to record delivery", { requestId: entry.requestId, error: String(error) });
    }
  }
}

export interface PlaneWebhookHandler {
  handle(request: WebhookRequest): Promise<void>;
}

/**
 * Create a handler instance. The in-flight set lives per instance: within one
 * worker process it serializes concurrent same-body deliveries because the
 * membership check + insert happen synchronously (no await in between).
 *
 * KNOWN LIMITATION (accepted): cross-process dedupe is best-effort via the
 * persisted seen store. In Paperclip's current deployment model this is moot —
 * plugins run as ONE out-of-process worker per plugin on a single-node,
 * self-hosted instance (PLUGIN_SPEC "Current implementation caveats"), so all
 * deliveries for this plugin flow through one in-flight set. If Paperclip ever
 * ships multi-node plugin workers, replace the seen store with an atomic
 * check-and-set. Either way the reconciliation job (PCLIP-5) is the
 * correctness backstop, converging any duplicate side effects.
 */
export function createPlaneWebhookHandler(deps: WebhookHandlerDeps): PlaneWebhookHandler {
  const inFlight = new Set<string>();

  return {
    async handle(request: WebhookRequest): Promise<void> {
      const secret = await deps.getSecret();
      const signature = extractPlaneSignature(request.headers);

      // AC: invalid/missing signature -> reject 401, log, never process the body.
      // recordSafely guarantees a state-store hiccup cannot mask the 401 (Kody).
      if (!verifyPlaneSignature(request.rawBody, signature, secret)) {
        await recordSafely(deps, {
          requestId: request.requestId,
          outcome: "rejected",
          detail: signature ? "invalid signature" : "missing signature",
        });
        deps.log("plane webhook rejected", { requestId: request.requestId });
        throw new WebhookRejectedError("invalid or missing X-Plane-Signature");
      }

      const hash = deliveryHash(request.rawBody);

      // Kody: synchronous check+insert — two concurrent identical deliveries
      // cannot both pass this gate within one worker process.
      if (inFlight.has(hash)) {
        await recordSafely(deps, { requestId: request.requestId, outcome: "duplicate", detail: `in-flight ${hash}` });
        deps.log("plane webhook duplicate (in-flight) ignored", { requestId: request.requestId, hash });
        return;
      }
      inFlight.add(hash);

      try {
        // AC: duplicate deliveries (Plane CE #6848) are idempotent no-ops.
        if (await deps.isSeen(hash)) {
          await recordSafely(deps, { requestId: request.requestId, outcome: "duplicate", detail: hash });
          deps.log("plane webhook duplicate ignored", { requestId: request.requestId, hash });
          return;
        }

        // Distinguish invalid JSON from valid JSON that isn't a Plane event
        // (Kody suggestion): both are "ignored" but with different detail.
        let json: unknown;
        try {
          json = JSON.parse(request.rawBody);
        } catch {
          await recordSafely(deps, { requestId: request.requestId, outcome: "ignored", detail: "invalid JSON" });
          deps.log("plane webhook ignored: invalid JSON", { requestId: request.requestId });
          return;
        }
        const parsed = parsePlaneEvent(json);
        if (!parsed) {
          await recordSafely(deps, { requestId: request.requestId, outcome: "ignored", detail: "not a Plane event" });
          deps.log("plane webhook ignored: not a Plane event", { requestId: request.requestId });
          return;
        }

        // Codex P2: route FIRST, mark seen only on success — a failed route
        // leaves the delivery unseen so Plane's retry reprocesses it.
        try {
          await deps.routeEvent(parsed);
        } catch (error) {
          await recordSafely(deps, {
            requestId: request.requestId,
            outcome: "failed",
            detail: `routeEvent: ${String(error)}`,
          });
          deps.log("plane webhook routing failed (retryable)", { requestId: request.requestId, error: String(error) });
          throw error;
        }

        await deps.markSeen(hash);
        await recordSafely(deps, {
          requestId: request.requestId,
          outcome: "accepted",
          detail: `${parsed.event}.${parsed.action}`,
        });
        deps.log("plane webhook accepted", {
          requestId: request.requestId,
          event: parsed.event,
          action: parsed.action,
          entityId: parsed.entityId,
        });
      } finally {
        inFlight.delete(hash);
      }
    },
  };
}

/**
 * Bounded seen-store over plugin state (FIFO eviction).
 * Split into read (isSeen) and write (markSeen) so callers control WHEN a
 * delivery becomes "seen" (only after successful routing).
 */
export interface SeenStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function createSeenStore(store: SeenStore, stateKey = "seen-deliveries", capacity = 500) {
  return {
    async isSeen(hash: string): Promise<boolean> {
      const raw = await store.get(stateKey);
      const seen: string[] = Array.isArray(raw) ? (raw as string[]) : [];
      return seen.includes(hash);
    },
    async markSeen(hash: string): Promise<void> {
      const raw = await store.get(stateKey);
      const seen: string[] = Array.isArray(raw) ? (raw as string[]) : [];
      if (seen.includes(hash)) return;
      seen.push(hash);
      while (seen.length > capacity) seen.shift();
      await store.set(stateKey, seen);
    },
  };
}

/**
 * Bounded delivery-history store (Codex MUST_FIX #2): appends every outcome
 * to `webhook-deliveries` (capped) and mirrors the newest into `last-delivery`
 * for cheap status reads (PCLIP-8).
 */
export function createDeliveryRecorder(store: SeenStore, historyKey = "webhook-deliveries", capacity = 200) {
  return async function recordDelivery(entry: DeliveryRecord): Promise<void> {
    const stamped = { ...entry, at: new Date().toISOString() };
    const raw = await store.get(historyKey);
    const history: unknown[] = Array.isArray(raw) ? raw : [];
    history.push(stamped);
    while (history.length > capacity) history.shift();
    await store.set(historyKey, history);
    await store.set("last-delivery", stamped);
  };
}
