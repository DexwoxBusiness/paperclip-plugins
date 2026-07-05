import { describe, expect, it } from "vitest";
import {
  buildApprovalCard,
  buildApprovalErrorCard,
  buildDecidedCard,
  createApprovalsClient,
  extractDecidedApprovalRef,
  parseApprovalSubmit,
  teamsActor,
  verbFromStatus,
  type ApprovalFetch,
} from "../src/approvals.js";
import { validateAdaptiveCard } from "../src/adaptive-card.js";

describe("teamsActor (PCLIP-24 AC #4)", () => {
  it("maps aadObjectId to teams:{id}; falls back to unknown", () => {
    expect(teamsActor("abc-123")).toBe("teams:abc-123");
    expect(teamsActor("  x  ")).toBe("teams:x");
    expect(teamsActor(undefined)).toBe("teams:unknown");
    expect(teamsActor(null)).toBe("teams:unknown");
    expect(teamsActor("")).toBe("teams:unknown");
  });
});

describe("approval cards", () => {
  const input = { approvalId: "ap-1", title: "Deploy to prod", requester: "Ada", issueIdentifier: "PCLIP-9", link: "https://pc.example.com/p/approvals/ap-1" };

  it("pending card is a valid v1.5 card with Approve/Reject Action.Submit + View", () => {
    const card = buildApprovalCard(input);
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    const submits = (card.actions ?? []).filter((a) => a.type === "Action.Submit");
    expect(submits).toHaveLength(2);
    expect(submits.map((a) => (a.data as { verb: string }).verb).sort()).toEqual(["approve", "reject"]);
    expect(submits.every((a) => (a.data as { pcAction: string }).pcAction === "approval")).toBe(true);
    expect(submits.every((a) => (a.data as { approvalId: string }).approvalId === "ap-1")).toBe(true);
    expect((card.actions ?? []).some((a) => a.type === "Action.OpenUrl")).toBe(true);
  });

  it("omits the View action when no link is given", () => {
    const card = buildApprovalCard({ approvalId: "ap-2" });
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect((card.actions ?? []).some((a) => a.type === "Action.OpenUrl")).toBe(false);
  });

  it("decided card shows Approved/Rejected by {name} with NO actions", () => {
    const approved = buildDecidedCard("approve", { byName: "Ada", title: "Deploy to prod" });
    expect(validateAdaptiveCard(approved).ok).toBe(true);
    expect(approved.actions).toBeUndefined();
    expect(JSON.stringify(approved)).toContain("Approved by Ada");
    const rejected = buildDecidedCard("reject", { byName: "Bob" });
    expect(JSON.stringify(rejected)).toContain("Rejected by Bob");
  });

  it("error card keeps the actions so the user can retry (AC #5)", () => {
    const card = buildApprovalErrorCard(input, "API 503");
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect((card.actions ?? []).filter((a) => a.type === "Action.Submit")).toHaveLength(2);
    expect(JSON.stringify(card)).toContain("try again");
  });

  it("validator rejects Action.Execute but allows Action.Submit", () => {
    const withExecute = { ...buildApprovalCard(input), actions: [{ type: "Action.Execute", title: "x", verb: "y" }] };
    expect(validateAdaptiveCard(withExecute).ok).toBe(false);
  });
});

describe("parseApprovalSubmit", () => {
  it("parses our approval submits", () => {
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "approve", approvalId: "ap-1" })).toEqual({ verb: "approve", approvalId: "ap-1" });
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "reject", approvalId: "ap-2" })).toEqual({ verb: "reject", approvalId: "ap-2" });
  });
  it("ignores non-approval / malformed submits", () => {
    expect(parseApprovalSubmit(undefined)).toBeNull();
    expect(parseApprovalSubmit({ pcAction: "other", verb: "approve", approvalId: "x" })).toBeNull();
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "delete", approvalId: "x" })).toBeNull();
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "approve", approvalId: "" })).toBeNull();
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "approve" })).toBeNull();
  });
});

