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
  /** Teams routing hints, when present. `team.aadGroupId` is the team's AAD group id — required to
   * read the roster via Microsoft Graph (GET /teams/{aadGroupId}/members). Captured on inbound turns
   * (getConversationReference alone does NOT include channelData). */
  channelData?: TeamsChannelData;
  [k: string]: unknown;
}

/** The subset of Teams channelData we persist for routing + Graph roster reads. */
export type TeamsChannelData = { teamId?: string; channelId?: string; tenant?: { id?: string }; team?: { id?: string; aadGroupId?: string } };

/**
 * Enrich an inbound channelData with the team's AAD **group id** (the key the Graph roster read
 * needs), resolving it on the REAL inbound turn.
 *
 * WHY this exists: a channel *message* activity's `channelData` does NOT reliably carry
 * `team.aadGroupId` — only `conversationUpdate` does, and even then the typed `TeamInfo` omits it
 * (botframework-sdk#5870). The sanctioned way to obtain it is `TeamsInfo.getTeamDetails`, which makes
 * a Bot Connector HTTP call and therefore needs a live TurnContext. Doing it in the
 * `list_channel_members` tool path fails (a tool invocation has no TurnContext), which is exactly the
 * empty-roster symptom. So we resolve it here, on the inbound turn, and merge it into channelData so
 * the stored conversation reference carries it for the later proactive roster read.
 *
 * Pure + injectable (`fetchTeamAadGroupId`) so the branch logic is unit-tested without the SDK. Never
 * throws: a failed/blocked lookup leaves channelData unchanged (the next inbound turn retries).
 */
export async function resolveInboundChannelData(
  incomingCd: TeamsChannelData | undefined,
  fetchTeamAadGroupId: (teamId: string) => Promise<string | undefined>,
): Promise<TeamsChannelData | undefined> {
  const teamId = incomingCd?.team?.id?.trim();
  // Nothing to do when this isn't a team turn, or the group id is already present.
  if (!teamId || incomingCd?.team?.aadGroupId?.trim()) return incomingCd;
  let aadGroupId: string | undefined;
  try {
    aadGroupId = (await fetchTeamAadGroupId(teamId))?.trim() || undefined;
  } catch {
    aadGroupId = undefined; // leave channelData as-is; a later turn retries
  }
  return aadGroupId ? { ...incomingCd, team: { ...incomingCd.team, aadGroupId } } : incomingCd;
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

/**
 * True only for a 1:1 personal chat (Teams `conversationType === "personal"`). The generic store
 * remembers EVERY inbound reference — channels and group chats included — so a feature meant to DM
 * a specific person (PCLIP-43 ask) must gate on this before posting, or a reused/mistyped
 * conversation id could leak a private prompt into a channel (Codex P1). Missing/unknown type is
 * treated as NOT personal (fail closed).
 */
export function isPersonalConversationRef(ref: ConversationRef | undefined): boolean {
  return ref?.conversation?.conversationType === "personal";
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
  /**
   * Persist (or refresh) a reference. Returns the key, or null if the ref lacks a conversation id.
   *
   * Pass `merge` to compute the stored reference ATOMICALLY inside the lock from the EXISTING entry —
   * a read-modify-write with no lost-update race and no extra backend read (the blob is loaded once).
   * Used to preserve previously-captured channelData/team.aadGroupId when a later turn's channelData
   * is missing it. `merge(existing)` runs under the lock and returns the reference to store.
   */
  remember(reference: ConversationRef, merge?: (existing: StoredConversation | undefined) => ConversationRef): Promise<string | null>;
  get(key: string): Promise<StoredConversation | undefined>;
  list(): Promise<StoredConversation[]>;
  forget(key: string): Promise<void>;
}

/**
 * Persist conversation references for proactive messaging. `remember` is idempotent
 * per conversation id (a re-install / new activity just refreshes serviceUrl and the
 * timestamp), so we never accumulate duplicates for the same channel.
 *
 * Storage model (re: the "O(N) get()" review note): all references live in ONE state
 * blob under {@link CONVERSATIONS_KEY}. `get()` therefore parses that single blob — it
 * is NOT N backend round-trips. N here is the number of teams/channels the bot is
 * installed in (bounded and small — tens, not millions), so a single-blob read is
 * cheap and, more importantly, keeps `remember` a SINGLE atomic write. Splitting into
 * per-key entries + a separate index for `list()` would turn every write into two
 * writes (entry + index) with a partial-failure window between them — a data-
 * consistency hazard the engineering standard forbids without idempotent multi-write
 * handling. The single blob is the deliberate, safer choice at this scale.
 */
export function createConversationStore(backend: ConversationStoreBackend, opts: { now?: () => number } = {}): ConversationStore {
  const now = opts.now ?? Date.now;
  const lock = createLock();
  const load = async (): Promise<ConversationMap> => coerce(await backend.get(CONVERSATIONS_KEY));

  return {
    remember(reference, merge) {
      return lock(async () => {
        const key = conversationKey(reference);
        if (!key) return null;
        const map = await load();
        // `merge` sees the current entry and returns the ref to store — all within the lock, so
        // concurrent inbound turns can't clobber each other's channelData/team-id capture.
        const finalRef = merge ? merge(map[key]) : reference;
        map[key] = { key, reference: finalRef, updatedAt: now() };
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
