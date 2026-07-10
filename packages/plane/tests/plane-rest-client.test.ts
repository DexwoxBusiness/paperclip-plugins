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

// Verified against the Plane API docs: work-items resource, search returns
// `{ issues: [{ project__identifier, sequence_id }] }`, browse-form web URLs.
const router: Handler = (method, url) => {
  const path = url.split("?")[0];
  if (method === "GET" && /\/work-items\/search$/.test(path))
    return { status: 200, body: { issues: [{ id: "u1", name: "A", sequence_id: 1, project__identifier: "PCLIP", project_id: "p1" }] } };
  if (method === "GET" && /\/work-items\/PCLIP-12$/.test(path))
    return { status: 200, body: { id: "i12", project: "p1", sequence_id: 12, name: "Title", description_html: "<p>d</p>", state: "Todo", labels: ["l1"], comments: [{ id: "c1", comment_html: "<p>hi</p>" }] } };
  if (method === "GET" && /\/projects\/p1\/work-items$/.test(path))
    return {
      status: 200,
      body: {
        results: [
          { id: "w1", name: "One", description_html: "<p>1</p>", updated_at: "2026-07-04T10:00:00Z", labels: ["l1"], state: "s1" },
          { id: "w2", name: "Two", updated_at: "2026-07-04T09:00:00Z", labels: [], state: { id: "s2", name: "Done" } },
        ],
        next_cursor: "100:1:0",
        next_page_results: true,
      },
    };
  if (method === "POST" && /\/projects\/p1\/work-items$/.test(path))
    return { status: 201, body: { id: "new-id", project__identifier: "PCLIP", sequence_id: 99 } };
  if (method === "POST" && /\/projects\/p1\/work-items\/i12\/comments$/.test(path)) return { status: 201, body: { id: "cm1" } };
  if (method === "PATCH" && /\/projects\/p1\/work-items\/i12$/.test(path)) return { status: 200, body: {} };
  return { status: 404, body: {} };
};

describe("listProjectWorkItems (PCLIP-5 reconciliation paging)", () => {
  it("pages a project newest-first, mapping items + cursor", async () => {
    const h = makeClient(router);
    const page = await h.client.listProjectWorkItems({ projectId: "p1", perPage: 100, orderBy: "-updated_at" });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: "w1",
      name: "One",
      descriptionHtml: "<p>1</p>",
      updatedAt: "2026-07-04T10:00:00Z",
      labels: ["l1"],
      state: "s1",
    });
    // an expanded state object collapses to its id
    expect(page.items[1].state).toBe("s2");
    expect(page).toMatchObject({ hasMore: true, nextCursor: "100:1:0" });
    const url = h.calls[0].url;
    expect(url).toContain("order_by=-updated_at");
    expect(url).toContain("per_page=100");
  });

  it("reports no next page when the server flags none (bounded paging)", async () => {
    const h = makeClient((method, url) => {
      const path = url.split("?")[0];
      if (method === "GET" && /\/projects\/p1\/work-items$/.test(path))
        return { status: 200, body: { results: [{ id: "w1", name: "x", updated_at: "2026-07-04T10:00:00Z" }], next_page_results: false } };
      return { status: 404, body: {} };
    });
    const page = await h.client.listProjectWorkItems({ projectId: "p1" });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    // defensive parsing of a sparse item
    expect(page.items[0]).toMatchObject({ id: "w1", labels: [], descriptionHtml: "", state: "" });
  });

  it("clamps per_page to the Plane maximum of 100", async () => {
    const h = makeClient(router);
    await h.client.listProjectWorkItems({ projectId: "p1", perPage: 500 });
    expect(h.calls[0].url).toContain("per_page=100");
  });

  it("surfaces a rate-limit as a PlaneApiError (reconciliation backs off)", async () => {
    const h = makeClient((method, url) => {
      const path = url.split("?")[0];
      if (method === "GET" && /\/projects\/p1\/work-items$/.test(path))
        return { status: 429, headers: { "retry-after": "30" }, body: {} };
      return { status: 404, body: {} };
    });
    await expect(h.client.listProjectWorkItems({ projectId: "p1" })).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
    });
  });
});

