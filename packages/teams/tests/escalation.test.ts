import { describe, expect, it } from "vitest";
import {
  buildEscalationCard,
  buildEscalationResolvedCard,
  expiredEscalations,
  formatConfidence,
  MAX_HISTORY_TURNS,
  parseEscalationSubmit,
  REPLY_INPUT_ID,
  resolveEscalationReply,
  sanitizeCardText,
  timeoutMsFromMinutes,
  type EscalationRecord,
} from "../src/escalation.js";
import { validateAdaptiveCard } from "../src/adaptive-card.js";

const NL = String.fromCharCode(10); // newline, without an escape sequence in source
const TAB = String.fromCharCode(9); // tab, ditto

function rec(over: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: "esc-1",
    agentId: "agent-1",
    companyId: "co-1",
    reason: "Customer wants a refund I can't authorize",
    confidence: 0.42,
    agentName: "Support Bot",
    agentReasoning: "Refund exceeds my limit",
    suggestedReply: "I've escalated your refund - a human will follow up.",
    conversationHistory: [
      { role: "user", text: "I want a refund" },
      { role: "agent", text: "Let me check" },
    ],
    status: "open",
    createdAtMs: 1_000_000,
    ...over,
  };
}

describe("parseEscalationSubmit", () => {
  it("parses reply/dismiss; ignores others", () => {
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "e", action: "reply" })).toEqual({ escalationId: "e", action: "reply", replyText: undefined });
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "e", action: "dismiss" })).toEqual({ escalationId: "e", action: "dismiss", replyText: undefined });
    expect(parseEscalationSubmit({ pcAction: "approval", escalationId: "e", action: "reply" })).toBeNull();
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "", action: "reply" })).toBeNull();
    expect(parseEscalationSubmit(undefined)).toBeNull();
  });
  it("extracts the human's edited reply from the Input.Text field (trimmed; blank → undefined)", () => {
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "e", action: "reply", [REPLY_INPUT_ID]: "  edited reply  " }))
      .toEqual({ escalationId: "e", action: "reply", replyText: "edited reply" });
    expect(parseEscalationSubmit({ pcAction: "escalation", escalationId: "e", action: "reply", [REPLY_INPUT_ID]: "   " }))
      .toEqual({ escalationId: "e", action: "reply", replyText: undefined });
  });
});

describe("resolveEscalationReply (human edit vs. fallback vs. nothing)", () => {
  it("prefers the human's edited text over the agent suggestion", () => {
    expect(resolveEscalationReply("  human edited  ", "agent suggestion")).toBe("human edited");
  });
  it("falls back to the suggestion when the field is blank/undefined", () => {
    expect(resolveEscalationReply(undefined, "agent suggestion")).toBe("agent suggestion");
    expect(resolveEscalationReply("   ", "agent suggestion")).toBe("agent suggestion");
  });
  it("returns null when there is nothing to send (both empty) so the worker re-opens", () => {
    expect(resolveEscalationReply("", "")).toBeNull();
    expect(resolveEscalationReply(undefined, undefined)).toBeNull();
  });
});

describe("formatConfidence", () => {
  it("renders percent; clamps; blanks invalid", () => {
    expect(formatConfidence(0.42)).toBe("42%");
    expect(formatConfidence(1.5)).toBe("100%");
    expect(formatConfidence(undefined)).toBe("");
    expect(formatConfidence(NaN)).toBe("");
  });
});

