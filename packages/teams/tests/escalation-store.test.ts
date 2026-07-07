import { describe, expect, it } from "vitest";
import { createEscalationStore, ESCALATION_INDEX_KEY, escalationStateKey, type EscalationStoreBackend } from "../src/escalation-store.js";
import type { EscalationRecord } from "../src/escalation.js";

function memoryBackend(): EscalationStoreBackend & { dump: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    dump: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { if (v === null) m.delete(k); else m.set(k, v); },
  };
}

function rec(id: string, over: Partial<EscalationRecord> = {}): EscalationRecord {
  return { id, agentId: "a", companyId: "c", reason: "help", status: "open", createdAtMs: 1000, ...over };
}

describe("createEscalationStore", () => {
  it("create indexes + retrievable; attachCard stores ref", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b, { now: () => 5 });
    await store.create(rec("e1"));
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual(["e1"]);
    await store.attachCard("e1", { conversationReference: { a: 1 }, activityId: "act-9" });
    const got = await store.get("e1");
    expect(got?.activityId).toBe("act-9");
    expect(got?.conversationReference).toEqual({ a: 1 });
    expect(b.dump.has(escalationStateKey("e1"))).toBe(true);
  });

  it("close transitions + deindexes; second close returns null (no double reply-back)", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b);
    await store.create(rec("e1"));
    const closed = await store.close("e1", "resolved", "teams:abc", 999);
    expect(closed?.record).toMatchObject({ status: "resolved", resolvedBy: "teams:abc", resolvedAtMs: 999 });
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual([]);
    expect(await store.close("e1", "dismissed", "teams:xyz", 1500)).toBeNull();
    expect((await store.get("e1"))?.record.status).toBe("resolved");
  });

  it("ATOMIC: two overlapping close() calls only transition once (Codex)", async () => {
    const store = createEscalationStore(memoryBackend());
    await store.create(rec("e1"));
    const [a, b] = await Promise.all([
      store.close("e1", "resolved", "u1", 1),
      store.close("e1", "dismissed", "u2", 2),
    ]);
    const winners = [a, b].filter((x) => x !== null);
    expect(winners).toHaveLength(1); // exactly one transition — no double-invoke
  });

  it("reopen: reverts a closed escalation to OPEN + reindexes (invoke-failure recovery)", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b);
    await store.create(rec("e1"));
    await store.close("e1", "resolved", "u", 1);
    const re = await store.reopen("e1");
    expect(re?.record.status).toBe("open");
    expect(re?.record.resolvedBy).toBeUndefined();
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual(["e1"]);
    // now a fresh close works again
    expect((await store.close("e1", "resolved", "u2", 3))?.record.status).toBe("resolved");
  });

  it("defer: marks deferredAtMs but keeps the escalation OPEN and indexed", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b);
    await store.create(rec("e1"));
    const d = await store.defer("e1", 777);
    expect(d?.record).toMatchObject({ status: "open", deferredAtMs: 777 });
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual(["e1"]); // still indexed
    // a human can still resolve a deferred escalation
    expect((await store.close("e1", "resolved", "u", 9))?.record.status).toBe("resolved");
  });

  it("close/reopen/defer on unknown id → null", async () => {
    const store = createEscalationStore(memoryBackend());
    expect(await store.close("nope", "resolved", "x", 1)).toBeNull();
    expect(await store.reopen("nope")).toBeNull();
    expect(await store.defer("nope", 1)).toBeNull();
  });

  it("listOpen returns only still-open entries", async () => {
    const store = createEscalationStore(memoryBackend());
    await store.create(rec("e1"));
    await store.create(rec("e2"));
    await store.create(rec("e3"));
    await store.close("e2", "dismissed", "u", 1);
    expect((await store.listOpen()).map((e) => e.record.id).sort()).toEqual(["e1", "e3"]);
  });

  it("create(record, ref) persists the card reference in one write (no attachCard window)", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b);
    await store.create(rec("e1"), { conversationReference: { conv: 1 }, activityId: "act-9" });
    const got = await store.get("e1");
    expect(got?.activityId).toBe("act-9");
    expect(got?.conversationReference).toEqual({ conv: 1 });
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual(["e1"]);
  });
});

// A backend that yields on every op so concurrent operations interleave — this is what exposes a
// shared-index race if index writes aren't serialized under their own lock.
function yieldingBackend(): EscalationStoreBackend & { dump: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    dump: m,
    async get(k) { await Promise.resolve(); return m.has(k) ? m.get(k) : null; },
    async set(k, v) { await Promise.resolve(); if (v === null) m.delete(k); else m.set(k, v); },
  };
}

describe("shared open-index concurrency (Kody critical — index is cross-id shared state)", () => {
  it("concurrent close() on DIFFERENT ids never leaves stale ids in the index", async () => {
    const b = yieldingBackend();
    const store = createEscalationStore(b);
    const ids = Array.from({ length: 25 }, (_, i) => `e${i}`);
    for (const id of ids) await store.create(rec(id));
    expect(([...(b.dump.get(ESCALATION_INDEX_KEY) as string[])]).sort()).toEqual([...ids].sort());
    // With per-id-only locking these index RMWs interleave and drop removals; the shared index
    // lock makes each read-modify-write atomic, so the final index is exactly empty.
    await Promise.all(ids.map((id) => store.close(id, "resolved", "u", 1)));
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual([]);
    expect(await store.listOpen()).toHaveLength(0);
  });

  it("concurrent create() on different ids keeps every id (no lost appends)", async () => {
    const b = yieldingBackend();
    const store = createEscalationStore(b);
    const ids = Array.from({ length: 25 }, (_, i) => `n${i}`);
    await Promise.all(ids.map((id) => store.create(rec(id))));
    expect(([...(b.dump.get(ESCALATION_INDEX_KEY) as string[])]).sort()).toEqual([...ids].sort());
  });
});
