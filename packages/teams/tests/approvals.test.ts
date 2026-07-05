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

describe("teamsActor", () => {
  it("maps aadObjectId; falls back to unknown", () => {
    expect(teamsActor("abc-123")).toBe("teams:abc-123");
    expect(teamsActor(undefined)).toBe("teams:unknown");
    expect(teamsActor("")).toBe("teams:unknown");
  });
});

describe("approval cards", () => {
  const input = { approvalId: "ap-1", title: "Deploy to prod", requester: "Ada", issueIdentifier: "PCLIP-9", link: "https://pc.example.com/p/approvals/ap-1" };
  it("pending card valid with Approve/Reject Action.Submit + View", () => {
    const card = buildApprovalCard(input);
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    const submits = (card.actions ?? []).filter((a) => a.type === "Action.Submit");
    expect(submits).toHaveLength(2);
    expect(submits.map((a) => (a.data as { verb: string }).verb).sort()).toEqual(["approve", "reject"]);
    expect(submits.every((a) => (a.data as { approvalId: string }).approvalId === "ap-1")).toBe(true);
  });
  it("omits View when no link", () => {
    expect((buildApprovalCard({ approvalId: "ap-2" }).actions ?? []).some((a) => a.type === "Action.OpenUrl")).toBe(false);
  });
  it("decided card Approved/Rejected by {name}, no actions", () => {
    const approved = buildDecidedCard("approve", { byName: "Ada", title: "Deploy to prod" });
    expect(validateAdaptiveCard(approved).ok).toBe(true);
    expect(approved.actions).toBeUndefined();
    expect(JSON.stringify(approved)).toContain("Approved by Ada");
    expect(JSON.stringify(buildDecidedCard("reject", { byName: "Bob" }))).toContain("Rejected by Bob");
  });
  it("error card keeps actions (AC #5)", () => {
    const card = buildApprovalErrorCard(input, "API 503");
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect((card.actions ?? []).filter((a) => a.type === "Action.Submit")).toHaveLength(2);
    expect(JSON.stringify(card)).toContain("try again");
  });
  it("validator rejects Action.Execute but allows Action.Submit", () => {
    expect(validateAdaptiveCard({ ...buildApprovalCard(input), actions: [{ type: "Action.Execute", title: "x" }] }).ok).toBe(false);
  });
});

describe("parseApprovalSubmit", () => {
  it("parses ours", () => {
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "approve", approvalId: "ap-1" })).toEqual({ verb: "approve", approvalId: "ap-1" });
  });
  it("ignores others", () => {
    expect(parseApprovalSubmit(undefined)).toBeNull();
    expect(parseApprovalSubmit({ pcAction: "other", verb: "approve", approvalId: "x" })).toBeNull();
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "delete", approvalId: "x" })).toBeNull();
    expect(parseApprovalSubmit({ pcAction: "approval", verb: "approve", approvalId: "" })).toBeNull();
  });
});

describe("extractDecidedApprovalRef + verbFromStatus", () => {
  it("extracts approvalId + decider (no verb in the event)", () => {
    expect(extractDecidedApprovalRef({ entityId: "ap-1", actorId: "board", payload: { type: "hire_agent" } })).toEqual({ approvalId: "ap-1", decidedBy: "board" });
    expect(extractDecidedApprovalRef({ payload: { approvalId: "ap-2", decidedByUserId: "teams:x" } })).toEqual({ approvalId: "ap-2", decidedBy: "teams:x" });
  });
  it("null without an approval id", () => {
    expect(extractDecidedApprovalRef({ payload: {} })).toBeNull();
    expect(extractDecidedApprovalRef({})).toBeNull();
  });
  it("verbFromStatus maps status→verb", () => {
    expect(verbFromStatus("approved")).toBe("approve");
    expect(verbFromStatus("rejected")).toBe("reject");
    expect(verbFromStatus("pending")).toBeNull();
    expect(verbFromStatus(undefined)).toBeNull();
  });
});

