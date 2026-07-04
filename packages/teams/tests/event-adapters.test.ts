import { describe, expect, it } from "vitest";
import {
  adaptAgentError,
  adaptApprovalCreated,
  adaptBudgetThreshold,
  adaptIssueCreated,
  adaptIssueDone,
  extractCompletedAgent,
} from "../src/event-adapters.js";
import { createBudgetDedupe, type DedupeStore } from "../src/notifications.js";

// Payloads below mirror the VERIFIED host event shapes (activity-log details /
// publishRunLifecyclePluginEvent), not assumptions.
describe("event adapters — real host payloads (PCLIP-18)", () => {
  it("issue.created: title + identifier from details, id from entityId", () => {
    const n = adaptIssueCreated({ entityId: "iss-1", payload: { title: "Add auth", identifier: "PCLIP-7" } });
    expect(n).toMatchObject({ kind: "issue-created", title: "Add auth", issueId: "iss-1", issueIdentifier: "PCLIP-7" });
  });

  it("issue.updated → issue-done ONLY on a transition into done", () => {
    const done = adaptIssueDone({ entityId: "iss-2", actorId: "ag1", payload: { status: "done", identifier: "PCLIP-8" } });
    expect(done).toMatchObject({ kind: "issue-done", issueId: "iss-2", issueIdentifier: "PCLIP-8" });
    expect(adaptIssueDone({ payload: { status: "in_progress", identifier: "PCLIP-8" } })).toBeNull();
    expect(adaptIssueDone({ payload: { status: "done", _previous: { status: "done" }, identifier: "PCLIP-8" } })).toBeNull();
  });

  it("approval.created: degraded to available fields (type, issueIds, actor=requester)", () => {
    const n = adaptApprovalCreated({ entityId: "appr-1", actorId: "user-9", payload: { type: "budget", issueIds: ["iss-uuid"] } });
    expect(n).toMatchObject({ kind: "approval", approvalId: "appr-1", title: "budget approval", requester: "user-9", issueIdentifier: "iss-uuid" });
    if (n?.kind === "approval") expect(n.budget).toBeUndefined();
  });

  it("agent.run.failed → agent-error (flat payload: agentId, issueId, error)", () => {
    const n = adaptAgentError({ actorId: "ag1", payload: { agentId: "ag1", issueId: "iss-3", error: "boom", errorCode: "E1" } });
    expect(n).toMatchObject({ kind: "agent-error", error: "boom", agentId: "ag1", issueId: "iss-3" });
    expect(adaptAgentError({ payload: { agentId: "ag1", errorCode: "E_TIMEOUT" } })).toMatchObject({ error: "E_TIMEOUT" });
  });

  it("budget.incident.opened → threshold derived from amountObserved/amountLimit, keyed by scope", () => {
    const n = adaptBudgetThreshold({ entityId: "incident-1", payload: { scopeType: "company", scopeId: "co-1", amountObserved: 92, amountLimit: 100 } });
    expect(n).toMatchObject({ kind: "budget-threshold", budgetId: "co-1", threshold: 90, budgetName: "company" });
    expect(adaptBudgetThreshold({ payload: { scopeId: "co-1", amountObserved: 100, amountLimit: 100 } })).toMatchObject({ threshold: 100 });
    expect(adaptBudgetThreshold({ payload: { scopeId: "co-1", amountObserved: 50, amountLimit: 100 } })).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(adaptIssueCreated({ payload: {} })).toBeNull();
    expect(adaptAgentError({ payload: {} })).toBeNull();
    expect(adaptBudgetThreshold({ payload: {} })).toBeNull();
    expect(adaptIssueDone({ payload: {} })).toBeNull();
  });

  it("extractCompletedAgent reads agentId (agent.run.finished)", () => {
    expect(extractCompletedAgent({ payload: { agentId: "ag7" } })).toBe("ag7");
    expect(extractCompletedAgent({ actorId: "ag8", payload: {} })).toBe("ag8");
  });
});

describe("budget dedupe (AC #3 — one card per threshold)", () => {
  function makeStore(): DedupeStore & { map: Map<string, unknown> } {
    const map = new Map<string, unknown>();
    return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
  }
  const okDeliver = () => Promise.resolve(true);

  it("posts once per (budget, threshold) and dedupes repeats", async () => {
    const d = createBudgetDedupe(makeStore());
    let posts = 0;
    const deliver = () => {
      posts++;
      return Promise.resolve(true);
    };
    expect(await d.postOnce("b1", 90, deliver)).toBe("posted");
    expect(await d.postOnce("b1", 90, deliver)).toBe("deduped");
    expect(await d.postOnce("b1", 100, deliver)).toBe("posted");
    expect(posts).toBe(2);
  });

  it("does NOT mark a threshold seen when delivery fails — retryable", async () => {
    const d = createBudgetDedupe(makeStore());
    expect(await d.postOnce("b1", 90, () => Promise.resolve(false))).toBe("skipped");
    expect(await d.postOnce("b1", 90, okDeliver)).toBe("posted");
    expect(await d.postOnce("b1", 90, okDeliver)).toBe("deduped");
  });

  it("serializes concurrent crossings — exactly one posts", async () => {
    const d = createBudgetDedupe(makeStore());
    let posts = 0;
    const deliver = async () => {
      posts++;
      await Promise.resolve();
      return true;
    };
    const results = await Promise.all([d.postOnce("b1", 90, deliver), d.postOnce("b1", 90, deliver), d.postOnce("b1", 90, deliver)]);
    expect(results.filter((r) => r === "posted")).toHaveLength(1);
    expect(posts).toBe(1);
  });
});
