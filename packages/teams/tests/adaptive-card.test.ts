import { describe, expect, it } from "vitest";
import { adaptiveCard, openUrlAction, textBlock, toWorkflowsMessage, validateAdaptiveCard } from "../src/adaptive-card.js";
import { buildNotificationCard, type TeamsNotification } from "../src/notifications.js";

const samples: TeamsNotification[] = [
  { kind: "issue-created", title: "Add auth", issueIdentifier: "PROJ-1", projectName: "Core" },
  { kind: "issue-done", title: "Add auth", issueIdentifier: "PROJ-1", agentName: "Ada" },
  { kind: "approval", approvalId: "a1", title: "Deploy", requester: "Bob", budget: "$50", issueIdentifier: "PROJ-2", issueTitle: "Deploy prod" },
  { kind: "agent-error", agentName: "Ada", issueIdentifier: "PROJ-3", error: "boom" },
  { kind: "budget-threshold", budgetId: "b1", budgetName: "Sprint", threshold: 90, spent: "$90", limit: "$100" },
];

describe("adaptive cards (PCLIP-18)", () => {
  it("every event-type card is a valid v1.5 Adaptive Card (AC #2)", () => {
    for (const s of samples) {
      const card = buildNotificationCard(s);
      expect(card.version).toBe("1.5");
      expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    }
  });

  it("wraps the card in the Workflows message envelope (a bare card is 400'd)", () => {
    const msg = toWorkflowsMessage(buildNotificationCard(samples[0]));
    expect(msg.type).toBe("message");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null });
    expect(msg.attachments[0].content.type).toBe("AdaptiveCard");
  });

  it("approval card carries title, requester, budget, and issue (AC #1)", () => {
    const json = JSON.stringify(buildNotificationCard(samples[2]));
    expect(json).toContain("Bob"); // requester
    expect(json).toContain("$50"); // budget
    expect(json).toContain("PROJ-2"); // issue
    expect(json).toContain("Deploy"); // title
  });

  it("adds a deep-link action only when a link is supplied (T3 wiring)", () => {
    const withLink = buildNotificationCard({ ...samples[0], link: "https://pc.example.com/i/PROJ-1" });
    expect(withLink.actions?.[0]).toMatchObject({ type: "Action.OpenUrl", url: "https://pc.example.com/i/PROJ-1" });
    expect(buildNotificationCard(samples[0]).actions).toBeUndefined();
  });

  it("FactSet drops empty rows so a missing field never renders blank", () => {
    const card = buildNotificationCard({ kind: "issue-created", title: "x" }); // no id/project
    const factSet = card.body.find((e) => e.type === "FactSet") as unknown as { facts: unknown[] };
    expect(factSet.facts).toHaveLength(0);
  });

  it("validator rejects newer schema, non-v1 actions, and a bad OpenUrl", () => {
    expect(validateAdaptiveCard({ type: "AdaptiveCard", $schema: "x", version: "2.0", body: [] }).ok).toBe(false);
    // Action.Execute is a v2 Universal Action (PCLIP-24), not valid on a v1 card
    expect(validateAdaptiveCard(adaptiveCard([textBlock("hi")], [{ type: "Action.Execute", title: "Go", verb: "do" }])).ok).toBe(false);
    expect(validateAdaptiveCard(adaptiveCard([textBlock("hi")], [openUrlAction("Go", "ftp://x")])).ok).toBe(false);
  });
});
