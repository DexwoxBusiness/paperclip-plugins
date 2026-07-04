/**
 * Adapt raw Paperclip domain events into normalized {@link TeamsNotification}s
 * (PCLIP-18, v1). Kept SDK-decoupled (a minimal {@link RawPluginEvent} shape,
 * not the SDK's PluginEvent) so every mapping is unit-testable.
 *
 * Event names are verified against the Paperclip host (server plugin event bus):
 *   issue.created, agent.task_completed, approval.created, agent.run.failed,
 *   budget.soft_threshold_crossed, budget.hard_threshold_crossed.
 * Payload FIELD names are read defensively (several fallbacks) and confirmed
 * against live payloads on connect — same stance as the Plane plugin's adapters.
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

/**
 * Best-effort readable issue id (PROJ-123) from a variety of payload shapes.
 *
 * `entityFallback` is only safe for a true issue.* event, where `ev.entityId` IS
 * the issue. For a NESTED issue object inside another event (approval.created,
 * agent.run.failed), entityId is the approval/run id — an unrelated entity — so
 * those callers pass false and get `undefined` rather than a wrong id (Codex).
 */
function issueIdentifier(issue: Record<string, unknown>, ev: RawPluginEvent, entityFallback = false): string | undefined {
  const explicit = str(issue.identifier) ?? str(issue.readable_id);
  if (explicit) return explicit;
  const proj = str(issue.project__identifier) ?? str(issue.project_identifier);
  const seq = str(issue.sequence_id);
  if (proj && seq) return `${proj}-${seq}`;
  const id = str(issue.id);
  if (id) return id;
  return entityFallback ? str(ev.entityId) : undefined;
}

export function adaptIssueCreated(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const issue = obj(p.issue ?? p);
  const title = str(issue.name) ?? str(issue.title) ?? str(p.name);
  if (!title) return null;
  return {
    kind: "issue-created",
    title,
    // issue.created: ev.entityId IS the issue, so the entityId fallback is safe here.
    issueId: str(issue.id) ?? str(ev.entityId),
    issueIdentifier: issueIdentifier(issue, ev, true),
    projectName: str(issue.project_name) ?? str(p.projectName) ?? str(p.project_name),
  };
}

export function adaptIssueDone(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const issue = obj(p.issue ?? p);
  const title = str(issue.name) ?? str(issue.title) ?? str(p.title) ?? str(p.name);
  if (!title) return null;
  return {
    kind: "issue-done",
    title,
    // agent.task_completed: ev.entityId is the agent/task, NOT the issue — only the
    // nested issue.id is a safe deep-link target.
    issueId: str(issue.id),
    issueIdentifier: issueIdentifier(issue, ev),
    agentName: str(p.agentName) ?? str(p.agent_name) ?? str(obj(p.agent).name) ?? str(ev.actorId),
  };
}

export function adaptApprovalCreated(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const approval = obj(p.approval ?? p);
  const approvalId = str(approval.id) ?? str(ev.entityId);
  if (!approvalId) return null;
  const issue = obj(approval.issue ?? p.issue);
  return {
    kind: "approval",
    approvalId,
    title: str(approval.title) ?? str(approval.name) ?? str(p.title) ?? "Approval requested",
    requester: str(approval.requester) ?? str(approval.requested_by) ?? str(p.requester) ?? str(ev.actorId) ?? "unknown",
    budget: str(approval.budget) ?? str(p.budget) ?? str(approval.amount),
    // No `issueId` here on purpose: an approval card deep-links to /approvals/
    // {approvalId} (its own entity), not to an issue. We DO capture the linked
    // issue's readable identifier — buildDeepLink derives the company URL prefix
    // from it (PCLIP-20). issueTitle is display-only.
    issueIdentifier: Object.keys(issue).length ? issueIdentifier(issue, ev) : str(p.issueIdentifier),
    issueTitle: str(issue.name) ?? str(issue.title),
  };
}

export function adaptAgentError(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const error = str(p.error) ?? str(p.message) ?? str(obj(p.error).message);
  if (!error) return null;
  const issue = obj(p.issue);
  return {
    kind: "agent-error",
    error,
    agentName: str(p.agentName) ?? str(p.agent_name) ?? str(obj(p.agent).name) ?? str(ev.actorId),
    // agent.run.failed: ev.entityId may be the run id, so take the agent id only
    // from the payload (not entityId). Link falls back to the issue when present.
    agentId: str(obj(p.agent).id) ?? str(p.agentId) ?? str(p.agent_id),
    issueId: str(issue.id),
    issueIdentifier: Object.keys(issue).length ? issueIdentifier(issue, ev) : str(p.issueIdentifier),
  };
}

/**
 * Snap a crossed budget event to a discrete threshold (80/90/100). Prefer an
 * explicit threshold/percent field; otherwise derive it from spent/limit and map
 * to the highest configured threshold at or below the computed percentage — so
 * dedupe keys are stable regardless of the exact percent in the payload.
 */
export function adaptBudgetThreshold(ev: RawPluginEvent): TeamsNotification | null {
  const p = obj(ev.payload);
  const budget = obj(p.budget ?? p);
  const budgetId = str(budget.id) ?? str(p.budgetId) ?? str(p.budget_id) ?? str(ev.entityId);
  if (!budgetId) return null;

  const spentNum = Number(p.spent ?? p.used ?? budget.spent);
  const limitNum = Number(p.limit ?? p.budget_limit ?? budget.limit);
  let threshold = Number(p.threshold ?? p.percent ?? p.thresholdPercent);
  if (!Number.isFinite(threshold)) {
    if (!Number.isFinite(spentNum) || !Number.isFinite(limitNum) || limitNum <= 0) return null;
    const pct = (spentNum / limitNum) * 100;
    const matched = [...BUDGET_THRESHOLDS].filter((t) => pct >= t).pop();
    if (matched === undefined) return null;
    threshold = matched;
  }
  return {
    kind: "budget-threshold",
    budgetId,
    threshold,
    budgetName: str(budget.name) ?? str(p.budgetName),
    spent: str(p.spent) ?? str(budget.spent),
    limit: str(p.limit) ?? str(budget.limit),
  };
}
