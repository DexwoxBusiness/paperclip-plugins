import { describe, expect, it } from "vitest";
import {
  buildEscalationCard,
  buildEscalationResolvedCard,
  expiredEscalations,
  formatConfidence,
  parseEscalationSubmit,
  timeoutMsFromMinutes,
  type EscalationRecord,
} from "../src/escalation.js";
import { validateAdaptiveCard } from "../src/adaptive-card.js";

function rec(over: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: "esc-1",
    agentId: "agent-1",
    companyId: "co-1",
    reason: "Customer is asking for a refund I can't authorize",
    confidence: 0.42,
    agentName: "Support Bot",
    agentReasoning: "Refund exceeds my limit",
    suggestedReply: "I've escalated your refund to a human — they'll follow up shortly.",
    conversationHistory: [
      { role: "user", text: "I want a refund" },
      { role: "agent", text: "Let me check that for you" },
    ],
    status: "open",
    createdAtMs: 1_000_000,
    ...over,
  };
}

describe("parseEscalationSubmit", () => {
  it("parses reply and dismiss", () => {
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "esc-1", action: "reply" })).toEqual({ escalationId: "esc-1", action: "reply" });
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "esc-1", action: "dismiss" })).toEqual({ escalationId: "esc-1", action: "dismiss" });
  });
  it("ignores non-escalation / malformed submits", () => {
    expect(parseEscalationSubmit(undefined)).toBeNull();
    expect(parseEscalationSubmit({ pcAction: "approval", escalationId: "x", action: "reply" })).toBeNull();
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "", action: "reply" })).toBeNull();
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "x", action: "bogus" })).toBeNull();
  });
});

describe("formatConfidence", () => {
  it("renders [0,1] as a percentage; clamps; blanks invalid", () => {
    expect(formatConfidence(0.42)).toBe("42%");
    expect(formatConfidence(0)).toBe("0%");
    expect(formatConfidence(1)).toBe("100%");
    expect(formatConfidence(1.5)).toBe("100%");
    expect(formatConfidence(undefined)).toBe("");
    expect(formatConfidence(NaN)).toBe("");
  });
});

describe("buildEscalationCard (AC #1)", () => {
  it("includes conversation history, agent reasoning, and confidence", () => {
    const card = buildEscalationCard(rec());
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    const json = JSON.stringify(card);
    expect(json).toContain("Refund exceeds my limit"); // reasoning
    expect(json).toContain("42%"); // confidence
    expect(json).toContain("I want a refund"); // history
    expect(json).toContain("Let me check that for you");
  });
  it("shows 'Use suggested reply' only when a suggestedReply exists; always shows Dismiss", () => {
    const withReply = buildEscalationCard(rec());
    const submits = (withReply.actions ?? []).filter((a) => a.type === "Action.Submit");
    expect(submits.map((a) => (a.data as { action: string }).action).sort()).toEqual(["dismiss", "reply"]);

    const noReply = buildEscalationCard(rec({ suggestedReply: undefined }));
    const submits2 = (noReply.actions ?? []).filter((a) => a.type === "Action.Submit");
    expect(submits2.map((a) => (a.data as { action: string }).action)).toEqual(["dismiss"]);
  });
  it("renders without optional fields (no reasoning/history/confidence)", () => {
    const card = buildEscalationCard(rec({ agentReasoning: undefined, conversationHistory: [], confidence: undefined, suggestedReply: undefined }));
    expect(validateAdaptiveCard(card).ok).toBe(true);
  });
});

describe("buildEscalationResolvedCard", () => {
  it("resolved/dismissed name the human; timed_out omits actions", () => {
    const resolved = buildEscalationResolvedCard(rec(), "resolved", { byName: "Ada" });
    expect(validateAdaptiveCard(resolved).ok).toBe(true);
    expect(resolved.actions).toBeUndefined();
    expect(JSON.stringify(resolved)).toContain("Resolved by Ada");
    expect(JSON.stringify(buildEscalationResolvedCard(rec(), "dismissed", { byName: "Bob" }))).toContain("Dismissed by Bob");
    expect(JSON.stringify(buildEscalationResolvedCard(rec(), "timed_out"))).toMatch(/Timed out/i);
  });
});

describe("expiredEscalations + timeoutMsFromMinutes", () => {
  const now = 10_000_000;
  it("returns only OPEN records past the timeout", () => {
    const records: EscalationRecord[] = [
      rec({ id: "old-open", status: "open", createdAtMs: now - 20 * 60_000 }),
      rec({ id: "fresh-open", status: "open", createdAtMs: now - 5 * 60_000 }),
      rec({ id: "old-resolved", status: "resolved", createdAtMs: now - 30 * 60_000 }),
    ];
    expect(expiredEscalations(records, now, 15 * 60_000)).toEqual(["old-open"]);
  });
  it("boundary: exactly timeout counts as expired", () => {
    expect(expiredEscalations([rec({ id: "x", createdAtMs: now - 15 * 60_000 })], now, 15 * 60_000)).toEqual(["x"]);
  });
  it("timeoutMsFromMinutes guards invalid/non-positive → 15m default", () => {
    expect(timeoutMsFromMinutes(30)).toBe(30 * 60_000);
    expect(timeoutMsFromMinutes(undefined)).toBe(15 * 60_000);
    expect(timeoutMsFromMinutes(0)).toBe(15 * 60_000);
    expect(timeoutMsFromMinutes(-5)).toBe(15 * 60_000);
  });
});