describe("approvals REST client", () => {
  const capture = (status: number, bodyText = "") => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body?: string } }> = [];
    const fetchFn: ApprovalFetch = async (url, init) => { calls.push({ url, init }); return { status, text: async () => bodyText }; };
    return { calls, fetchFn };
  };
  it("POSTs approve with Bearer + decidedByUserId; returns the ACTUAL server verb", async () => {
    const { calls, fetchFn } = capture(200, JSON.stringify({ id: "ap-1", status: "approved", decidedByUserId: "board" }));
    const r = await createApprovalsClient({ baseUrl: "https://pc.example.com/", apiKey: "key-123", fetchFn }).decide("approve", "ap-1", { actor: "teams:abc" });
    expect(r).toMatchObject({ ok: true, status: 200, verb: "approve", decidedBy: "board" });
    expect(calls[0].url).toBe("https://pc.example.com/api/approvals/ap-1/approve");
    expect(calls[0].init.headers["Authorization"]).toBe("Bearer key-123");
    expect(JSON.parse(calls[0].init.body!).decidedByUserId).toBe("teams:abc");
  });
  it("idempotency-safe: click Approve but server already rejected → returns the ACTUAL verb (reject)", async () => {
    const { fetchFn } = capture(200, JSON.stringify({ status: "rejected", decidedByUserId: "someone" }));
    const r = await createApprovalsClient({ baseUrl: "https://pc.example.com", apiKey: "k", fetchFn }).decide("approve", "ap-1", { actor: "teams:x" });
    expect(r).toMatchObject({ ok: true, verb: "reject", decidedBy: "someone" });
  });
  it("falls back to the clicked verb when the response body is empty/unparseable", async () => {
    const { fetchFn } = capture(200, "");
    expect((await createApprovalsClient({ baseUrl: "https://pc.example.com", fetchFn }).decide("approve", "ap", { actor: "teams:x" })).verb).toBe("approve");
  });
  it("reject + omits Authorization without key", async () => {
    const { calls, fetchFn } = capture(200);
    await createApprovalsClient({ baseUrl: "https://pc.example.com", fetchFn }).decide("reject", "ap-2", { actor: "teams:x" });
    expect(calls[0].url).toBe("https://pc.example.com/api/approvals/ap-2/reject");
    expect(calls[0].init.headers["Authorization"]).toBeUndefined();
  });
  it("ok:false on non-2xx", async () => {
    const { fetchFn } = capture(404, "Approval not found");
    expect((await createApprovalsClient({ baseUrl: "https://pc.example.com", apiKey: "k", fetchFn }).decide("approve", "missing", { actor: "teams:x" }))).toMatchObject({ ok: false, status: 404 });
  });
  it("never throws on network failure", async () => {
    const fetchFn: ApprovalFetch = async () => { throw new Error("network down"); };
    expect((await createApprovalsClient({ baseUrl: "https://pc.example.com", apiKey: "k", fetchFn }).decide("approve", "ap", { actor: "teams:x" }))).toMatchObject({ ok: false, status: 0 });
  });
  it("rejects invalid base URL without fetch", async () => {
    let called = false;
    const fetchFn: ApprovalFetch = async () => { called = true; return { status: 200, text: async () => "" }; };
    expect((await createApprovalsClient({ baseUrl: "", apiKey: "k", fetchFn }).decide("approve", "ap", { actor: "teams:x" })).ok).toBe(false);
    expect(called).toBe(false);
  });
  it("getStatus GETs the approval; derives verb + decidedBy; no body on GET", async () => {
    const { calls, fetchFn } = capture(200, JSON.stringify({ id: "ap-1", status: "rejected", decidedByUserId: "board" }));
    const r = await createApprovalsClient({ baseUrl: "https://pc.example.com", apiKey: "k", fetchFn }).getStatus("ap-1");
    expect(calls[0].url).toBe("https://pc.example.com/api/approvals/ap-1");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect(r).toMatchObject({ ok: true, verb: "reject", decidedBy: "board" });
  });
  it("getStatus ok:true no verb when pending; ok:false on non-2xx", async () => {
    const pending = capture(200, JSON.stringify({ status: "pending" }));
    expect(await createApprovalsClient({ baseUrl: "https://pc.example.com", fetchFn: pending.fetchFn }).getStatus("ap")).toMatchObject({ ok: true, verb: undefined });
    const missing = capture(404, "not found");
    expect((await createApprovalsClient({ baseUrl: "https://pc.example.com", fetchFn: missing.fetchFn }).getStatus("ap")).ok).toBe(false);
  });
});
