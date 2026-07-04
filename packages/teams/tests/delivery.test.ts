import { describe, expect, it, vi } from "vitest";
import { createWorkflowsClient, safeDeliver, type FetchLike } from "../src/delivery.js";
import { adaptiveCard, textBlock, toWorkflowsMessage } from "../src/adaptive-card.js";

const MSG = toWorkflowsMessage(adaptiveCard([textBlock("hi")]));
const okFetch = (status: number): FetchLike => async () => ({ status, text: async () => "" });

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
