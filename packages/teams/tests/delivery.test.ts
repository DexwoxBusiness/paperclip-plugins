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
});
