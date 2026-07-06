/**
 * HITL escalation channel with suggested replies (PCLIP-28 / T11) — pure, SDK-decoupled logic.
 *
 * A stuck agent calls the `escalate_to_human` tool; the plugin posts an Adaptive Card to a
 * dedicated Teams conversation with the conversation history, the agent's reasoning, and its
 * confidence, plus a "Use suggested reply" button. Clicking it wakes the escalating agent via
 * `ctx.agents.invoke` with the reply (Teams has no ACP session bridge, unlike Slack). If no
 * human acts within the timeout, a background job applies the default action (defer/dismiss).
 *
 * This module holds the pure pieces (record shape, cards, submit parsing, timeout decision);
 * the worker owns the tool registration, proactive post, agents.invoke, state, and the job.
 */

import { adaptiveCard, factSet, inputText, submitAction, textBlock, type AdaptiveCard, type CardAction } from "./adaptive-card.js";

/**
 * Id of the editable reply field on the escalation card. Teams returns its value in the submit
 * activity's `value` bag under this key (merged with the Action.Submit `data`), so the human can
 * EDIT the agent's suggested reply before sending it back (PCLIP-28 / T11).
 */
export const REPLY_INPUT_ID = "escalationReplyText";

export type EscalationStatus = "open" | "resolved" | "dismissed" | "timed_out";
export type EscalationDefaultAction = "defer" | "dismiss";
/** A human action on an escalation card. */
export type EscalationAction = "reply" | "dismiss";

/** One turn of conversation context supplied by the escalating agent. */
export interface ConversationTurn {
  role: string;
  text: string;
}

/** The escalation record persisted in company-scoped plugin state. */
export interface EscalationRecord {
  id: string;
  /** The escalating agent (from ToolRunContext) — the reply-back target for ctx.agents.invoke. */
  agentId: string;
  /** Company that owns the escalating run — required by ctx.agents.invoke. */
  companyId: string;
  reason: string;
  /** Agent confidence in [0,1] (rendered as a percentage), when provided. */
  confidence?: number;
  agentName?: string;
  agentReasoning?: string;
  suggestedReply?: string;
  conversationHistory?: ConversationTurn[];
  status: EscalationStatus;
  /** Epoch ms of creation — the timeout clock. */
  createdAtMs: number;
  resolvedAtMs?: number;
  /** Who/what resolved it: `teams:{aadObjectId}` or `system:timeout`. */
  resolvedBy?: string;
  /**
   * Epoch ms the escalation was DEFERRED at timeout (default action = "defer"). Set means the
   * sweep already handled it once and left it OPEN + actionable — the sweep skips it thereafter
   * (no re-fire), but a human can still click "Use suggested reply". "dismiss" CLOSES instead.
   */
  deferredAtMs?: number;
}

/** Caps so an agent-supplied escalation can't build an oversized card / bloat state (Kody). */
export const MAX_HISTORY_TURNS = 10;
export const MAX_TEXT_LEN = 2000;

