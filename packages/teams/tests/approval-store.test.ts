import { describe, expect, it } from "vitest";
import { approvalStateKey, createApprovalStore, type ApprovalStoreBackend } from "../src/approval-store.js";

function makeBackend(): ApprovalStoreBackend & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

const ref = {
  conversationReference: { conversation: { id: "19:abc" }, serviceUrl: "https://smba/" },
  activityId: "act-1",
  title: "Deploy",
  requester: "Ada",
  issueIdentifier: "PCLIP-9",
  link: "https://pc/approvals/ap-1",
};

describe("approval card-ref store (PCLIP-24)", () => {
  it("keys per approval id", () => {
    expect(approvalStateKey("ap-1")).toBe("approval:ap-1");
  });

  it("remembers and reads back a card ref (with timestamp)", async () => {
    const store = createApprovalStore(makeBackend(), { now: () => 42 });
    await store.remember("ap-1", ref);
    const got = await store.get("ap-1");
    expect(got?.activityId).toBe("act-1");
    expect(got?.title).toBe("Deploy");
    expect(got?.updatedAt).toBe(42);
  });

  it("stores under approval:{id} and isolates approvals", async () => {
    const backend = makeBackend();
    const store = createApprovalStore(backend);
    await store.remember("ap-1", ref);
    expect(backend.map.has("approval:ap-1")).toBe(true);
    expect(await store.get("ap-2")).toBeNull();
  });

  it("forget clears the entry", async () => {
    const store = createApprovalStore(makeBackend());
    await store.remember("ap-1", ref);
    await store.forget("ap-1");
    expect(await store.get("ap-1")).toBeNull();
  });

  it("coerces malformed/blank state to null", async () => {
    const backend = makeBackend();
    backend.map.set("approval:bad", { title: "no activity id" });
    const store = createApprovalStore(backend);
    expect(await store.get("bad")).toBeNull();
    expect(await store.get("")).toBeNull();
  });
});
