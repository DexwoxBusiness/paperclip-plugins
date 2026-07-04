import { describe, expect, it } from "vitest";
import {
  createAgentTools,
  registerPlaneTools,
  type ToolRegistrar,
  type ToolResultShape,
} from "../src/agent-tools.js";
import { PlaneApiError, classifyStatus, type PlaneClientPort } from "../src/plane-client.js";
import { TOOL_NAMES } from "../src/constants.js";

function fakeClient(overrides: Partial<PlaneClientPort> = {}): PlaneClientPort {
  return {
    getWorkItem: async () => ({
      id: "uuid-1",
      identifier: "PCLIP-12",
      name: "Do the thing",
      descriptionHtml: "<p>Acceptance: <b>x</b></p>",
      state: "Todo",
      priority: "high",
      labels: ["agent"],
      comments: [{ id: "c1", bodyHtml: "<p>looks good</p>", author: "alice" }],
      url: "https://plane.example.com/w/PCLIP-12",
    }),
    searchWorkItems: async () => ({
      items: [{ id: "u1", identifier: "PCLIP-1", name: "A", state: "Todo", url: "https://plane.example.com/w/PCLIP-1" }],
      nextCursor: "next-page",
    }),
    createWorkItem: async () => ({ id: "u2", identifier: "PCLIP-99", url: "https://plane.example.com/w/PCLIP-99" }),
    addComment: async () => ({ id: "cm1", url: "https://plane.example.com/w/PCLIP-12#cm1" }),
    updateState: async (_id, state) => ({ id: "uuid-1", identifier: "PCLIP-12", state, url: "https://plane.example.com/w/PCLIP-12" }),
    ...overrides,
  };
}

const build = (c: PlaneClientPort) => createAgentTools(() => c);

describe("classifyStatus", () => {
  it("maps HTTP statuses to error kinds", () => {
    expect(classifyStatus(401)).toBe("unauthorized");
    expect(classifyStatus(403)).toBe("unauthorized");
    expect(classifyStatus(404)).toBe("not_found");
    expect(classifyStatus(429)).toBe("rate_limited");
    expect(classifyStatus(400)).toBe("bad_request");
    expect(classifyStatus(422)).toBe("bad_request");
    expect(classifyStatus(500)).toBe("unavailable");
    expect(classifyStatus(418)).toBe("unknown");
  });
});

describe("plane_get_work_item (AC #1)", () => {
  it("returns title, state, labels, description, comments and URL in one response", async () => {
    const t = build(fakeClient());
    const res = await t.getWorkItem({ id: "PCLIP-12" });
    expect(res.error).toBeUndefined();
    expect(res.content).toContain("PCLIP-12: Do the thing");
    expect(res.content).toContain("State: Todo");
    expect(res.content).toContain("Labels: agent");
    expect(res.content).toContain("https://plane.example.com/w/PCLIP-12");
    expect(res.content).toContain("Acceptance: x"); // HTML stripped, ACs preserved
    expect(res.content).toContain("alice: looks good");
    expect(res.data).toMatchObject({ identifier: "PCLIP-12", state: "Todo" });
  });

  it("rejects a missing id with a structured bad_request error (not a throw)", async () => {
    const t = build(fakeClient());
    const res = await t.getWorkItem({});
    expect(res.error).toMatch(/Invalid input: 'id' is required/);
    expect(res.data).toMatchObject({ kind: "bad_request" });
  });

  it("decodes HTML entities in the rendered description — no raw entities (Kody)", async () => {
    const t = build(
      fakeClient({
        getWorkItem: async () => ({
          id: "u",
          identifier: "PCLIP-7",
          name: "Entities",
          descriptionHtml: "&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; &amp;lt; &#39;q&#39; &#x2764;",
          state: "Todo",
          labels: [],
          comments: [],
          url: "https://plane.example.com/w/PCLIP-7",
        }),
      }),
    );
    const res = await t.getWorkItem({ id: "PCLIP-7" });
    expect(res.content).toContain('<script>alert("hi")</script>'); // &lt;/&gt;/&quot; decoded
    expect(res.content).toContain("& &lt; 'q' ❤"); // &amp;->& ; &amp;lt;->&lt; (no double-decode); numeric dec + hex
  });

  it("maps a 404 to a structured not_found error", async () => {
    const t = build(fakeClient({ getWorkItem: async () => { throw new PlaneApiError("not_found", 404, "nope"); } }));
    const res = await t.getWorkItem({ id: "PCLIP-999" });
    expect(res.error).toMatch(/not found/i);
    expect(res.error).toContain("HTTP 404");
    expect(res.data).toMatchObject({ kind: "not_found", status: 404 });
  });
});

describe("plane_search_work_items (AC #2)", () => {
  it("returns readable identifiers and signals pagination", async () => {
    const t = build(fakeClient());
    const res = await t.searchWorkItems({ query: "auth", state: "Todo" });
    expect(res.content).toContain("PCLIP-1 [Todo] A");
    expect(res.content).toContain("more available");
    expect(res.data).toMatchObject({ nextCursor: "next-page" });
  });

  it("handles an empty result set", async () => {
    const t = build(fakeClient({ searchWorkItems: async () => ({ items: [] }) }));
    const res = await t.searchWorkItems({ query: "nothing" });
    expect(res.error).toBeUndefined();
    expect(res.content).toContain("0 result(s)");
  });
});

