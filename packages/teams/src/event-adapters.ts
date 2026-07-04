/**
 * Adapt raw Paperclip domain events into normalized {@link TeamsNotification}s
 * (PCLIP-18, v1). Kept SDK-decoupled (a minimal {@link RawPluginEvent} shape) so
 * every mapping is unit-testable.
 *
 * Event names + payloads VERIFIED against the host (server plugin event bus is fed
 * from activity-log.ts; catalog = PLUGIN_EVENT_TYPES in packages/shared/constants):
 *  - issue.created        details { title, identifier, ... }; entityId = issue id
 *  - issue.updated        details { status, identifier, _previous?{status} }; used
 *                         for "issue done" (status === "done" transition)
 *  - agent.run.finished   payload { agentId, issueId, status } (digest completion)
 *  - agent.run.failed     payload { agentId, issueId, error, errorCode }
 *  - approval.created     details { type, issueIds } (NO requester/budget/title —
 *                         requester approximated from actorId; host gap tracked upstream)
 *  - budget.incident.opened  details { scopeType, scopeId, amountObserved, amountLimit }
 *                         (soft AND hard both map here; % derived from the amounts)
 *  - cost_event.created   declared but NOT currently emitted by the host (cost logs
 *                         `cost.reported`, unmapped) — subscription kept for when the
 *                         upstream gap is fixed; until then the digest cost is $0.
 */

import { BUDGET_THRESHOLDS } from "./constants.js";
import type { TeamsNotification } from "./notifications.js";

/** Minimal event shape (the SDK PluginEvent is structurally compatible). */
export interface RawPluginEvent {
  entityId?: string;
  actorId?: string;
  actorType?: string;
  payload?: unknown;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** issue.created — details carry title + identifier at the top level; id is entityId. */
export function adaptIssueCreated(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const title = str(p.title) ?? str(p.name);
  if (!title) return null;
  return {
    kind: "issue-created",
    title,
    issueId: str(p.id) ?? str(ev.entityId),
    issueIdentifier: str(p.identifier),
    projectName: str(p.project_name) ?? str(p.projectName),
  };
}

/**
 * issue.updated → "issue done" only on a real transition INTO the done state
 * (status === "done" and the previous status, when present, was not done). This
 * avoids a card on every subsequent update of an already-done issue. issue.updated
 * details carry `status` + `identifier` (no title), so the card shows the readable id.
 */
export function adaptIssueDone(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  if (str(p.status) !== "done") return null;
  const prev = obj(p._previous);
  if (str(prev.status) === "done") return null;
  const identifier = str(p.identifier);
  return {
    kind: "issue-done",
    title: str(p.title) ?? identifier ?? "Issue completed",
    issueId: str(ev.entityId),
    issueIdentifier: identifier,
    agentName: str(p.assigneeAgentId) ?? str(ev.actorId),
  };
}

/**
 * approval.created — details are only { type, issueIds }. The host payload does NOT
 * carry the requester/budget/title, so requester is approximated from the actor and
 * budget/title are unavailable (tracked as an upstream enrichment gap). The card
 * degrades gracefully (empty fields are dropped).
 */
export function adaptApprovalCreated(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const approvalId = str(p.id) ?? str(ev.entityId);
  if (!approvalId) return null;
  const issueIds = Array.isArray(p.issueIds) ? p.issueIds.map((i) => String(i)) : [];
  const type = str(p.type);
  return {
    kind: "approval",
    approvalId,
    title: type ? `${type} approval` : "Approval requested",
    requester: str(ev.actorId) ?? "unknown",
    budget: str(p.budget), // not in the host payload today (upstream gap)
    issueIdentifier: issueIds[0], // an issue UUID (no readable id in the payload)
  };
}

/** agent.run.failed — flat payload { agentId, issueId, error, errorCode }; actorId = agentId. */
export function adaptAgentError(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const error = str(p.error) ?? str(p.errorCode);
  if (!error) return null;
  return {
    kind: "agent-error",
    error,
    agentName: str(p.agentName) ?? str(p.agentId) ?? str(ev.actorId),
    agentId: str(p.agentId) ?? str(ev.actorId),
    issueId: str(p.issueId),
    issueIdentifier: str(p.issueIdentifier),
  };
}

/**
 * budget.incident.opened — soft AND hard threshold crossings both arrive here.
 * Derive the discrete 80/90/100 threshold from amountObserved/amountLimit and key
 * dedupe on the budget scope. Details: { scopeType, scopeId, amountObserved, amountLimit }.
 */
export function adaptBudgetThreshold(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const budgetId = str(p.scopeId) ?? str(p.budgetId) ?? str(ev.entityId);
  if (!budgetId) return null;

  const spentNum = num(p.amountObserved) ?? num(p.spent);
  const limitNum = num(p.amountLimit) ?? num(p.limit);
  let threshold = num(p.threshold) ?? num(p.percent);
  if (threshold === undefined) {
    if (spentNum === undefined || limitNum === undefined || limitNum <= 0) return null;
    const pct = (spentNum / limitNum) * 100;
    const matched = [...BUDGET_THRESHOLDS].filter((t) => pct >= t).pop();
    if (matched === undefined) return null;
    threshold = matched;
  }
  return {
    kind: "budget-threshold",
    budgetId,
    threshold,
    budgetName: str(p.scopeType) ?? str(p.budgetName),
    spent: spentNum !== undefined ? String(spentNum) : undefined,
    limit: limitNum !== undefined ? String(limitNum) : undefined,
  };
}

/** Agent that completed a run (agent.run.finished) — for the digest tally. */
export function extractCompletedAgent(ev: RawPluginEvent): string | undefined {
  const p = obj(ev.payload);
  return str(p.agentId) ?? str(ev.actorId);
}

/**
 * Cost of a `cost_event.created` event, in CENTS. NOTE: the host does not currently
 * emit this plugin event (cost is logged as `cost.reported`, which maps to nothing),
 * so this is presently never called — kept for when the upstream gap is fixed.
 * Host cost detail shape is { costCents, model }.
 */
export function extractCostCents(ev: RawPluginEvent): number | undefined {
  const p = obj(ev.payload);
  const cost = obj(p.cost ?? p.cost_event ?? p);
  const cents = num(p.costCents) ?? num(p.cost_cents) ?? num(cost.costCents) ?? num(cost.cost_cents);
  if (cents !== undefined) return cents;
  const dollars = num(p.amount) ?? num(cost.amount) ?? num(p.cost);
  return dollars !== undefined ? Math.round(dollars * 100) : undefined;
}