describe("sanitizeCardText (Kody security + perf)", () => {
  it("escapes Markdown-significant characters so links/emphasis don't render", () => {
    const out = sanitizeCardText("click [here](http://evil) and *bold* `code`");
    expect(out).toContain("\\[");
    expect(out).toContain("\\]");
    expect(out).toContain("\\(");
    expect(out).toContain("\\)");
    expect(out).toContain("\\*");
    expect(out).toContain("\\`");
    expect(out).not.toContain("[here]"); // the raw link syntax is broken up
  });
  it("neutralizes @-mentions with a zero-width joiner", () => {
    const out = sanitizeCardText("ping @channel now");
    expect(out).not.toContain("@channel"); // a zero-width char is inserted after @
    expect(out).toContain("@");
  });
  it("strips control characters (newlines/tabs) — no raw control chars survive", () => {
    const out = sanitizeCardText(`line1${NL}line2${TAB}line3!`);
    expect([...out].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true); // no control chars survive
    expect(out).toContain("\\!"); // the bang is still Markdown-escaped
    expect(out).toContain("line1 line2"); // newline became a space
  });
  it("caps length with an ellipsis", () => {
    const out = sanitizeCardText("x".repeat(5000), 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
  it("empty/invalid → empty string", () => {
    expect(sanitizeCardText(undefined)).toBe("");
    expect(sanitizeCardText("")).toBe("");
  });
});

describe("buildEscalationCard (AC #1)", () => {
  it("includes history, reasoning, confidence; sanitizes agent text", () => {
    const card = buildEscalationCard(rec({ reason: "refund [x](y)" }));
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    const json = JSON.stringify(card);
    expect(json).toContain("Refund exceeds my limit");
    expect(json).toContain("42%");
    expect(json).toContain("I want a refund");
    expect(json).not.toContain("refund [x](y)"); // sanitized (escaped)
  });
  it("shows the reply action only with a suggestedReply; always Dismiss", () => {
    const withReply = (buildEscalationCard(rec()).actions ?? []).filter((a) => a.type === "Action.Submit");
    expect(withReply.map((a) => (a.data as { action: string }).action).sort()).toEqual(["dismiss", "reply"]);
    const noReply = (buildEscalationCard(rec({ suggestedReply: undefined })).actions ?? []).filter((a) => a.type === "Action.Submit");
    expect(noReply.map((a) => (a.data as { action: string }).action)).toEqual(["dismiss"]);
  });
  it("renders an EDITABLE reply input prefilled with the suggestion (no input when none)", () => {
    const card = buildEscalationCard(rec({ suggestedReply: "Please try restarting" }));
    expect(validateAdaptiveCard(card).ok).toBe(true);
    const input = card.body.find((e) => e.type === "Input.Text");
    expect(input).toBeDefined();
    expect(input?.id).toBe(REPLY_INPUT_ID);
    expect(input?.value).toBe("Please try restarting"); // verbatim prefill (edit box, not Markdown)
    expect(input?.isMultiline).toBe(true);
    // No suggestion → no input field to edit.
    expect(buildEscalationCard(rec({ suggestedReply: undefined })).body.find((e) => e.type === "Input.Text")).toBeUndefined();
  });
  it("caps conversation history to the last MAX_HISTORY_TURNS (Kody perf)", () => {
    // Alphanumeric labels so sanitize doesn't escape them (a hyphen would become \-).
    const many = Array.from({ length: MAX_HISTORY_TURNS + 8 }, (_, i) => ({ role: "user", text: `t${i}z` }));
    const json = JSON.stringify(buildEscalationCard(rec({ conversationHistory: many })));
    expect(json).toContain(`t${MAX_HISTORY_TURNS + 7}z`); // last turn kept
    expect(json).not.toContain("t0z"); // earliest dropped by the cap
  });
});

describe("buildEscalationResolvedCard", () => {
  it("resolved/dismissed name the human; timed_out omits actions", () => {
    const r = buildEscalationResolvedCard(rec(), "resolved", { byName: "Ada" });
    expect(validateAdaptiveCard(r).ok).toBe(true);
    expect(r.actions).toBeUndefined();
    expect(JSON.stringify(r)).toContain("Resolved by Ada");
    expect(JSON.stringify(buildEscalationResolvedCard(rec(), "dismissed", { byName: "Bob" }))).toContain("Dismissed by Bob");
    expect(JSON.stringify(buildEscalationResolvedCard(rec(), "timed_out"))).toMatch(/Timed out/i);
  });
});

describe("expiredEscalations + timeoutMsFromMinutes", () => {
  const now = 10_000_000;
  it("only OPEN + past-timeout, skipping resolved AND already-deferred", () => {
    const records: EscalationRecord[] = [
      rec({ id: "old-open", status: "open", createdAtMs: now - 20 * 60_000 }),
      rec({ id: "fresh-open", status: "open", createdAtMs: now - 5 * 60_000 }),
      rec({ id: "old-resolved", status: "resolved", createdAtMs: now - 30 * 60_000 }),
      rec({ id: "old-deferred", status: "open", createdAtMs: now - 30 * 60_000, deferredAtMs: now - 10 * 60_000 }),
    ];
    expect(expiredEscalations(records, now, 15 * 60_000)).toEqual(["old-open"]);
  });
  it("timeoutMsFromMinutes guards invalid → 15m default", () => {
    expect(timeoutMsFromMinutes(30)).toBe(30 * 60_000);
    expect(timeoutMsFromMinutes(undefined)).toBe(15 * 60_000);
    expect(timeoutMsFromMinutes(0)).toBe(15 * 60_000);
    expect(timeoutMsFromMinutes(-5)).toBe(15 * 60_000);
  });
});
