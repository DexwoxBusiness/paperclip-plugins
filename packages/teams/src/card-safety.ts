/**
 * Shared Adaptive Card text safety (PCLIP-43 / T12). These sanitizers are card-generic, not tied
 * to any one feature — the escalation flow (PCLIP-28) introduced them locally and the ask surface
 * reuses them, so they live here as the canonical home. (A trivial follow-up points escalation.ts
 * at this module once PCLIP-28 merges, to remove the temporary duplication.)
 *
 * Two distinct sanitizers for two distinct sinks:
 *  - `sanitizeCardText`  — for text rendered in a TextBlock (Teams renders a Markdown subset), so
 *    untrusted text is Markdown-escaped, control-stripped, @-defused, and length-capped.
 *  - `sanitizeInputPrefill` — for the *value* prefilled into an Input.Text edit box, which is NOT
 *    Markdown-rendered and is round-tripped verbatim into what the human sends: only the genuinely
 *    unsafe C0 controls + DEL are stripped (tab/newline KEPT for multiline), and it is length-bound;
 *    it is deliberately NOT Markdown-escaped (that would inject backslashes into the human's text).
 */

/** Default per-field length cap so one agent-supplied field can't build an oversized card. */
export const MAX_TEXT_LEN = 2000;

// Built from strings so the SOURCE stays ASCII (no literal control / zero-width bytes).
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
// C0 controls + DEL but KEEP tab (U+0009) and newline (U+000A) — legitimate in a multiline input.
const INPUT_UNSAFE_CHARS = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F]", "g");
const MARKDOWN_CHARS = /[\\`*_{}[\]()#+\-!<>|~]/g;
const ZERO_WIDTH = "​"; // U+200B
const ELLIPSIS = "…";

/** Neutralize untrusted text for a Markdown-rendering TextBlock: escape Markdown, strip control
 * chars, defuse `@`-mentions with a zero-width break, and cap the length. */
export function sanitizeCardText(text: string | undefined, maxLen = MAX_TEXT_LEN): string {
  if (typeof text !== "string" || !text) return "";
  const escaped = text
    .replace(CONTROL_CHARS, " ")
    .replace(MARKDOWN_CHARS, (c) => `\\${c}`)
    .replace(/@/g, `@${ZERO_WIDTH}`);
  return escaped.length > maxLen ? `${escaped.slice(0, maxLen - 1)}${ELLIPSIS}` : escaped;
}

/** Sanitize a value prefilled into an Input.Text edit box: strip unsafe C0 controls + DEL (keep
 * tab/newline for multiline), length-bound, and do NOT Markdown-escape (round-tripped verbatim). */
export function sanitizeInputPrefill(text: string | undefined, maxLen = MAX_TEXT_LEN): string {
  if (typeof text !== "string" || !text) return "";
  const cleaned = text.replace(INPUT_UNSAFE_CHARS, "");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}
