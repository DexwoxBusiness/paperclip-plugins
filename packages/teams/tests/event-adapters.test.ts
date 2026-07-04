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

  it("posts once per (budget, threshold) and suppresses repeats", async () => {
    const d = createBudgetDedupe(makeStore());
    expect(await d.shouldPost("b1", 90)).toBe(true);
    expect(await d.shouldPost("b1", 90)).toBe(false); // repeat
    expect(await d.shouldPost("b1", 100)).toBe(true); // different threshold
    expect(await d.shouldPost("b2", 90)).toBe(true); // different budget
  });

  it("serializes concurrent crossings — exactly one posts", async () => {
    const d = createBudgetDedupe(makeStore());
    const results = await Promise.all([d.shouldPost("b1", 90), d.shouldPost("b1", 90), d.shouldPost("b1", 90)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
