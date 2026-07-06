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

import { adaptiveCard, factSet, submitAction, textBlock, type AdaptiveCard, type CardAction } from "./adaptive-card.js";

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
 * is not one of our escalation submits (so the worker ignores other messages).
 */
export function parseEscalationSubmit(value: unknown): { escalationId: string; action: EscalationAction } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.pcAction !== "escalation") return null;
  const escalationId = typeof v.escalationId === "string" ? v.escalationId.trim() : "";
  const action = v.action;
  if (!escalationId || (action !== "reply" && action !== "dismiss")) return null;
  return { escalationId, action };
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
 * "Use suggested reply" (only when a suggestedReply exists) + "Dismiss" buttons (AC #1).
 */
export function buildEscalationCard(record: EscalationRecord): AdaptiveCard {
  const body = [
    textBlock("🚨 Agent needs help", { size: "Large", weight: "Bolder" }),
    textBlock(record.reason, { weight: "Bolder", wrap: true }),
    factSet([
      { title: "Agent", value: record.agentName ?? "" },
      { title: "Confidence", value: formatConfidence(record.confidence) },
    ]),
    ...(record.agentReasoning
      ? [textBlock("Agent reasoning", { weight: "Bolder", spacing: "Medium" }), textBlock(record.agentReasoning, { wrap: true, isSubtle: true })]
      : []),
    ...renderHistory(record.conversationHistory),
    ...(record.suggestedReply
      ? [textBlock("Suggested reply", { weight: "Bolder", spacing: "Medium" }), textBlock(record.suggestedReply, { wrap: true })]
      : []),
  ];
  const actions: CardAction[] = [
    ...(record.suggestedReply ? [submitAction("Use suggested reply", submitData(record.id, "reply"))] : []),
    submitAction("Dismiss", submitData(record.id, "dismiss")),
  ];
  return adaptiveCard(body, actions);
}

function renderHistory(history: ConversationTurn[] | undefined) {
  if (!history || history.length === 0) return [];
  return [
    textBlock("Conversation", { weight: "Bolder", spacing: "Medium" }),
    ...history.map((t) => textBlock(`**${t.role}:** ${t.text}`, { wrap: true, isSubtle: true })),
  ];
}

/**
 * The resolved/dismissed/timed-out card, with the actions removed. `byName` names the human
 * for a reply/dismiss; timeouts read "timed out".
 */
export function buildEscalationResolvedCard(record: EscalationRecord, status: Exclude<EscalationStatus, "open">, opts: { byName?: string } = {}): AdaptiveCard {
  const label =
    status === "resolved" ? "✅ Resolved" : status === "dismissed" ? "🚫 Dismissed" : "⏰ Timed out — default action applied";
  const by = opts.byName ? ` by ${opts.byName}` : "";
  return adaptiveCard([
    textBlock(`${label}${status === "timed_out" ? "" : by}`, { size: "Medium", weight: "Bolder", color: status === "resolved" ? "Good" : "Attention" }),
    textBlock(record.reason, { isSubtle: true, wrap: true }),
  ]);
}

// --------------------------------------------------------------------------
// Timeout decision (pure)
// --------------------------------------------------------------------------

/**
 * Given the current open escalation records, return the ids that have exceeded `timeoutMs`
 * (and are still open) and should get the default action. Non-open records are skipped
 * (idempotent — a resolved/dismissed record is never timed out).
 */
export function expiredEscalations(records: EscalationRecord[], nowMs: number, timeoutMs: number): string[] {
  return records
    .filter((r) => r.status === "open" && Number.isFinite(r.createdAtMs) && nowMs - r.createdAtMs >= timeoutMs)
    .map((r) => r.id);
}

/** Convert a configured minutes value (default 15) to ms, guarding non-positive/invalid input. */
export function timeoutMsFromMinutes(minutes: number | undefined, fallbackMinutes = 15): number {
  const m = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes;
  return m * 60_000;
}