describe("createPlaneRestClient — auth & security (AC #2)", () => {
  it("sends the resolved key as X-API-Key and resolves it per call", async () => {
    const h = makeClient(router);
    await h.client.getWorkItem("PCLIP-12");
    expect(h.calls[0].headers["X-API-Key"]).toBe("plane_api_secret-key");
    await h.client.getWorkItem("PCLIP-12");
    expect(h.resolveCount()).toBeGreaterThanOrEqual(2); // resolved again, not cached
  });

  it("fails as unauthorized when no key resolves", async () => {
    const h = makeClient(router, { getApiKey: async () => "" });
    await expect(h.client.getWorkItem("PCLIP-1")).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("never includes the API key in a PlaneApiError message", async () => {
    const h = makeClient(() => ({ status: 500, body: "server error mentioning plane_api_secret-key?" }));
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

describe("createPlaneRestClient — work-items mappings & URLs", () => {
  it("gets a work item via the work-items route and maps the domain shape", async () => {
    const h = makeClient(router);
    const wi = await h.client.getWorkItem("PCLIP-12");
    expect(h.calls[0].url).toContain("/work-items/PCLIP-12");
    expect(wi).toMatchObject({ id: "i12", identifier: "PCLIP-12", name: "Title", state: "Todo" });
    expect(wi.labels).toEqual(["l1"]);
    expect(wi.comments[0]).toMatchObject({ id: "c1", bodyHtml: "<p>hi</p>" });
    expect(wi.url).toBe("https://plane.example.com/acme/browse/PCLIP-12/");
  });

  it("searches via work-items/search, parses the `issues` array + project__identifier, and does NO per-hit project lookup (Kody perf)", async () => {
    const h = makeClient(router);
    const res = await h.client.searchWorkItems({ text: "auth" });
    expect(h.calls[0].url).toContain("/work-items/search?");
    expect(h.calls[0].url).toContain("search=auth");
    // The Plane search endpoint returns id/name/sequence_id/project__identifier
    // (no state), so the summary's readable id is built without any extra call.
    expect(res.items[0]).toMatchObject({ id: "u1", identifier: "PCLIP-1", name: "A" });
    expect(res.items[0].url).toBe("https://plane.example.com/acme/browse/PCLIP-1/");
    // No extra GET projects/... call was made to build the readable id.
    expect(h.calls.every((c) => !/\/projects\//.test(c.url))).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it("returns no results for an empty search (endpoint requires `search`)", async () => {
    const h = makeClient(router);
    expect(await h.client.searchWorkItems({})).toEqual({ items: [] });
  });

  it("creates via projects/{id}/work-items and returns identifier + browse URL", async () => {
    const h = makeClient(router);
    const res = await h.client.createWorkItem({ projectId: "p1", name: "New" });
    expect(res).toMatchObject({ id: "new-id", identifier: "PCLIP-99" });
    expect(res.url).toBe("https://plane.example.com/acme/browse/PCLIP-99/");
  });

  it("comments via projects/{id}/work-items/{id}/comments", async () => {
    const h = makeClient(router);
    const res = await h.client.addComment("PCLIP-12", "<p>done</p>");
    expect(h.calls.some((c) => c.method === "POST" && /\/projects\/p1\/work-items\/i12\/comments$/.test(c.url.split("?")[0]))).toBe(true);
    expect(res.url).toContain("/browse/PCLIP-12/#comment-cm1");
  });

  it("updates state via PATCH projects/{id}/work-items/{id}", async () => {
    const h = makeClient(router);
    const res = await h.client.updateState("PCLIP-12", "Done");
    expect(h.calls.some((c) => c.method === "PATCH" && /\/projects\/p1\/work-items\/i12$/.test(c.url.split("?")[0]))).toBe(true);
    expect(res).toMatchObject({ id: "i12", identifier: "PCLIP-12", state: "Done" });
  });
});

describe("createPlaneRestClient — members & assignees", () => {
  it("lists workspace members from the bare array; lowercases email; display_name→first+last fallback", async () => {
    const h = makeClient((_m, url) =>
      /\/members$/.test(url.split("?")[0])
        ? {
            status: 200,
            body: [
              { id: "m1", first_name: "Diwakar", last_name: "M", display_name: "DMA", email: "Diwakar.MA@Dexwox.com", role: 20 },
              { id: "m2", first_name: "Ferin", last_name: "C", email: "ferin.c@dexwox.com", role: 15 },
            ],
          }
        : { status: 404, body: {} },
    );
    const members = await h.client.listMembers();
    expect(h.calls[0].url).toContain("/workspaces/acme/members");
    expect(members).toEqual([
      { id: "m1", name: "DMA", email: "diwakar.ma@dexwox.com", role: 20 },
      { id: "m2", name: "Ferin C", email: "ferin.c@dexwox.com", role: 15 },
    ]);
  });

  it("lists project members from the project path, resolving a nested `member` + top-level role", async () => {
    const h = makeClient((_m, url) =>
      /\/projects\/p1\/members$/.test(url.split("?")[0])
        ? { status: 200, body: [{ member: { id: "m3", display_name: "Karthik", email: "K@X.com" }, role: 15 }] }
        : { status: 404, body: {} },
    );
    const members = await h.client.listMembers("p1");
    expect(h.calls[0].url).toContain("/projects/p1/members");
    expect(members).toEqual([{ id: "m3", name: "Karthik", email: "k@x.com", role: 15 }]);
  });

  it("expands assignees on get_work_item and maps expanded objects + bare-uuid entries", async () => {
    const h = makeClient((_m, url) =>
      /\/work-items\/PCLIP-12/.test(url.split("?")[0])
        ? {
            status: 200,
            body: {
              id: "i12", name: "T", sequence_id: 12, project__identifier: "PCLIP", state: "Todo", labels: [], comments: [],
              assignees: [{ id: "usr-1", display_name: "Alice", email: "Alice@X.com" }, "usr-2"],
            },
          }
        : { status: 404, body: {} },
    );
    const wi = await h.client.getWorkItem("PCLIP-12");
    expect(decodeURIComponent(h.calls[0].url)).toContain("expand=labels,state,comments,assignees");
    expect(wi.assignees).toEqual([
      { id: "usr-1", name: "Alice", email: "alice@x.com" },
      { id: "usr-2", name: "", email: "" },
    ]);
  });

  it("lists project work items with assignees expanded and filters by assigneeId client-side", async () => {
    const h = makeClient((_m, url) => {
      const path = url.split("?")[0];
      if (/\/projects\/p1$/.test(path)) return { status: 200, body: { identifier: "PCLIP" } };
      if (/\/projects\/p1\/work-items$/.test(path)) {
        return {
          status: 200,
          body: {
            results: [
              { id: "i1", sequence_id: 1, name: "A", state: { name: "In Progress" }, assignees: [{ id: "usr-1", display_name: "Alice", email: "a@x.com" }] },
              { id: "i2", sequence_id: 2, name: "B", state: { name: "Todo" }, assignees: [{ id: "usr-2", display_name: "Bob", email: "b@x.com" }] },
            ],
            next_page_results: false,
          },
        };
      }
      return { status: 404, body: {} };
    });
    const all = await h.client.listWorkItems({ projectId: "p1" });
    expect(all.items.map((i) => i.identifier)).toEqual(["PCLIP-1", "PCLIP-2"]);
    expect(all.items[0]).toMatchObject({ state: "In Progress", url: "https://plane.example.com/acme/browse/PCLIP-1/" });
    expect(all.items[0].assignees).toEqual([{ id: "usr-1", name: "Alice", email: "a@x.com" }]);
    const mine = await h.client.listWorkItems({ projectId: "p1", assigneeId: "usr-2" });
    expect(mine.items.map((i) => i.id)).toEqual(["i2"]);
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

describe("secret-ref kill-switch guard (PAP-2394 / pinned build)", () => {
  it("turns a secret-resolution failure into an unavailable error with a pin hint", async () => {
    const h = makeClient(router, { getApiKey: async () => { throw new Error("plugin secret-refs disabled"); } });
    await h.client.getWorkItem("PCLIP-1").then(
      () => { throw new Error("should have thrown"); },
      (e: PlaneApiError) => {
        expect(e.kind).toBe("unavailable");
        expect(e.message).toMatch(/pinned Paperclip build|PAP-2394|secret-ref/i);
      },
    );
  });

  it("testConnection surfaces the pin hint when the secret-ref cannot resolve", async () => {
    const h = makeClient(() => ({ status: 200, body: {} }), { getApiKey: async () => { throw new Error("no secrets"); } });
    const res = await h.client.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/pinned Paperclip build|PAP-2394/i);
  });
});
