/**
 * Proactive conversation-reference store (PCLIP-23 / T6, AC #1 "post proactively").
 *
 * The Agents SDK sends proactive messages with
 * `adapter.continueConversation(botAppId, reference, logic)` — which requires a
 * {@link ConversationRef} captured from an earlier inbound activity via
 * `TurnContext.getConversationReference(activity)`. This module persists those
 * references (keyed by conversation id) in plugin state so the bot can post to a
 * team/channel later, outside any inbound turn.
 *
 * SDK-decoupled: we store a minimal structural subset of the SDK's
 * ConversationReference (enough to round-trip to continueConversation) so the store
 * is unit-tested without the SDK. Serialized read-modify-write via an in-process lock
 * (valid for the single out-of-process worker).
 */

/** Minimal structural subset of the Agents SDK ConversationReference we persist. */
export interface ConversationRef {
  /** Channel id, e.g. "msteams". */
  channelId?: string;
  /** Bot Connector service URL used to send proactively (required by the SDK). */
  serviceUrl?: string;
  /** The conversation — its `id` is our storage key. */
  conversation?: { id?: string; conversationType?: string; name?: string; tenantId?: string };
  /** Teams routing hints, when present. */
  channelData?: { teamId?: string; channelId?: string; tenant?: { id?: string } };
  [k: string]: unknown;
}

/** A stored reference plus bookkeeping. */
export interface StoredConversation {
  key: string;
  reference: ConversationRef;
  updatedAt: number;
}

export interface ConversationStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const CONVERSATIONS_KEY = "bot:conversations";

/** Derive the stable storage key for a reference (the conversation id). */
export function conversationKey(ref: ConversationRef): string | null {
  const id = ref.conversation?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

type ConversationMap = Record<string, StoredConversation>;

function coerce(raw: unknown): ConversationMap {
  if (!raw || typeof raw !== "object") return {};
  const out: ConversationMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<StoredConversation> | null;
    if (!e || typeof e !== "object" || typeof e.key !== "string" || !e.reference || typeof e.reference !== "object") continue;
    out[k] = { key: e.key, reference: e.reference as ConversationRef, updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0 };
  }
  return out;
}

export interface ConversationStore {
  /** Persist (or refresh) a reference. Returns the key, or null if the ref lacks a conversation id. */
  remember(reference: ConversationRef): Promise<string | null>;
  get(key: string): Promise<StoredConversation | undefined>;
  list(): Promise<StoredConversation[]>;
  forget(key: string): Promise<void>;
}

/**
 * Persist conversation references for proactive messaging. `remember` is idempotent
 * per conversation id (a re-install / new activity just refreshes serviceUrl and the
 * timestamp), so we never accumulate duplicates for the same channel.
 */
export function createConversationStore(backend: ConversationStoreBackend, opts: { now?: () => number } = {}): ConversationStore {
  const now = opts.now ?? Date.now;
  const lock = createLock();
  const load = async (): Promise<ConversationMap> => coerce(await backend.get(CONVERSATIONS_KEY));

  return {
    remember(reference) {
      return lock(async () => {
        const key = conversationKey(reference);
        if (!key) return null;
        const map = await load();
        map[key] = { key, reference, updatedAt: now() };
        await backend.set(CONVERSATIONS_KEY, map);
        return key;
      });
    },
    async get(key) {
      return (await load())[key];
    },
    async list() {
      return Object.values(await load()).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    forget(key) {
      return lock(async () => {
        const map = await load();
        if (key in map) {
          delete map[key];
          await backend.set(CONVERSATIONS_KEY, map);
        }
      });
    },
  };
}
