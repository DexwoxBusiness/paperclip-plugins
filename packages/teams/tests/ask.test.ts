import { describe, expect, it } from "vitest";
import {
  ASK_DEFAULT_FIELD_ID,
  buildAskAnsweredCard,
  buildAskCancelledCard,
  buildAskCard,
  effectiveFields,
  formatAskResponse,
  parseAskSubmit,
  type AskRequest,
} from "../src/ask.js";
import { validateAdaptiveCard } from "../src/adaptive-card.js";

function req(over: Partial<AskRequest> = {}): AskRequest {
  return {
    id: "ask-1",
    personRef: "teams:29:abc",
    agentId: "agent-1",
    companyId: "co-1",
    prompt: "What did you get done yesterday?",
    correlationId: "plane:PCLIP-43",
    status: "open",
    createdAtMs: 1_000,
    ...over,
  };
}

describe("effectiveFields", () => {
  it("defaults to a single multiline answer field when none supplied", () => {
    expect(effectiveFields({ fields: undefined })).toEqual([{ id: ASK_DEFAULT_FIELD_ID, label: "Your answer", multiline: true }]);
  });
  it("keeps supplied fields, drops id-less ones, and caps to MAX_ASK_FIELDS", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, label: `Q${i}` }));
    const out = effectiveFields({ fields: [{ id: "", label: "bad" }, ...many] });
    expect(out).toHaveLength(8);
    expect(out[0].id).toBe("q0");
  });
});

describe("buildAskCard", () => {
  it("renders prompt + a default answer input + a Send button; valid card", () => {
    const card = buildAskCard(req());
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    const input = card.body.find((e) => e.type === "Input.Text");
    expect(input?.id).toBe(`f_${ASK_DEFAULT_FIELD_ID}`);
    expect(input?.isMultiline).toBe(true);
    expect((card.actions ?? []).map((a) => a.title)).toEqual(["Send"]);
    expect(JSON.stringify(card)).toContain("What did you get done yesterday?");
  });
  it("renders one labeled input per supplied field, prefills control-safe", () => {
    const card = buildAskCard(req({ fields: [{ id: "blockers", label: "Blockers", prefill: `none${String.fromCharCode(0)}` }] }));
    expect(validateAdaptiveCard(card).ok).toBe(true);
    const input = card.body.find((e) => e.type === "Input.Text");
    expect(input?.id).toBe("f_blockers");
    expect(input?.value).toBe("none"); // NUL stripped, not Markdown-escaped
  });
  it("sanitizes a Markdown-injecting prompt", () => {
    const json = JSON.stringify(buildAskCard(req({ prompt: "click [here](http://evil)" })));
    expect(json).not.toContain("[here](http://evil)");
    expect(json).toContain("\\[");
  });
});

describe("parseAskSubmit", () => {
  it("extracts requestId + trimmed field values (f_ prefix stripped)", () => {
    expect(parseAskSubmit({ pcAction: "ask", requestId: "ask-1", f_answer: "  did the thing  ", f_blockers: "none" }))
      .toEqual({ requestId: "ask-1", values: { answer: "did the thing", blockers: "none" } });
  });
  it("ignores non-ask submits and missing requestId", () => {
    expect(parseAskSubmit({ pcAction: "escalation", requestId: "x", f_answer: "y" })).toBeNull();
    expect(parseAskSubmit({ pcAction: "ask", requestId: "", f_answer: "y" })).toBeNull();
    expect(parseAskSubmit(undefined)).toBeNull();
  });
  it("returns null when no field carried a non-empty value (nothing to route back)", () => {
    expect(parseAskSubmit({ pcAction: "ask", requestId: "ask-1", f_answer: "   " })).toBeNull();
    expect(parseAskSubmit({ pcAction: "ask", requestId: "ask-1" })).toBeNull();
  });
});

describe("formatAskResponse", () => {
  it("single default answer → just the value", () => {
    expect(formatAskResponse(req(), { answer: "shipped the parser" })).toBe("shipped the parser");
  });
  it("multiple fields → label: value lines (label falls back to id)", () => {
    const r = req({ fields: [{ id: "done", label: "Done" }, { id: "next", label: "Next" }] });
    expect(formatAskResponse(r, { done: "A", next: "B" })).toBe("Done: A\nNext: B");
  });
  it("sanitizes response values so a reply can't inject Markdown into the agent prompt", () => {
    expect(formatAskResponse(req(), { answer: "see [x](y)" })).toContain("\\[");
  });
});

describe("answered / cancelled cards", () => {
  it("answered card names the human (sanitized) and drops actions", () => {
    const card = buildAskAnsweredCard(req(), { byName: "[Ann](evil)" });
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect(card.actions).toBeUndefined();
    expect(JSON.stringify(card)).toContain("\\[");
  });
  it("cancelled card is valid and action-less", () => {
    const card = buildAskCancelledCard(req());
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect(card.actions).toBeUndefined();
  });
});
