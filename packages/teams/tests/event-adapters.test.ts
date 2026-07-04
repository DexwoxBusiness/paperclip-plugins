import { describe, expect, it } from "vitest";
import {
  adaptAgentError,
  adaptApprovalCreated,
  adaptBudgetThreshold,
  adaptIssueCreated,
  adaptIssueDone,
} from "../src/event-adapters.js";
import { createBudgetDedupe, type DedupeStore } from "../src/notifications.js";

describe("event adapters (PCLIP-18)", () => {
  it("maps issue.created (builds readable id from project + sequence)", () => {
    const n = adaptIssueCreated({
      entityId: "i1",
      payload: { issue: { id: "i1", name: "Add auth", project__identifier: "PROJ", sequence_id: 7, project_name: "Core" } },
    });
    expect(n).toMatchObject({ kind: "issue-created", title: "Add auth", issueIdentifier: "PROJ-7", projectName: "Core" });
  });

  it("maps agent.task_completed to issue-done", () => {
    const n = adaptIssueDone({ payload: { issue: { identifier: "PROJ-2", name: "Ship" }, agentName: "Ada" } });
    expect(n).toMatchObject({ kind: "issue-done", issueIdentifier: "PROJ-2", agentName: "Ada" });
  });

  it("maps approval.created with requester/budget/issue (AC #1 fields)", () => {
    const n = adaptApprovalCreated({
      entityId: "a1",
      actorId: "u1",
      payload: { approval: { id: "a1", title: "Deploy", requester: "Bob", budget: "$50", issue: { identifier: "PROJ-2", name: "Deploy prod" } } },
    });
    expect(n).toMatchObject({ kind: "approval", requester: "Bob", budget: "$50", issueIdentifier: "PROJ-2", issueTitle: "Deploy prod" });
  });

  it("maps agent.run.failed to an agent-error", () => {
    const n = adaptAgentError({ actorId: "ag1", payload: { error: "stack overflow", agentName: "Ada", issue: { identifier: "PROJ-3" } } });
    expect(n).toMatchObject({ kind: "agent-error", error: "stack overflow", agentName: "Ada", issueIdentifier: "PROJ-3" });
  });

  it("returns null when a required field is missing (never posts a blank card)", () => {
    expect(adaptIssueCreated({ payload: {} })).toBeNull();
    expect(adaptAgentError({ payload: {} })).toBeNull();
    expect(adaptBudgetThreshold({ payload: {} })).toBeNull();
  });

  it("never shows the approval/run id as the issue id for a nested issue without its own id (Codex)", () => {
    // approval.created: entityId is the APPROVAL id, not an issue id
    const appr = adaptApprovalCreated({
      entityId: "appr-1",
      payload: { approval: { id: "appr-1", title: "x", requester: "b", issue: { name: "Issue with no id" } } },
    });
    expect(appr?.kind).toBe("approval");
    if (appr?.kind === "approval") {
      expect(appr.issueIdentifier).toBeUndefined(); // NOT "appr-1"
      expect(appr.issueTitle).toBe("Issue with no id");
    }
    // agent.run.failed: entityId may be the run id
    const err = adaptAgentError({ entityId: "run-9", payload: { error: "boom", issue: { name: "no id" } } });
    if (err?.kind === "agent-error") expect(err.issueIdentifier).toBeUndefined();
  });

  it("issue.created DOES use entityId as the issue id (entity IS the issue)", () => {
    const n = adaptIssueCreated({ entityId: "iss-9", payload: { name: "Title only" } });
    expect(n).toMatchObject({ kind: "issue-created", issueIdentifier: "iss-9" });
  });

  it("uses an explicit budget threshold when present", () => {
    const n = adaptBudgetThreshold({ payload: { budget: { id: "b1", name: "Sprint" }, threshold: 90, spent: "$90", limit: "$100" } });
    expect(n).toMatchObject({ kind: "budget-threshold", budgetId: "b1", threshold: 90, budgetName: "Sprint" });
  });

  it("derives + snaps the threshold from spent/limit to 80/90/100", () => {
    expect(adaptBudgetThreshold({ payload: { budgetId: "b1", spent: 92, limit: 100 } })).toMatchObject({ threshold: 90 });
    expect(adaptBudgetThreshold({ payload: { budgetId: "b1", spent: 100, limit: 100 } })).toMatchObject({ threshold: 100 });
    expect(adaptBudgetThreshold({ payload: { budgetId: "b1", spent: 50, limit: 100 } })).toBeNull(); // below lowest threshold
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
    expect(await d.postOnce("b1", 90, deliver)).toBe("deduped"); // repeat -> no deliver
    expect(await d.postOnce("b1", 100, deliver)).toBe("posted"); // different threshold
    expect(await d.postOnce("b2", 90, deliver)).toBe("posted"); // different budget
    expect(posts).toBe(3);
  });

  it("does NOT mark a threshold seen when delivery fails — retryable on a later crossing (Codex)", async () => {
    const d = createBudgetDedupe(makeStore());
    // first crossing while the URL is unset / Teams is down -> delivery false -> skipped, not marked
    expect(await d.postOnce("b1", 90, () => Promise.resolve(false))).toBe("skipped");
    // after recovery a later crossing still posts (was not suppressed)
    expect(await d.postOnce("b1", 90, okDeliver)).toBe("posted");
    // and only now does it dedupe
    expect(await d.postOnce("b1", 90, okDeliver)).toBe("deduped");
  });

  it("skips invalid input without delivering", async () => {
    const d = createBudgetDedupe(makeStore());
    let posts = 0;
    const deliver = () => {
      posts++;
      return Promise.resolve(true);
    };
    expect(await d.postOnce("", 90, deliver)).toBe("skipped");
    expect(await d.postOnce("b1", Number.NaN, deliver)).toBe("skipped");
    expect(posts).toBe(0);
  });

  it("serializes concurrent crossings — exactly one posts, the rest dedupe", async () => {
    const d = createBudgetDedupe(makeStore());
    let posts = 0;
    const deliver = async () => {
      posts++;
      await Promise.resolve();
      return true;
    };
    const results = await Promise.all([
      d.postOnce("b1", 90, deliver),
      d.postOnce("b1", 90, deliver),
      d.postOnce("b1", 90, deliver),
    ]);
    expect(results.filter((r) => r === "posted")).toHaveLength(1);
    expect(results.filter((r) => r === "deduped")).toHaveLength(2);
    expect(posts).toBe(1);
  });
});
