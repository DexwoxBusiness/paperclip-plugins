import { createHash } from "node:crypto";
import { parsePlaneEvent, type ParsedPlaneEvent } from "./plane-events.js";
import { extractPlaneSignature, verifyPlaneSignature } from "./signature.js";

export type { ParsedPlaneEvent } from "./plane-events.js";

/**
 * Core webhook handling logic for PCLIP-1, decoupled from the SDK runtime so
 * every acceptance criterion is unit-testable:
 *  - valid signature  -> accepted, routed
 *  - missing/invalid  -> WebhookRejectedError (body never parsed), attempt logged
 *  - duplicate body   -> idempotent no-op (Plane CE bug #6848)
 *  - every delivery   -> recorded via deps.recordDelivery
 */

export class WebhookRejectedError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "WebhookRejectedError";
  }
}

export interface WebhookHandlerDeps {
  /** Webhook HMAC secret from plugin config. */
  getSecret(): Promise<string>;
  /** Returns true if this delivery hash was already processed; must also mark it seen. */
  checkAndMarkSeen(deliveryHash: string): Promise<boolean>;
  /** Record delivery outcome for observability (PCLIP-8 feeds off this). */
  recordDelivery(entry: { requestId: string; outcome: "accepted" | "rejected" | "duplicate" | "ignored"; detail?: string }): Promise<void>;
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

export async function handlePlaneWebhook(request: WebhookRequest, deps: WebhookHandlerDeps): Promise<void> {
  const secret = await deps.getSecret();
  const signature = extractPlaneSignature(request.headers);

  // AC: invalid/missing signature -> reject 401, log, never process the body.
  if (!verifyPlaneSignature(request.rawBody, signature, secret)) {
    await deps.recordDelivery({
      requestId: request.requestId,
      outcome: "rejected",
      detail: signature ? "invalid signature" : "missing signature",
    });
    deps.log("plane webhook rejected", { requestId: request.requestId });
    throw new WebhookRejectedError("invalid or missing X-Plane-Signature");
  }

  // AC: duplicate deliveries (Plane CE #6848) are idempotent no-ops.
  const hash = deliveryHash(request.rawBody);
  if (await deps.checkAndMarkSeen(hash)) {
    await deps.recordDelivery({ requestId: request.requestId, outcome: "duplicate", detail: hash });
    deps.log("plane webhook duplicate ignored", { requestId: request.requestId, hash });
    return;
  }

  let parsed: ParsedPlaneEvent | null = null;
  try {
    parsed = parsePlaneEvent(JSON.parse(request.rawBody));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    await deps.recordDelivery({ requestId: request.requestId, outcome: "ignored", detail: "unparseable payload" });
    deps.log("plane webhook ignored: unparseable", { requestId: request.requestId });
    return;
  }

  await deps.routeEvent(parsed);
  await deps.recordDelivery({ requestId: request.requestId, outcome: "accepted", detail: `${parsed.event}.${parsed.action}` });
  deps.log("plane webhook accepted", {
    requestId: request.requestId,
    event: parsed.event,
    action: parsed.action,
    entityId: parsed.entityId,
  });
}

/**
 * Bounded seen-set over plugin state for delivery dedupe.
 * Keeps the most recent `capacity` hashes (FIFO eviction).
 */
export interface SeenStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function createSeenChecker(store: SeenStore, stateKey = "seen-deliveries", capacity = 500) {
  return async function checkAndMarkSeen(hash: string): Promise<boolean> {
    const raw = await store.get(stateKey);
    const seen: string[] = Array.isArray(raw) ? (raw as string[]) : [];
    if (seen.includes(hash)) return true;
    seen.push(hash);
    while (seen.length > capacity) seen.shift();
    await store.set(stateKey, seen);
    return false;
  };
}
