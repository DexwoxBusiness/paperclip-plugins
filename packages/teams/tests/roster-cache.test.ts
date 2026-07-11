import { describe, expect, it, vi } from "vitest";
import { createRosterCache } from "../src/roster-cache.js";

describe("createRosterCache", () => {
  it("fetches once and serves the cached roster within the TTL", async () => {
    let clock = 1000;
    const cache = createRosterCache({ ttlMs: 60_000, now: () => clock });
    const fetch = vi.fn().mockResolvedValue([{ id: "29:a" }]);

    const a = await cache.get("ch1", fetch);
    clock += 59_000; // still inside the TTL
    const b = await cache.get("ch1", fetch);

    expect(a).toEqual([{ id: "29:a" }]);
    expect(b).toBe(a); // same cached reference
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    let clock = 0;
    const cache = createRosterCache({ ttlMs: 1000, now: () => clock });
    const fetch = vi.fn().mockResolvedValueOnce(["v1"]).mockResolvedValueOnce(["v2"]);

    expect(await cache.get("ch", fetch)).toEqual(["v1"]);
    clock += 1000; // TTL elapsed (>= ttlMs is stale)
    expect(await cache.get("ch", fetch)).toEqual(["v2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keys per channel — different channels don't share a roster", async () => {
    const cache = createRosterCache();
    const f1 = vi.fn().mockResolvedValue(["ch1"]);
    const f2 = vi.fn().mockResolvedValue(["ch2"]);
    expect(await cache.get("ch1", f1)).toEqual(["ch1"]);
    expect(await cache.get("ch2", f2)).toEqual(["ch2"]);
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces the next get to re-fetch", async () => {
    const cache = createRosterCache();
    const fetch = vi.fn().mockResolvedValueOnce(["old"]).mockResolvedValueOnce(["new"]);
    expect(await cache.get("ch", fetch)).toEqual(["old"]);
    cache.invalidate("ch");
    expect(await cache.get("ch", fetch)).toEqual(["new"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds memory: clears when exceeding maxEntries before caching a new channel", async () => {
    const cache = createRosterCache({ maxEntries: 2 });
    await cache.get("a", () => Promise.resolve("A"));
    await cache.get("b", () => Promise.resolve("B"));
    // third distinct channel trips the cap → store clears, then caches "c"
    const cFetch = vi.fn().mockResolvedValue("C");
    expect(await cache.get("c", cFetch)).toBe("C");
    // "a" was evicted by the clear, so it re-fetches
    const aFetch = vi.fn().mockResolvedValue("A2");
    expect(await cache.get("a", aFetch)).toBe("A2");
    expect(aFetch).toHaveBeenCalledTimes(1);
  });
});
