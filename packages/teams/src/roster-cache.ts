/**
 * Short-TTL in-memory cache of a Teams channel's member roster.
 *
 * WHY: `TeamsBot.listChannelMembers` pages the WHOLE channel via `TeamsInfo.getPagedMembers`, so it
 * costs O(N) Teams API calls in the channel size. Resolving even one @-mention in `post_to_channel`
 * would otherwise re-page the entire channel on every post (Kody: high perf cost on large channels).
 * This memoizes the raw roster per `channelRef` for a short TTL, shared by `post_to_channel`'s mention
 * resolution and the `list_channel_members` tool.
 *
 * Coherent because Paperclip runs ONE out-of-process worker per plugin on a single node (documented
 * deployment model), so an in-process cache is the whole picture. The TTL bounds staleness: a
 * membership change propagates within `ttlMs`. Pure + injectable clock so it is unit-tested without
 * the SDK or a live channel.
 */

export interface RosterCache {
  /**
   * Return the cached roster for `key` when still fresh; otherwise call `fetch`, cache its result,
   * and return it. Concurrent cold-cache callers may each fetch once (no in-flight de-dupe) — an
   * acceptable, rare double-read for a low-frequency posting tool, never a correctness issue.
   */
  get(key: string, fetch: () => Promise<unknown>): Promise<unknown>;
  /** Forget a channel's cached roster (e.g. after a known membership change). */
  invalidate(key: string): void;
}

export function createRosterCache(opts: { ttlMs?: number; now?: () => number; maxEntries?: number } = {}): RosterCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  // A plugin posts to a small, bounded set of channels; the cap only guards against unbounded growth
  // if that assumption is ever violated (clear-all beats evicting per-entry LRU for a tiny cache).
  const maxEntries = opts.maxEntries ?? 500;
  const store = new Map<string, { at: number; members: unknown }>();

  return {
    async get(key, fetch) {
      const hit = store.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.members;
      const members = await fetch();
      if (store.size >= maxEntries && !store.has(key)) store.clear();
      store.set(key, { at: now(), members });
      return members;
    },
    invalidate(key) {
      store.delete(key);
    },
  };
}
