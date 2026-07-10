/**
 * Channel-post ledger for ChatOS (T13).
 *
 * Persists each channel post + the posted card reference (so a later close can edit the exact card),
 * plus an OPEN index the agent can query. Unlike the ask ledger (one answer, then terminal), a
 * collecting channel post accumulates MANY responses — one per responder, keyed by `by` — and stays
 * OPEN until the agent explicitly closes it. Keyed per post (`chpost:{id}`) with one
 * `chpost:open-index` list.
 *
 * Concurrency model mirrors ask-store/escalation-store (including their critical-review fix):
 * mutations are serialized per id via an in-process async lock, and every open-index read-modify-write
 * goes through a SEPARATE shared index lock (the index is cross-id shared state). `recordResponse`
 * overwrites the caller's own prior entry (idempotent per person under a double-submit).
 */

import type { ChannelPost, ChannelResponse } from "./channel.js";

export interface ChannelPostEntry {
  post: ChannelPost;
  /** Bot Connector conversation reference of the posted card (opaque). */
  conversationReference?: unknown;
  /** The posted card's activity id (the card to edit on close). */
  activityId?: string;
  updatedAtMs: number;
}

export interface ChannelStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const CHANNEL_INDEX_KEY = "chpost:open-index";
export function channelStateKey(id: string): string {
  return `chpost:${id}`;
}

export interface ChannelStore {
  /** Persist a new OPEN post and add it to the open index. `ref` stores the card ref in the same write. */
  create(post: ChannelPost, ref?: { conversationReference: unknown; activityId: string }): Promise<void>;
  get(id: string): Promise<ChannelPostEntry | null>;
  /**
   * Record ONE responder's submit on an OPEN post (overwrites that person's prior entry — a re-submit
   * is last-write-wins, keeping the ledger idempotent per person). Returns the updated entry, or null
   * when the post is unknown or already closed (a submit to a closed round is a clean no-op).
   */
  recordResponse(id: string, response: ChannelResponse): Promise<ChannelPostEntry | null>;
  /**
   * Close an OPEN post (the agent is done collecting) and drop it from the open index. When `owner`
   * is supplied the close only applies if the post belongs to that agent+company (checked INSIDE the
   * lock, so a leaked id can't close another agent's post). Returns the updated entry or null.
   */
  close(id: string, atMs: number, owner?: { agentId: string; companyId: string }): Promise<ChannelPostEntry | null>;
  /** All still-open post entries for the caller's own re-post decisions (the plugin never nudges). */
  listOpen(): Promise<ChannelPostEntry[]>;
}

function coerceEntry(raw: unknown): ChannelPostEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<ChannelPostEntry>;
  const post = e.post as ChannelPost | undefined;
  if (!post || typeof post !== "object" || typeof post.id !== "string") return null;
  // Defensive: an older/partial record may lack `responses` — normalize to an object.
  if (!post.responses || typeof post.responses !== "object") post.responses = {};
  return {
    post,
    conversationReference: e.conversationReference,
    activityId: typeof e.activityId === "string" ? e.activityId : undefined,
    updatedAtMs: typeof e.updatedAtMs === "number" ? e.updatedAtMs : 0,
  };
}

async function readIndex(backend: ChannelStoreBackend): Promise<string[]> {
  const raw = await backend.get(CHANNEL_INDEX_KEY);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

// Per-id lock shared across all store instances in this worker (module scope). See ask-store.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.then(() => undefined, () => undefined));
  return next;
}

// The open-index is cross-id shared state — serialize EVERY index read-modify-write under one shared
// lock key, acquired inside the per-id lock (id-outer/index-inner, no deadlock).
const INDEX_LOCK_KEY = " chpost-open-index-lock";
function mutateIndex(backend: ChannelStoreBackend, transform: (index: string[]) => string[]): Promise<void> {
  return withLock(INDEX_LOCK_KEY, async () => {
    const index = await readIndex(backend);
    await backend.set(CHANNEL_INDEX_KEY, transform(index));
  });
}

export function createChannelStore(backend: ChannelStoreBackend, opts: { now?: () => number } = {}): ChannelStore {
  const now = opts.now ?? Date.now;
  const store: ChannelStore = {
    async create(post, ref) {
      if (!post?.id) return;
      await withLock(post.id, async () => {
        const entry: ChannelPostEntry = ref
          ? { post, conversationReference: ref.conversationReference, activityId: ref.activityId, updatedAtMs: now() }
          : { post, updatedAtMs: now() };
        await backend.set(channelStateKey(post.id), entry);
        await mutateIndex(backend, (index) => (index.includes(post.id) ? index : [...index, post.id]));
      });
    },
    async get(id) {
      if (!id) return null;
      return coerceEntry(await backend.get(channelStateKey(id)));
    },
    async recordResponse(id, response) {
      if (!id || !response?.by) return null;
      return withLock(id, async () => {
        const entry = await store.get(id);
        if (!entry || entry.post.status !== "open") return null;
        const responses = { ...entry.post.responses, [response.by]: response };
        const updated: ChannelPostEntry = { ...entry, post: { ...entry.post, responses }, updatedAtMs: now() };
        await backend.set(channelStateKey(id), updated);
        return updated;
      });
    },
    async close(id, atMs, owner) {
      if (!id) return null;
      return withLock(id, async () => {
        const entry = await store.get(id);
        if (!entry || entry.post.status !== "open") return null;
        if (owner && (entry.post.agentId !== owner.agentId || entry.post.companyId !== owner.companyId)) return null;
        const updated: ChannelPostEntry = { ...entry, post: { ...entry.post, status: "closed" }, updatedAtMs: atMs || now() };
        await backend.set(channelStateKey(id), updated);
        await mutateIndex(backend, (index) => index.filter((x) => x !== id));
        return updated;
      });
    },
    async listOpen() {
      const index = await readIndex(backend);
      const entries = await Promise.all(index.map((id) => store.get(id)));
      return entries.filter((e): e is ChannelPostEntry => e != null && e.post.status === "open");
    },
  };
  return store;
}
