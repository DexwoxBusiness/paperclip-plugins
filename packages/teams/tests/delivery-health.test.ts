import { describe, expect, it } from "vitest";
import {
  createDeliveryHealth,
  fingerprintUrl,
  type DeliveryHealthStore,
} from "../src/delivery-health.js";

function makeStore(): DeliveryHealthStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

const ctx = (over: Partial<{ channel: string; eventType: string; status: number; error: string }> = {}) => ({
  channel: "pipeline",
  eventType: "issue-created",
  ...over,
});

describe("delivery health — degraded status (PCLIP-22 AC #3)", () => {
  const URL = "https://x.logic.azure.com/workflows/abc";

  it("fingerprint is stable, non-empty, and does not contain the raw URL", () => {
    const fp = fingerprintUrl(URL);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).toBe(fingerprintUrl(URL)); // stable
    expect(fp).not.toContain("logic.azure.com");
    expect(fingerprintUrl(URL)).not.toBe(fingerprintUrl(URL + "/other"));
  });

  it("trips to degraded only once the consecutive-failure threshold is crossed", async () => {
    const health = createDeliveryHealth(makeStore(), { threshold: 3, now: () => 1000 });
    let t = await health.record(URL, false, ctx({ status: 503, error: "503" }));
    expect(t).toMatchObject({ degraded: false, justTripped: false });
    t = await health.record(URL, false, ctx({ status: 503 }));
    expect(t.degraded).toBe(false);
    t = await health.record(URL, false, ctx({ status: 503 }));
    expect(t).toMatchObject({ degraded: true, justTripped: true }); // 3rd consecutive → trip
    // stays degraded without re-tripping
    t = await health.record(URL, false, ctx({ status: 503 }));
    expect(t).toMatchObject({ degraded: true, justTripped: false });
  });

  it("a success resets the streak and recovers a degraded URL (justRecovered once)", async () => {
    const health = createDeliveryHealth(makeStore(), { threshold: 2 });
    await health.record(URL, false, ctx());
    const tripped = await health.record(URL, false, ctx());
    expect(tripped.degraded).toBe(true);
    const recovered = await health.record(URL, true, ctx({ status: 202 }));
    expect(recovered).toMatchObject({ degraded: false, justRecovered: true });
    // subsequent success does not re-emit justRecovered
    const again = await health.record(URL, true, ctx({ status: 202 }));
    expect(again).toMatchObject({ degraded: false, justRecovered: false });
  });

  it("tracks distinct URLs independently and lists degraded first in the snapshot", async () => {
    const health = createDeliveryHealth(makeStore(), { threshold: 1, now: () => 5 });
    const A = "https://a.logic.azure.com/x";
    const B = "https://b.logic.azure.com/y";
    await health.record(A, false, ctx({ channel: "errors", status: 500 })); // degrades A
    await health.record(B, true, ctx({ channel: "digest", status: 202 })); // B healthy
    const snap = await health.snapshot();
    expect(snap.threshold).toBe(1);
    expect(snap.urls).toHaveLength(2);
    expect(snap.urls[0].degraded).toBe(true); // degraded sorted first
    expect(snap.urls[0].urlFingerprint).toBe(fingerprintUrl(A));
    expect(snap.urls[0].channels).toContain("errors");
  });

  it("accumulates channels seen on the same URL and never stores the raw URL", async () => {
    const store = makeStore();
    const health = createDeliveryHealth(store, { threshold: 10 });
    await health.record(URL, false, ctx({ channel: "pipeline", status: 500 }));
    await health.record(URL, false, ctx({ channel: "default", status: 500 }));
    const snap = await health.snapshot();
    expect(snap.urls[0].channels.sort()).toEqual(["default", "pipeline"]);
    expect(snap.urls[0].totalFailures).toBe(2);
    // the persisted blob must not leak the URL
    expect(JSON.stringify([...store.map.values()])).not.toContain("logic.azure.com");
  });

  it("serializes concurrent records without losing counts", async () => {
    const health = createDeliveryHealth(makeStore(), { threshold: 100 });
    await Promise.all(Array.from({ length: 20 }, () => health.record(URL, false, ctx({ status: 500 }))));
    const snap = await health.snapshot();
    expect(snap.urls[0].consecutiveFailures).toBe(20);
    expect(snap.urls[0].totalFailures).toBe(20);
  });

  it("recovers malformed persisted state to an empty map", async () => {
    const store = makeStore();
    store.map.set("delivery:health", { garbage: true, "0": 5 });
    const health = createDeliveryHealth(store);
    const snap = await health.snapshot();
    expect(snap.urls).toEqual([]);
  });
});
