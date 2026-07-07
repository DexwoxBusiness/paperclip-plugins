import { describe, expect, it } from "vitest";
import { ASK_INDEX_KEY, askStateKey, createAskStore, type AskStoreBackend } from "../src/ask-store.js";
import type { AskRequest } from "../src/ask.js";

function memoryBackend(): AskStoreBackend & { dump: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return { dump: m, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { if (v === null) m.delete(k); else m.set(k, v); } };
}
// Yields on every op so concurrent ops interleave — exposes a shared-index race if it exists.
function yieldingBackend(): AskStoreBackend & { dump: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return { dump: m, async get(k) { await Promise.resolve(); return m.has(k) ? m.get(k) : null; }, async set(k, v) { await Promise.resolve(); if (v === null) m.delete(k); else m.set(k, v); } };
}
function req(id: string, over: Partial<AskRequest> = {}): AskRequest {
  return { id, personRef: "p", agentId: "a", companyId: "c", prompt: "q", status: "open", createdAtMs: 0, ...over };
}

describe("createAskStore", () => {
  it("create indexes + retrievable; create(request, ref) stores the card ref in one write", async () => {
    const b = memoryBackend();
    const store = createAskStore(b, { now: () => 5 });
    await store.create(req("a1"), { conversationReference: { c: 1 }, activityId: "act-9" });
    expect(b.dump.get(ASK_INDEX_KEY)).toEqual(["a1"]);
    const got = await store.get("a1");
    expect(got?.activityId).toBe("act-9");
    expect(got?.conversationReference).toEqual({ c: 1 });
    expect(b.dump.has(askStateKey("a1"))).toBe(true);
  });

  it("answer transitions + deindexes + records response; second answer returns null (route once)", async () => {
    const b = memoryBackend();
    const store = createAskStore(b);
    await store.create(req("a1"));
    const answered = await store.answer("a1", { answer: "done" }, "teams:u", 99);
    expect(answered?.request).toMatchObject({ status: "answered", answeredBy: "teams:u", answeredAtMs: 99, response: { answer: "done" } });
    expect(b.dump.get(ASK_INDEX_KEY)).toEqual([]);
    expect(await store.answer("a1", { answer: "again" }, "teams:u2", 100)).toBeNull();
    expect((await store.get("a1"))?.request.response).toEqual({ answer: "done" });
  });

  it("ATOMIC: two overlapping answer() calls transition exactly once", async () => {
    const store = createAskStore(memoryBackend());
    await store.create(req("a1"));
    const [x, y] = await Promise.all([
      store.answer("a1", { answer: "x" }, "u1", 1),
      store.answer("a1", { answer: "y" }, "u2", 2),
    ]);
    expect([x, y].filter((r) => r !== null)).toHaveLength(1);
  });

  it("cancel closes an open ask; cancel/answer on unknown or terminal → null", async () => {
    const store = createAskStore(memoryBackend());
    await store.create(req("a1"));
    expect((await store.cancel("a1", 1))?.request.status).toBe("cancelled");
    expect(await store.cancel("a1", 2)).toBeNull(); // already terminal
    expect(await store.answer("nope", { answer: "z" }, "u", 1)).toBeNull();
  });

  it("cancel is ownership-scoped when owner is supplied (Codex P2)", async () => {
    const store = createAskStore(memoryBackend());
    await store.create(req("a1", { agentId: "agentA", companyId: "co1" }));
    // A different agent (or company) cannot cancel — returns null, ask stays open.
    expect(await store.cancel("a1", 1, { agentId: "agentB", companyId: "co1" })).toBeNull();
    expect(await store.cancel("a1", 1, { agentId: "agentA", companyId: "co2" })).toBeNull();
    expect((await store.get("a1"))?.request.status).toBe("open");
    // The owner can.
    expect((await store.cancel("a1", 2, { agentId: "agentA", companyId: "co1" }))?.request.status).toBe("cancelled");
  });

  it("listOpen returns only still-open asks", async () => {
    const store = createAskStore(memoryBackend());
    await store.create(req("a1"));
    await store.create(req("a2"));
    await store.create(req("a3"));
    await store.answer("a2", { answer: "d" }, "u", 1);
    await store.cancel("a3", 1);
    expect((await store.listOpen()).map((e) => e.request.id)).toEqual(["a1"]);
  });
});

describe("shared open-index concurrency (same class as the PCLIP-28 critical bug)", () => {
  it("concurrent answer() on DIFFERENT ids never leaves stale ids in the index", async () => {
    const b = yieldingBackend();
    const store = createAskStore(b);
    const ids = Array.from({ length: 25 }, (_, i) => `a${i}`);
    for (const id of ids) await store.create(req(id));
    await Promise.all(ids.map((id) => store.answer(id, { answer: "d" }, "u", 1)));
    expect(b.dump.get(ASK_INDEX_KEY)).toEqual([]);
    expect(await store.listOpen()).toHaveLength(0);
  });
  it("concurrent create() on different ids keeps every id", async () => {
    const b = yieldingBackend();
    const store = createAskStore(b);
    const ids = Array.from({ length: 25 }, (_, i) => `n${i}`);
    await Promise.all(ids.map((id) => store.create(req(id))));
    expect(([...(b.dump.get(ASK_INDEX_KEY) as string[])]).sort()).toEqual([...ids].sort());
  });
});
