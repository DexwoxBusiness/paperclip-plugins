import { describe, expect, it, vi } from "vitest";
import {
  classifyRetried,
  createWorkflowsClient,
  deliverWithRetry,
  deliveryMetricPoints,
  safeDeliver,
  type FetchLike,
  type RetriedDelivery,
} from "../src/delivery.js";
import { adaptiveCard, textBlock, toWorkflowsMessage } from "../src/adaptive-card.js";

const MSG = toWorkflowsMessage(adaptiveCard([textBlock("hi")]));
const okFetch = (status: number): FetchLike => async () => ({ status, text: async () => "" });

/** A fetch that returns a preset sequence of statuses, one per call. */
function sequencedFetch(statuses: number[]): { fetchFn: FetchLike; calls: () => number } {
  let i = 0;
  return {
    calls: () => i,
    fetchFn: async () => {
      const status = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return { status, text: async () => "" };
    },
  };
}

/** No-op sleep + deterministic jitter (random()->0 => min 0.5x backoff) for retry tests. */
const noSleepPolicy = (extra: Record<string, unknown> = {}) => ({
  sleep: async () => undefined,
  random: () => 0,
  ...extra,
});

describe("workflows delivery (PCLIP-18)", () => {
  it("posts the envelope as JSON and returns ok on 2xx", async () => {
    const calls: Array<{ url: string; init: { method: string; body: string } }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { status: 202, text: async () => "" };
    };
    const out = await createWorkflowsClient({ fetchFn }).post("https://pa.example.com/hook", MSG);
    expect(out).toEqual({ ok: true, status: 202 });
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body).type).toBe("message");
  });

  it("classifies 429/5xx as transient (retry in T5) and 4xx as permanent", async () => {
    expect(await createWorkflowsClient({ fetchFn: okFetch(503) }).post("https://x/y", MSG)).toMatchObject({ ok: false, transient: true });
    expect(await createWorkflowsClient({ fetchFn: okFetch(429) }).post("https://x/y", MSG)).toMatchObject({ ok: false, transient: true });
    expect(await createWorkflowsClient({ fetchFn: okFetch(400) }).post("https://x/y", MSG)).toMatchObject({ ok: false, transient: false });
  });

  it("rejects a missing/invalid URL without calling fetch", async () => {
    const fetchFn = vi.fn();
    const out = await createWorkflowsClient({ fetchFn: fetchFn as unknown as FetchLike }).post("", MSG);
    expect(out.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("safeDeliver never throws even if the network call throws (AC #4 non-blocking)", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("network down");
    };
    const logs: string[] = [];
    const out = await safeDeliver(createWorkflowsClient({ fetchFn }), "https://x/y", MSG, (m) => logs.push(m));
    expect(out.ok).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("rejects a legacy O365 connector URL (retired May 2026) without posting", async () => {
    const fetchFn = vi.fn();
    const out = await createWorkflowsClient({ fetchFn: fetchFn as unknown as FetchLike }).post(
      "https://acme.webhook.office.com/webhookb2/abc",
      MSG,
    );
    expect(out).toMatchObject({ ok: false, transient: false });
    expect(String((out as { error?: string }).error)).toMatch(/O365 connector|Workflows/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts a hung request at the configured timeout — bounds the SLA (AC #1)", async () => {
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const out = await createWorkflowsClient({ fetchFn, timeoutMs: 20 }).post("https://x.logic.azure.com/y", MSG);
    expect(out).toMatchObject({ ok: false, transient: true });
    expect(String((out as { error?: string }).error)).toMatch(/timed out/i);
  });

  it("logs an SLA-exceeded warning when a successful delivery is slow (AC #1 observability)", async () => {
    let t = 1000;
    const now = () => t;
    const slowClient = {
      post: async () => {
        t += 50; // simulated latency, over the 10ms soft deadline below
        return { ok: true as const, status: 202 };
      },
    };
    const logs: string[] = [];
    const out = await safeDeliver(slowClient, "https://x/y", MSG, (m) => logs.push(m), {}, 10, now);
    expect(out.ok).toBe(true);
    expect(logs.some((l) => l.includes("exceeded SLA"))).toBe(true);
  });
});

describe("delivery retries with backoff (PCLIP-22 AC #1/#2)", () => {
  it("retries a transient 5xx and succeeds when the endpoint recovers (AC #1)", async () => {
    const { fetchFn, calls } = sequencedFetch([503, 503, 202]);
    const client = createWorkflowsClient({ fetchFn });
    const r = await deliverWithRetry(client, "https://x.logic.azure.com/y", MSG, () => {}, {}, noSleepPolicy());
    expect(r.outcome.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(r.retried).toBe(2);
    expect(calls()).toBe(3);
  });

  it("does NOT retry a permanent 4xx — one attempt only (AC #2)", async () => {
    const { fetchFn, calls } = sequencedFetch([400]);
    const client = createWorkflowsClient({ fetchFn });
    const r = await deliverWithRetry(client, "https://x.logic.azure.com/y", MSG, () => {}, {}, noSleepPolicy());
    expect(r.outcome).toMatchObject({ ok: false, transient: false });
    expect(r.attempts).toBe(1);
    expect(r.retried).toBe(0);
    expect(calls()).toBe(1);
  });

  it("caps retries at maxRetries when the endpoint stays down (bounded, AC #1)", async () => {
    const { fetchFn, calls } = sequencedFetch([503]);
    const client = createWorkflowsClient({ fetchFn });
    const r = await deliverWithRetry(client, "https://x.logic.azure.com/y", MSG, () => {}, {}, noSleepPolicy());
    expect(r.outcome).toMatchObject({ ok: false, transient: true });
    expect(r.attempts).toBe(4); // 1 initial + 3 retries
    expect(r.retried).toBe(3);
    expect(calls()).toBe(4);
  });

  it("backs off exponentially with jitter between retries", async () => {
    const { fetchFn } = sequencedFetch([503]);
    const client = createWorkflowsClient({ fetchFn });
    const delays: number[] = [];
    const policy = { sleep: async (ms: number) => void delays.push(ms), random: () => 0, baseDelayMs: 500, factor: 2 };
    await deliverWithRetry(client, "https://x.logic.azure.com/y", MSG, () => {}, {}, policy);
    // random()->0 => 0.5x of the ceiling 500, 1000, 2000
    expect(delays).toEqual([250, 500, 1000]);
  });

  it("does not retry an already-successful first attempt", async () => {
    const { fetchFn, calls } = sequencedFetch([202]);
    const client = createWorkflowsClient({ fetchFn });
    const r = await deliverWithRetry(client, "https://x.logic.azure.com/y", MSG, () => {}, {}, noSleepPolicy());
    expect(r).toMatchObject({ attempts: 1, retried: 0 });
    expect(r.outcome.ok).toBe(true);
    expect(calls()).toBe(1);
  });
});

describe("delivery metrics (PCLIP-22 AC #4)", () => {
  const meta = { eventType: "issue-created", channel: "pipeline" };
  const retried = (outcome: RetriedDelivery["outcome"], attempts: number): RetriedDelivery => ({
    outcome,
    attempts,
    retried: attempts - 1,
  });

  it("classifies success, transient-exhausted, and permanent outcomes", () => {
    expect(classifyRetried(retried({ ok: true, status: 202 }, 1))).toBe("success");
    expect(classifyRetried(retried({ ok: false, transient: true, error: "x" }, 4))).toBe("transient_exhausted");
    expect(classifyRetried(retried({ ok: false, transient: false, error: "x" }, 1))).toBe("permanent");
  });

  it("emits total+success tagged by event type and channel; retries only when retried>0", () => {
    const pts = deliveryMetricPoints(retried({ ok: true, status: 202 }, 3), meta);
    const total = pts.find((p) => p.name === "teams.delivery.total");
    expect(total).toMatchObject({ value: 1, tags: { event_type: "issue-created", channel: "pipeline", result: "success" } });
    expect(pts.find((p) => p.name === "teams.delivery.success")).toMatchObject({ value: 1 });
    expect(pts.find((p) => p.name === "teams.delivery.retries")).toMatchObject({ value: 2 });
    expect(pts.some((p) => p.name === "teams.delivery.failure")).toBe(false);
  });

  it("emits total+failure for a permanent failure and no retries point", () => {
    const pts = deliveryMetricPoints(retried({ ok: false, transient: false, error: "400" }, 1), meta);
    expect(pts.find((p) => p.name === "teams.delivery.total")?.tags.result).toBe("permanent");
    expect(pts.find((p) => p.name === "teams.delivery.failure")).toMatchObject({ value: 1 });
    expect(pts.some((p) => p.name === "teams.delivery.retries")).toBe(false);
    expect(pts.some((p) => p.name === "teams.delivery.success")).toBe(false);
  });
});