describe("plane_create_work_item (AC #3)", () => {
  it("creates and returns the Plane URL", async () => {
    const t = build(fakeClient());
    const res = await t.createWorkItem({ projectId: "proj-1", name: "New item" });
    expect(res.content).toContain("Created PCLIP-99");
    expect(res.content).toContain("https://plane.example.com/w/PCLIP-99");
    expect(res.data).toMatchObject({ identifier: "PCLIP-99" });
  });

  it("rejects a missing name and an invalid priority with structured errors", async () => {
    const t = build(fakeClient());
    expect((await t.createWorkItem({ projectId: "p" })).data).toMatchObject({ kind: "bad_request" });
    const bad = await t.createWorkItem({ projectId: "p", name: "x", priority: "sky-high" });
    expect(bad.error).toMatch(/'priority' must be one of/);
  });

  it("maps a 401 to a structured unauthorized error", async () => {
    const t = build(fakeClient({ createWorkItem: async () => { throw new PlaneApiError("unauthorized", 401, "bad key"); } }));
    const res = await t.createWorkItem({ projectId: "p", name: "x" });
    expect(res.error).toMatch(/API key/i);
    expect(res.data).toMatchObject({ kind: "unauthorized", status: 401 });
  });
});

describe("plane_add_comment / plane_update_state (AC #3)", () => {
  it("adds a comment and returns its URL", async () => {
    const t = build(fakeClient());
    const res = await t.addComment({ id: "PCLIP-12", commentHtml: "<p>done</p>" });
    expect(res.content).toContain("Comment added:");
    expect(res.content).toContain("#cm1");
  });

  it("requires the comment body", async () => {
    const t = build(fakeClient());
    const res = await t.addComment({ id: "PCLIP-12" });
    expect(res.data).toMatchObject({ kind: "bad_request" });
  });

  it("updates state and echoes the target state + URL", async () => {
    const t = build(fakeClient());
    const res = await t.updateState({ id: "PCLIP-12", state: "In Progress" });
    expect(res.content).toContain('moved to "In Progress"');
    expect(res.data).toMatchObject({ state: "In Progress" });
  });

  it("surfaces a 429 rate limit with retry hint (AC #4)", async () => {
    const t = build(fakeClient({ updateState: async () => { throw new PlaneApiError("rate_limited", 429, "slow down", 30); } }));
    const res = await t.updateState({ id: "PCLIP-12", state: "Done" });
    expect(res.error).toMatch(/rate-limiting/i);
    expect(res.data).toMatchObject({ kind: "rate_limited", status: 429, retryAfterSeconds: 30 });
  });
});

describe("error hygiene (AC #4)", () => {
  it("never leaks a stack trace for an unexpected (non-PlaneApiError) throw", async () => {
    const t = build(fakeClient({ getWorkItem: async () => { throw new Error("boom at line 42\n  at foo"); } }));
    const res = await t.getWorkItem({ id: "PCLIP-1" });
    expect(res.error).toBe("Unexpected error executing the Plane tool.");
    expect(res.error).not.toContain("line 42");
    expect(res.data).toMatchObject({ kind: "unknown" });
  });
});

describe("5s SLA enforcement (AC #3)", () => {
  it("returns a structured unavailable error when a call exceeds the deadline", async () => {
    const hang = fakeClient({ updateState: (() => new Promise(() => {})) as PlaneClientPort["updateState"] });
    const tools = createAgentTools(() => hang, { timeoutMs: 20 });
    const res = await tools.updateState({ id: "PCLIP-1", state: "Done" });
    expect(res.data).toMatchObject({ kind: "unavailable" });
    expect(res.error).toMatch(/unavailable/i);
  });

  it("returns normally when the call is within the deadline", async () => {
    const tools = createAgentTools(() => fakeClient(), { timeoutMs: 50 });
    const res = await tools.updateState({ id: "PCLIP-1", state: "Done" });
    expect(res.error).toBeUndefined();
    expect(res.data).toMatchObject({ state: "Done" });
  });
});

describe("registerPlaneTools (register→invoke path, AC #5)", () => {
  const FAKE_DECLS = Object.values(TOOL_NAMES).map((name) => ({
    name,
    displayName: name,
    description: "d",
    parametersSchema: { type: "object" },
  }));

  it("registers all five tools and each is invocable through the registrar", async () => {
    const registered = new Map<string, (p: unknown) => Promise<ToolResultShape>>();
    const registrar: ToolRegistrar = { register: (name, _decl, fn) => void registered.set(name, fn) };
    registerPlaneTools(registrar, createAgentTools(() => fakeClient()), FAKE_DECLS, TOOL_NAMES);

    expect([...registered.keys()].sort()).toEqual(Object.values(TOOL_NAMES).slice().sort());
    const got = await registered.get(TOOL_NAMES.getWorkItem)!({ id: "PCLIP-12" });
    expect(got.content).toContain("PCLIP-12");
    const created = await registered.get(TOOL_NAMES.createWorkItem)!({ projectId: "p", name: "x" });
    expect(created.content).toContain("Created PCLIP-99");
  });

  it("invokes onMissing when a declaration is absent (fail-loud, not a silent skip)", () => {
    const registered: string[] = [];
    const missing: string[] = [];
    const registrar: ToolRegistrar = { register: (name) => void registered.push(name) };
    const partial = FAKE_DECLS.filter((d) => d.name !== TOOL_NAMES.addComment);
    registerPlaneTools(registrar, createAgentTools(() => fakeClient()), partial, TOOL_NAMES, (n) => missing.push(n));
    expect(registered).not.toContain(TOOL_NAMES.addComment);
    expect(missing).toEqual([TOOL_NAMES.addComment]);
  });
});
