/**
 * Escalation store (PCLIP-28 / T11).
 *
 * Persists each escalation's record + the posted card reference (Bot Connector conversation
 * reference + activity id, so the timeout job can edit the exact card later), plus an OPEN
 * index the timeout sweep iterates. Keyed per escalation (`escalation:{id}`) with a single
 * `escalation:open-index` list — get/close are O(1); the index bounds the sweep to open items.
 *
 * SDK-decoupled over a tiny key/value backend so it is unit-tested. Single out-of-process
 * worker per plugin (verified deployment model), so the index read-modify-write is race-free
 * within that boundary.
 */

import type { EscalationRecord, EscalationStatus } from "./escalation.js";

export interface EscalationEntry {
  record: EscalationRecord;
  /** Bot Connector conversation reference of the posted card (opaque). Set after posting. */
  conversationReference?: unknown;
  /** The posted card's activity id (the card to edit on resolve/timeout). */
  activityId?: string;
  updatedAtMs: number;
}

export interface EscalationStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const ESCALATION_INDEX_KEY = "escalation:open-index";
export function escalationStateKey(id: string): string {
  return `escalation:${id}`;
}

export interface EscalationStore {
  /** Persist a new OPEN escalation and add it to the open index. */
  create(record: EscalationRecord): Promise<void>;
  get(id: string): Promise<EscalationEntry | null>;
  /** Save the posted card's conversation reference + activity id (after the proactive post). */
  attachCard(id: string, ref: { conversationReference: unknown; activityId: string }): Promise<void>;
  /**
   * Transition an OPEN escalation to a terminal status, record who/when, and drop it from the
   * open index. Returns the updated entry ONLY when it actually transitioned; returns null when
   * the id is unknown OR already terminal. This single-transition guarantee is what makes the
   * reply-back idempotent — the caller invokes the agent only on a real transition, so a second
   * click / a timeout race can never double-invoke.
   */
  close(id: string, status: Exclude<EscalationStatus, "open">, resolvedBy: string, atMs: number): Promise<EscalationEntry | null>;
  /** All still-open escalation entries (for the timeout sweep). */
  listOpen(): Promise<EscalationEntry[]>;
}

function coerceEntry(raw: unknown): EscalationEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<EscalationEntry>;
  if (!e.record || typeof e.record !== "object" || typeof (e.record as EscalationRecord).id !== "string") return null;
  return {
    record: e.record as EscalationRecord,
    conversationReference: e.conversationReference,
    activityId: typeof e.activityId === "string" ? e.activityId : undefined,
    updatedAtMs: typeof e.updatedAtMs === "number" ? e.updatedAtMs : 0,
  };
}

async function readIndex(backend: EscalationStoreBackend): Promise<string[]> {
  const raw = await backend.get(ESCALATION_INDEX_KEY);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

export function createEscalationStore(backend: EscalationStoreBackend, opts: { now?: () => number } = {}): EscalationStore {
  const now = opts.now ?? Date.now;
  return {
    async create(record) {
      if (!record?.id) return;
      await backend.set(escalationStateKey(record.id), { record, updatedAtMs: now() } satisfies EscalationEntry);
      const index = await readIndex(backend);
      if (!index.includes(record.id)) await backend.set(ESCALATION_INDEX_KEY, [...index, record.id]);
    },
    async get(id) {
      if (!id) return null;
      return coerceEntry(await backend.get(escalationStateKey(id)));
    },
    async attachCard(id, ref) {
      const entry = await this.get(id);
      if (!entry) return;
      await backend.set(escalationStateKey(id), {
        ...entry,
        conversationReference: ref.conversationReference,
        activityId: ref.activityId,
        updatedAtMs: now(),
      } satisfies EscalationEntry);
    },
    async close(id, status, resolvedBy, atMs) {
      const entry = await this.get(id);
      // Only an OPEN escalation transitions; unknown or already-terminal → null (no double-apply).
      if (!entry || entry.record.status !== "open") return null;
      const updated: EscalationEntry = {
        ...entry,
        record: { ...entry.record, status, resolvedAtMs: atMs, resolvedBy },
        updatedAtMs: now(),
      };
      await backend.set(escalationStateKey(id), updated);
      const index = await readIndex(backend);
      await backend.set(ESCALATION_INDEX_KEY, index.filter((x) => x !== id));
      return updated;
    },
    async listOpen() {
      const index = await readIndex(backend);
      const entries = await Promise.all(index.map((id) => this.get(id)));
      return entries.filter((e): e is EscalationEntry => e != null && e.record.status === "open");
    },
  };
}
