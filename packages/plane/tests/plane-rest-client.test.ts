import { describe, expect, it } from "vitest";
import { createPlaneRestClient, type FetchLike, type FetchResponseLike } from "../src/plane-rest-client.js";
import { PlaneApiError } from "../src/plane-client.js";

interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}
type Handler = (method: string, url: string, init: { headers: Record<string, string>; body?: string }) => StubResponse;

function makeFetch(handler: Handler) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const r = handler(init.method, url, init);
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) lower[k.toLowerCase()] = v;
    const res: FetchResponseLike = {
      status: r.status,
      headers: { get: (n) => lower[n.toLowerCase()] ?? null },
      text: async () => (r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
    return res;
  };
  return { fetchFn, calls };
}

function makeClient(handler: Handler, opts: { getApiKey?: () => Promise<string>; timeoutMs?: number; now?: () => number } = {}) {
  let resolveCount = 0;
  const getApiKey =
    opts.getApiKey ??
    (async () => {
      resolveCount++;
      return "plane_api_secret-key";
    });
  const { fetchFn, calls } = makeFetch(handler);
  const client = createPlaneRestClient({
    baseUrl: "https://plane.example.com/",
    workspaceSlug: "acme",
    getApiKey,
    fetchFn,
    timeoutMs: opts.timeoutMs ?? 5000,
    now: opts.now,
  });
  return { client, calls, resolveCount: () => resolveCount };
}

describe("createPlaneRestClient — auth & security (AC #2)", () => {
  it("sends the resolved key as X-API-Key and resolves it per call", async () => {
    const h = makeClient((_m, url) => (url.includes("/projects/") ? { status: 200, body: { identifier: "PCLIP" } } : { status: 200, body: { id: "i1", project: "p1", sequence_id: 12, name: "N" } }));
    await h.client.getWorkItem("PCLIP-12");
    expect(h.calls[0].headers["X-API-Key"]).toBe("plane_api_secret-key");
    await h.client.getWorkItem("PCLIP-13");
    expect(h.resolveCount()).toBeGreaterThanOrEqual(2); // resolved again, not cached
  });

  it("fails as unauthorized when no key resolves (never a silent call)", async () => {
    const h = makeClient(() => ({ status: 200, body: {} }), { getApiKey: async () => "" });
    await expect(h.client.getWorkItem("PCLIP-1")).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("never includes the API key in a PlaneApiError message", async () => {
    const h = makeClient(() => ({ status: 500, body: "server error with secret plane_api_secret-key leaked?" }));
    await h.client.getWorkItem("PCLIP-1").then(
      () => { throw new Error("should have thrown"); },
      (e: PlaneApiError) => {
        expect(e).toBeInstanceOf(PlaneApiError);
        expect(e.message).not.toContain("plane_api_secret-key");
      },
    );
  });
});

describe("createPlaneRestClient — status mapping (AC #4)", () => {
  const cases: Array<[number, string]> = [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [429, "rate_limited"],
    [400, "bad_request"],
    [503, "unavailable"],
  ];
  for (const [status, kind] of cases) {
    it(`maps HTTP ${status} to ${kind}`, async () => {
      const h = makeClient(() => ({ status, body: {} }));
      await expect(h.client.getWorkItem("PCLIP-1")).rejects.toMatchObject({ kind, status });
    });
  }

  it("parses Retry-After (seconds) on 429", async () => {
    const h = makeClient(() => ({ status: 429, headers: { "Retry-After": "30" }, body: {} }));
    await expect(h.client.getWorkItem("PCLIP-1")).rejects.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30 });
  });

  it("derives Retry-After from X-RateLimit-Reset when Retry-After is absent", async () => {
    const nowMs = 1_700_000_000_000;
    const resetEpoch = Math.floor(nowMs / 1000) + 12;
    const h = makeClient(() => ({ status: 429, headers: { "X-RateLimit-Reset": String(resetEpoch) }, body: {} }), { now: () => nowMs });
    await expect(h.client.getWorkItem("PCLIP-1")).rejects.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 12 });
  });
});

describe("createPlaneRestClient — timeout (AC #3)", () => {
  it("aborts a slow request and surfaces unavailable", async () => {
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const client = createPlaneRestClient({
      baseUrl: "https://plane.example.com",
      workspaceSlug: "acme",
      getApiKey: async () => "k",
      fetchFn,
      timeoutMs: 15,
    });
    await expect(client.getWorkItem("PCLIP-1")).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("createPlaneRestClient — mappings & URL", () => {
  const router: Handler = (method, url) => {
    if (method === "GET" && /\/projects\/p1$/.test(url.split("?")[0])) return { status: 200, body: { identifier: "PCLIP" } };
    if (method === "POST" && /\/projects\/p1\/issues$/.test(url.split("?")[0])) return { status: 201, body: { id: "new-id", project: "p1", sequence_id: 99 } };
    if (method === "GET" && /\/issues\/PCLIP-12$/.test(url.split("?")[0])) return { status: 200, body: { id: "i12", project: "p1", sequence_id: 12, name: "Title", description_html: "<p>d</p>", state: "Todo", labels: ["l1"], comments: [{ id: "c1", comment_html: "<p>hi</p>" }] } };
    return { status: 404, body: {} };
  };

  it("creates a work item and returns identifier + web URL", async () => {
    const h = makeClient(router);
    const res = await h.client.createWorkItem({ projectId: "p1", name: "New" });
    expect(res).toMatchObject({ id: "new-id", identifier: "PCLIP-99" });
    expect(res.url).toBe("https://plane.example.com/acme/projects/p1/issues/new-id");
  });

  it("maps a fetched work item to the domain shape with URL", async () => {
    const h = makeClient(router);
    const wi = await h.client.getWorkItem("PCLIP-12");
    expect(wi).toMatchObject({ id: "i12", identifier: "PCLIP-12", name: "Title", state: "Todo" });
    expect(wi.labels).toEqual(["l1"]);
    expect(wi.comments[0]).toMatchObject({ id: "c1", bodyHtml: "<p>hi</p>" });
    expect(wi.url).toContain("/acme/projects/p1/issues/i12");
  });
});

describe("createPlaneRestClient — testConnection (AC #3)", () => {
  it("returns ok on a successful authenticated read", async () => {
    const h = makeClient(() => ({ status: 200, body: { results: [] } }));
    expect(await h.client.testConnection()).toEqual({ ok: true });
  });

  it("returns a re-auth hint on 401", async () => {
    const h = makeClient(() => ({ status: 401, body: {} }));
    const res = await h.client.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/re-authenticate|API key/i);
  });
});
