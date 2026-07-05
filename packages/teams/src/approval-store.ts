/**
 * Approval card reference store (PCLIP-24 / T7).
 *
 * When an approval card is posted, we save WHERE it lives (the Bot Connector
 * conversation reference + the posted activity id) so that later — on the
 * `approval.decided` event — the worker can edit that exact card in place via
 * `adapter.updateActivity`. Mirrors the Discord plugin's `approval_{id}` state +
 * editMessage pattern.
 *
 * Keyed per approval (state key `approval:{approvalId}`), not a single blob — so
 * get/forget are O(1) and nothing accumulates unboundedly. SDK-decoupled over a tiny
 * key/value backend so the store is unit-tested.
 */

/** Minimal reference needed to edit the posted card later. */
export interface ApprovalCardRef {
  /** Bot Connector conversation reference (structural subset; opaque to us). */
  conversationReference: unknown;
  /** The id of the posted approval activity (the card to update). */
  activityId: string;
  /** Denormalized card fields so the decided/error card can be rebuilt without a re-fetch. */
  title?: string;
  requester?: string;
  issueIdentifier?: string;
  link?: string;
  updatedAt: number;
}

export interface ApprovalStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function approvalStateKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

export interface ApprovalStore {
  remember(approvalId: string, ref: Omit<ApprovalCardRef, "updatedAt">): Promise<void>;
  get(approvalId: string): Promise<ApprovalCardRef | null>;
  forget(approvalId: string): Promise<void>;
}

function coerce(raw: unknown): ApprovalCardRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ApprovalCardRef>;
  if (typeof r.activityId !== "string" || !r.activityId || r.conversationReference == null) return null;
  return {
    conversationReference: r.conversationReference,
    activityId: r.activityId,
    title: typeof r.title === "string" ? r.title : undefined,
    requester: typeof r.requester === "string" ? r.requester : undefined,
    issueIdentifier: typeof r.issueIdentifier === "string" ? r.issueIdentifier : undefined,
    link: typeof r.link === "string" ? r.link : undefined,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

export function createApprovalStore(backend: ApprovalStoreBackend, opts: { now?: () => number } = {}): ApprovalStore {
  const now = opts.now ?? Date.now;
  return {
    async remember(approvalId, ref) {
      if (!approvalId) return;
      await backend.set(approvalStateKey(approvalId), { ...ref, updatedAt: now() });
    },
    async get(approvalId) {
      if (!approvalId) return null;
      return coerce(await backend.get(approvalStateKey(approvalId)));
    },
    async forget(approvalId) {
      if (!approvalId) return;
      await backend.set(approvalStateKey(approvalId), null);
    },
  };
}