describe("extractDecidedApprovalRef + verbFromStatus (PCLIP-24)", () => {
  it("extracts approvalId (entityId) + decider (actorId) — event has NO verb", () => {
    expect(extractDecidedApprovalRef({ entityId: "ap-1", actorId: "board", payload: { type: "hire_agent" } })).toEqual({
      approvalId: "ap-1",
      decidedBy: "board",
    });
    expect(extractDecidedApprovalRef({ payload: { approvalId: "ap-2", decidedByUserId: "teams:x" } })).toEqual({
      approvalId: "ap-2",
      decidedBy: "teams:x",
    });
  });
  it("returns null when there is no approval id", () => {
    expect(extractDecidedApprovalRef({ payload: {} })).toBeNull();
    expect(extractDecidedApprovalRef({})).toBeNull();
  });
  it("verbFromStatus maps status strings to a verb (or null)", () => {
    expect(verbFromStatus("approved")).toBe("approve");
    expect(verbFromStatus("rejected")).toBe("reject");
    expect(verbFromStatus("pending")).toBeNull();
    expect(verbFromStatus(undefined)).toBeNull();
  });
});

describe("approvals REST client (PCLIP-24)", () => {
  const capture = (status: number, bodyText = "") => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fetchFn: ApprovalFetch = async (url, init) => {
      calls.push({ url, init });
      return { status, text: async () => bodyText };
    };
    return { calls, fetchFn };
  };

  it("POSTs to /api/approvals/{id}/approve with Bearer key + decidedByUserId", async () => {
    const { calls, fetchFn } = capture(200);
    const client = createApprovalsClient({ baseUrl: "https://pc.example.com/", apiKey: "key-123", fetchFn });
    const r = await client.decide("approve", "ap-1", { actor: "teams:abc" });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(calls[0].url).toBe("https://pc.example.com/api/approvals/ap-1/approve");
    expect(calls[0].init.headers["Authorization"]).toBe("Bearer key-123");
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.decidedByUserId).toBe("teams:abc");
    expect(typeof sent.decisionNote).toBe("string");
  });

  it("reject path + omits Authorization when no apiKey (local_trusted)", async () => {
    const { calls, fetchFn } = capture(200);
    const client = createApprovalsClient({ baseUrl: "https://pc.example.com", fetchFn });
    await client.decide("reject", "ap-2", { actor: "teams:x" });
    expect(calls[0].url).toBe("https://pc.example.com/api/approvals/ap-2/reject");
    expect(calls[0].init.headers["Authorization"]).toBeUndefined();
  });

  it("returns ok:false with status + error on a non-2xx (card stays actionable)", async () => {
    const { fetchFn } = capture(404, "Approval not found");
    const client = createApprovalsClient({ baseUrl: "https://pc.example.com", apiKey: "k", fetchFn });
    const r = await client.decide("approve", "missing", { actor: "teams:x" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.error).toMatch(/404/);
  });

  it("never throws on network failure", async () => {
    const fetchFn: ApprovalFetch = async () => {
      throw new Error("network down");
    };
    const client = createApprovalsClient({ baseUrl: "https://pc.example.com", apiKey: "k", fetchFn });
    const r = await client.decide("approve", "ap", { actor: "teams:x" });
    expect(r).toMatchObject({ ok: false, status: 0 });
    expect(r.error).toMatch(/network down/);
  });

  it("rejects a missing/invalid base URL without calling fetch", async () => {
    let called = false;
    const fetchFn: ApprovalFetch = async () => {
      called = true;
      return { status: 200, text: async () => "" };
    };
    const client = createApprovalsClient({ baseUrl: "", apiKey: "k", fetchFn });
    expect((await client.decide("approve", "ap", { actor: "teams:x" })).ok).toBe(false);
    expect(called).toBe(false);
  });

  it("getStatus GETs the approval and derives the verb from its status", async () => {
    const { calls, fetchFn } = capture(200, JSON.stringify({ id: "ap-1", status: "rejected" }));
    const client = createApprovalsClient({ baseUrl: "https://pc.example.com", apiKey: "k", fetchFn });
    const r = await client.getStatus("ap-1");
    expect(calls[0].url).toBe("https://pc.example.com/api/approvals/ap-1");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect(r).toMatchObject({ ok: true, verb: "reject" });
  });

  it("getStatus returns ok:true with no verb when still pending, and ok:false on a non-2xx", async () => {
    const pending = capture(200, JSON.stringify({ status: "pending" }));
    expect(await createApprovalsClient({ baseUrl: "https://pc.example.com", fetchFn: pending.fetchFn }).getStatus("ap")).toMatchObject({ ok: true, verb: undefined });
    const missing = capture(404, "not found");
    expect((await createApprovalsClient({ baseUrl: "https://pc.example.com", fetchFn: missing.fetchFn }).getStatus("ap")).ok).toBe(false);
  });
});
