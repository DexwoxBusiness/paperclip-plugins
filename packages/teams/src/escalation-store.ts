/**
 * Escalation store (PCLIP-28 / T11).
 *
 * Persists each escalation's record + the posted card reference (Bot Connector conversation
 * reference + activity id, so the timeout job can edit the exact card later), plus an OPEN
 * index the timeout sweep iterates. Keyed per escalation (`escalation:{id}`) with a single
 * `escalation:open-index` list — get/close are O(1); the index bounds the sweep to open items.
 *
 * SDK-decoupled over a tiny key/value backend so it is unit-tested. Mutations are serialized
 * per id through an in-process async lock (Codex): a single out-of-process worker per plugin is
 * the deployment model, but two card clicks / a click racing the timeout sweep can still
 * interleave at `await` points, so the lock makes the read-modify-write ATOMIC — only one caller
 * transitions an open escalation, which is what guarantees the reply-back never fires twice.
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
   * ATOMICALLY transition an OPEN escalation to a terminal status, record who/when, and drop it
   * from the open index. Returns the updated entry ONLY when it actually transitioned; null when
   * unknown OR already terminal. The single-transition guarantee (under the per-id lock) is what
   * makes the reply-back idempotent — a second click / a timeout race can never double-invoke.
   */
  close(id: string, status: Exclude<EscalationStatus, "open">, resolvedBy: string, atMs: number): Promise<EscalationEntry | null>;
  /**
   * Re-open an escalation that was just closed (used when the reply-back `ctx.agents.invoke`
   * FAILS after a click, so the human reply isn't lost — the card stays actionable and a retry
   * can re-claim). Re-adds it to the open index. No-op if it isn't currently terminal.
   */
  reopen(id: string): Promise<EscalationEntry | null>;
  /**
   * DEFER an open escalation at timeout (default action = "defer"): mark `deferredAtMs` but keep
   * it OPEN and in the index. The sweep skips already-deferred records (see `expiredEscalations`)
   * so it isn't re-processed every tick, yet a human can still click to resolve it later.
   */
  defer(id: string, atMs: number): Promise<EscalationEntry | null>;
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

/**
 * Per-id async lock shared across ALL store instances in this worker (module scope), so the
 * setup() store and the getBot() store serialize against each other. Chains each id's operations
 * onto a promise so a read-modify-write can't interleave with another for the same id.
 */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain but don't leak rejections into the next caller's scheduling.
  locks.set(id, next.then(() => undefined, () => undefined));
  return next;
}

export function createEscalationStore(backend: EscalationStoreBackend, opts: { now?: () => number } = {}): EscalationStore {
  const now = opts.now ?? Date.now;
  const store: EscalationStore = {
    async create(record) {
      if (!record?.id) return;
      await withLock(record.id, async () => {
        await backend.set(escalationStateKey(record.id), { record, updatedAtMs: now() } satisfies EscalationEntry);
        const index = await readIndex(backend);
        if (!index.includes(record.id)) await backend.set(ESCALATION_INDEX_KEY, [...index, record.id]);
      });
    },
    async get(id) {
      if (!id) return null;
      return coerceEntry(await backend.get(escalationStateKey(id)));
    },
    async attachCard(id, ref) {
      if (!id) return;
      await withLock(id, async () => {
        const entry = await store.get(id);
        if (!entry) return;
        await backend.set(escalationStateKey(id), {
          ...entry,
          conversationReference: ref.conversationReference,
          activityId: ref.activityId,
          updatedAtMs: now(),
        } satisfies EscalationEntry);
      });
    },
    async close(id, status, resolvedBy, atMs) {
      if (!id) return null;
      return withLock(id, async () => {
        const entry = await store.get(id);
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
      });
    },
    async reopen(id) {
      if (!id) return null;
      return withLock(id, async () => {
        const entry = await store.get(id);
        if (!entry || entry.record.status === "open") return entry ?? null;
        const { resolvedAtMs, resolvedBy, ...rest } = entry.record;
        void resolvedAtMs;
        void resolvedBy;
        const updated: EscalationEntry = { ...entry, record: { ...rest, status: "open" }, updatedAtMs: now() };
        await backend.set(escalationStateKey(id), updated);
        const index = await readIndex(backend);
        if (!index.includes(id)) await backend.set(ESCALATION_INDEX_KEY, [...index, id]);
        return updated;
      });
    },
    async defer(id, atMs) {
      if (!id) return null;
      return withLock(id, async () => {
        const entry = await store.get(id);
        if (!entry || entry.record.status !== "open") return null;
        const updated: EscalationEntry = { ...entry, record: { ...entry.record, deferredAtMs: atMs }, updatedAtMs: now() };
        await backend.set(escalationStateKey(id), updated); // stays OPEN + indexed; sweep skips deferred
        return updated;
      });
    },
    async listOpen() {
      const index = await readIndex(backend);
      const entries = await Promise.all(index.map((id) => store.get(id)));
      return entries.filter((e): e is EscalationEntry => e != null && e.record.status === "open");
    },
  };
  return store;
}
