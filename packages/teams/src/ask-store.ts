/**
 * Ask request/response ledger (PCLIP-43 / T12).
 *
 * Persists each outstanding ask + the posted card reference (so the answer path / a future cancel
 * can edit the exact card), plus an OPEN index the agent can query (it — not the plugin — decides
 * on re-prompting). Keyed per request (`ask:{id}`) with a single `ask:open-index` list.
 *
 * Concurrency model is identical to the escalation store (PCLIP-28), including the fix from its
 * critical review: mutations are serialized per id through an in-process async lock, AND every
 * open-index read-modify-write goes through a SEPARATE shared index lock — the index is cross-id
 * shared state, so the per-id lock alone would let concurrent ops on different ids clobber it.
 * `answer()` transitions an OPEN request exactly once, which is what makes the route-back idempotent.
 */

import type { AskRequest } from "./ask.js";

export interface AskEntry {
  request: AskRequest;
  /** Bot Connector conversation reference of the posted card (opaque). */
  conversationReference?: unknown;
  /** The posted card's activity id (the card to edit on answer/cancel). */
  activityId?: string;
  updatedAtMs: number;
}

export interface AskStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const ASK_INDEX_KEY = "ask:open-index";
export function askStateKey(id: string): string {
  return `ask:${id}`;
}

export interface AskStore {
  /**
   * Persist a new OPEN ask and add it to the open index. Pass `ref` to store the posted card's
   * conversation reference + activity id in the SAME write (the tool posts before creating, so the
   * ref is known) — avoids a create()+attach two-write window that could orphan the card ref.
   */
  create(request: AskRequest, ref?: { conversationReference: unknown; activityId: string }): Promise<void>;
  get(id: string): Promise<AskEntry | null>;
  /**
   * ATOMICALLY transition an OPEN ask to `answered`, recording who/when/response, and drop it from
   * the open index. Returns the updated entry ONLY when it actually transitioned; null when unknown
   * or already terminal — the single-transition guarantee is what makes the agent route-back fire
   * exactly once under a double-submit race.
   */
  answer(id: string, response: Record<string, string>, answeredBy: string, atMs: number): Promise<AskEntry | null>;
  /** Cancel an OPEN ask (agent no longer needs it). Returns the updated entry or null if not open. */
  cancel(id: string, atMs: number): Promise<AskEntry | null>;
  /** All still-open ask entries (for the agent's own re-prompt decisions; the plugin never nudges). */
  listOpen(): Promise<AskEntry[]>;
}

function coerceEntry(raw: unknown): AskEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<AskEntry>;
  if (!e.request || typeof e.request !== "object" || typeof (e.request as AskRequest).id !== "string") return null;
  return {
    request: e.request as AskRequest,
    conversationReference: e.conversationReference,
    activityId: typeof e.activityId === "string" ? e.activityId : undefined,
    updatedAtMs: typeof e.updatedAtMs === "number" ? e.updatedAtMs : 0,
  };
}

async function readIndex(backend: AskStoreBackend): Promise<string[]> {
  const raw = await backend.get(ASK_INDEX_KEY);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

// Per-id lock shared across all store instances in this worker (module scope). See escalation-store.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.then(() => undefined, () => undefined));
  return next;
}

// The open-index is cross-id shared state, so serialize EVERY index read-modify-write under one
// shared lock key (acquired inside the per-id lock — id-outer/index-inner, no deadlock). Without
// this, concurrent create/answer on different ids interleave on the same read and drop mutations.
const INDEX_LOCK_KEY = " ask-open-index-lock";
function mutateIndex(backend: AskStoreBackend, transform: (index: string[]) => string[]): Promise<void> {
  return withLock(INDEX_LOCK_KEY, async () => {
    const index = await readIndex(backend);
    await backend.set(ASK_INDEX_KEY, transform(index));
  });
}

export function createAskStore(backend: AskStoreBackend, opts: { now?: () => number } = {}): AskStore {
  const now = opts.now ?? Date.now;
  const store: AskStore = {
    async create(request, ref) {
      if (!request?.id) return;
      await withLock(request.id, async () => {
        const entry: AskEntry = ref
          ? { request, conversationReference: ref.conversationReference, activityId: ref.activityId, updatedAtMs: now() }
          : { request, updatedAtMs: now() };
        await backend.set(askStateKey(request.id), entry);
        await mutateIndex(backend, (index) => (index.includes(request.id) ? index : [...index, request.id]));
      });
    },
    async get(id) {
      if (!id) return null;
      return coerceEntry(await backend.get(askStateKey(id)));
    },
    async answer(id, response, answeredBy, atMs) {
      if (!id) return null;
      return withLock(id, async () => {
        const entry = await store.get(id);
        if (!entry || entry.request.status !== "open") return null;
        const updated: AskEntry = {
          ...entry,
          request: { ...entry.request, status: "answered", answeredAtMs: atMs, answeredBy, response },
          updatedAtMs: now(),
        };
        await backend.set(askStateKey(id), updated);
        await mutateIndex(backend, (index) => index.filter((x) => x !== id));
        return updated;
      });
    },
    async cancel(id, atMs) {
      if (!id) return null;
      return withLock(id, async () => {
        const entry = await store.get(id);
        if (!entry || entry.request.status !== "open") return null;
        const updated: AskEntry = {
          ...entry,
          request: { ...entry.request, status: "cancelled", answeredAtMs: atMs },
          updatedAtMs: now(),
        };
        await backend.set(askStateKey(id), updated);
        await mutateIndex(backend, (index) => index.filter((x) => x !== id));
        return updated;
      });
    },
    async listOpen() {
      const index = await readIndex(backend);
      const entries = await Promise.all(index.map((id) => store.get(id)));
      return entries.filter((e): e is AskEntry => e != null && e.request.status === "open");
    },
  };
  return store;
}
