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
  it("create adds to the open index and is retrievable", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b, { now: () => 5 });
    await store.create(rec("e1"));
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual(["e1"]);
    const got = await store.get("e1");
    expect(got?.record.id).toBe("e1");
    expect(got?.updatedAtMs).toBe(5);
  });

  it("attachCard stores the conversation ref + activity id", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b);
    await store.create(rec("e1"));
    await store.attachCard("e1", { conversationReference: { a: 1 }, activityId: "act-9" });
    const got = await store.get("e1");
    expect(got?.activityId).toBe("act-9");
    expect(got?.conversationReference).toEqual({ a: 1 });
  });

  it("close moves to terminal status, removes from the open index, and is idempotent", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b, { now: () => 7 });
    await store.create(rec("e1"));
    const closed = await store.close("e1", "resolved", "teams:abc", 999);
    expect(closed?.record).toMatchObject({ status: "resolved", resolvedBy: "teams:abc", resolvedAtMs: 999 });
    expect(b.dump.get(ESCALATION_INDEX_KEY)).toEqual([]);
    // second close does NOT transition again → null (guarantees no double reply-back)
    const again = await store.close("e1", "dismissed", "teams:xyz", 1500);
    expect(again).toBeNull();
    // and the stored status is unchanged from the first close
    expect((await store.get("e1"))?.record.status).toBe("resolved");
  });

  it("close on an unknown id returns null", async () => {
    const store = createEscalationStore(memoryBackend());
    expect(await store.close("nope", "resolved", "x", 1)).toBeNull();
  });

  it("listOpen returns only still-open entries", async () => {
    const b = memoryBackend();
    const store = createEscalationStore(b);
    await store.create(rec("e1"));
    await store.create(rec("e2"));
    await store.create(rec("e3"));
    await store.close("e2", "dismissed", "teams:u", 1);
    const open = await store.listOpen();
    expect(open.map((e) => e.record.id).sort()).toEqual(["e1", "e3"]);
  });

  it("stores per-escalation under escalation:{id}", async () => {
    const b = memoryBackend();
    await createEscalationStore(b).create(rec("e9"));
    expect(b.dump.has(escalationStateKey("e9"))).toBe(true);
  });
});