// Built from strings so the SOURCE stays ASCII (no literal control / zero-width bytes).
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");
const MARKDOWN_CHARS = /[\\`*_{}[\]()#+\-!<>|~]/g;
const ZERO_WIDTH = "​";
const ELLIPSIS = "…";

/**
 * Neutralize agent/user-supplied text before it enters a human-facing Adaptive Card TextBlock
 * (Kody security): TextBlocks render a Markdown subset, so untrusted text could inject links,
 * emphasis, or @mentions into the escalation channel. Escape the Markdown-significant chars,
 * strip control chars, defuse `@`-mentions with a zero-width break, and cap the length.
 */
export function sanitizeCardText(text: string | undefined, maxLen = MAX_TEXT_LEN): string {
  if (typeof text !== "string" || !text) return "";
  const escaped = text
    .replace(CONTROL_CHARS, " ")
    .replace(MARKDOWN_CHARS, (c) => `\\${c}`)
    .replace(/@/g, `@${ZERO_WIDTH}`);
  return escaped.length > maxLen ? `${escaped.slice(0, maxLen - 1)}${ELLIPSIS}` : escaped;
}

// --------------------------------------------------------------------------
// Action.Submit payload
// --------------------------------------------------------------------------

export interface EscalationSubmitData {
  pcAction: "escalation";
  escalationId: string;
  action: EscalationAction;
  // Action.Submit `data` is an open bag; index signature keeps it assignable to the
  // adaptive-card action's Record<string, unknown> without a cast.
  [key: string]: unknown;
}

function submitData(escalationId: string, action: EscalationAction): EscalationSubmitData {
  return { pcAction: "escalation", escalationId, action };
}

/**
 * Parse an inbound Action.Submit value into an escalation action, or null when the activity
 * is not one of our escalation submits (so the worker ignores other messages). On a "reply"
 * submit, `replyText` carries the human's (possibly edited) reply from the Input.Text field —
 * trimmed, and undefined when the field is absent/blank so the worker can fall back to the
 * agent's suggestedReply.
 */
export function parseEscalationSubmit(
  value: unknown,
): { escalationId: string; action: EscalationAction; replyText?: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.pcAction !== "escalation") return null;
  const escalationId = typeof v.escalationId === "string" ? v.escalationId.trim() : "";
  const action = v.action;
  if (!escalationId || (action !== "reply" && action !== "dismiss")) return null;
  const rawReply = typeof v[REPLY_INPUT_ID] === "string" ? (v[REPLY_INPUT_ID] as string).trim() : "";
  return { escalationId, action, replyText: rawReply || undefined };
}

/**
 * Decide the text to send back to the escalating agent on a "reply": the human's edited
 * `replyText` wins; a blank field falls back to the agent's `suggestedReply`. Returns null when
 * there is nothing to send (both empty) so the worker can re-open rather than resolve on an empty
 * prompt. Pure so the "human edit vs. fallback vs. nothing" decision is unit-tested (PCLIP-28).
 */
export function resolveEscalationReply(replyText: string | undefined, suggestedReply: string | undefined): string | null {
  const reply = (replyText ?? "").trim() || (suggestedReply ?? "").trim();
  return reply || null;
}

// --------------------------------------------------------------------------
// Cards
// --------------------------------------------------------------------------

/** Format a [0,1] confidence as a percentage string, or "" when absent/invalid. */
export function formatConfidence(confidence: number | undefined): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "";
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * The open escalation card: reason, confidence, agent reasoning, conversation history, and the
 * "Use suggested reply" (only when a suggestedReply exists) + "Dismiss" buttons (AC #1). All
 * agent-supplied text is sanitized (Kody) and length-capped (Kody perf) before rendering.
 */
export function buildEscalationCard(record: EscalationRecord): AdaptiveCard {
  const body = [
    textBlock("🚨 Agent needs help", { size: "Large", weight: "Bolder" }),
    textBlock(sanitizeCardText(record.reason), { weight: "Bolder", wrap: true }),
    factSet([
      { title: "Agent", value: sanitizeCardText(record.agentName ?? "", 120) },
      { title: "Confidence", value: formatConfidence(record.confidence) },
    ]),
    ...(record.agentReasoning
      ? [textBlock("Agent reasoning", { weight: "Bolder", spacing: "Medium" }), textBlock(sanitizeCardText(record.agentReasoning), { wrap: true, isSubtle: true })]
      : []),
    ...renderHistory(record.conversationHistory),
    ...(record.suggestedReply
      ? [
          textBlock("Reply to send back (edit before sending)", { weight: "Bolder", spacing: "Medium" }),
          // Editable field prefilled with the agent's suggestion. Its value is NOT Markdown-rendered
          // (it's an edit box), so prefill verbatim, only length-bounded — the human owns this text.
          inputText(REPLY_INPUT_ID, {
            value: record.suggestedReply.slice(0, MAX_TEXT_LEN),
            isMultiline: true,
            maxLength: MAX_TEXT_LEN,
            placeholder: "Edit the reply, or send as-is",
          }),
        ]
      : []),
  ];
  const actions: CardAction[] = [
    // "Send reply" submits the (possibly edited) Input.Text value alongside the action data.
    ...(record.suggestedReply ? [submitAction("Send reply", submitData(record.id, "reply"))] : []),
    submitAction("Dismiss", submitData(record.id, "dismiss")),
  ];
  return adaptiveCard(body, actions);
}

function renderHistory(history: ConversationTurn[] | undefined) {
  if (!history || history.length === 0) return [];
  // Cap to the last N turns so a long transcript can't build an oversized card (Kody perf).
  const turns = history.slice(-MAX_HISTORY_TURNS);
  return [
    textBlock("Conversation", { weight: "Bolder", spacing: "Medium" }),
    ...turns.map((t) => textBlock(`**${sanitizeCardText(t.role, 60)}:** ${sanitizeCardText(t.text)}`, { wrap: true, isSubtle: true })),
  ];
}

/**
 * The resolved/dismissed/timed-out card, with the actions removed. `byName` names the human
 * for a reply/dismiss; timeouts read "timed out". The reason is sanitized (agent-supplied).
 */
export function buildEscalationResolvedCard(record: EscalationRecord, status: Exclude<EscalationStatus, "open">, opts: { byName?: string } = {}): AdaptiveCard {
  const label =
    status === "resolved" ? "✅ Resolved" : status === "dismissed" ? "🚫 Dismissed" : "⏰ Timed out — default action applied";
  const by = opts.byName ? ` by ${opts.byName}` : "";
  return adaptiveCard([
    textBlock(`${label}${status === "timed_out" ? "" : by}`, { size: "Medium", weight: "Bolder", color: status === "resolved" ? "Good" : "Attention" }),
    textBlock(sanitizeCardText(record.reason), { isSubtle: true, wrap: true }),
  ]);
}

// --------------------------------------------------------------------------
// Timeout decision (pure)
// --------------------------------------------------------------------------

/**
 * Given the current open escalation records, return the ids that have exceeded `timeoutMs` and
 * should get the default action. Skips non-open records (idempotent) AND already-DEFERRED ones
 * (`deferredAtMs` set) so a deferred escalation isn't re-processed every sweep tick.
 */
export function expiredEscalations(records: EscalationRecord[], nowMs: number, timeoutMs: number): string[] {
  return records
    .filter((r) => r.status === "open" && r.deferredAtMs == null && Number.isFinite(r.createdAtMs) && nowMs - r.createdAtMs >= timeoutMs)
    .map((r) => r.id);
}

/** Convert a configured minutes value (default 15) to ms, guarding non-positive/invalid input. */
export function timeoutMsFromMinutes(minutes: number | undefined, fallbackMinutes = 15): number {
  const m = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes;
  return m * 60_000;
}
