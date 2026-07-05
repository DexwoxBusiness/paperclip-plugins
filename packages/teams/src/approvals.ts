/**
 * Interactive approvals (PCLIP-24 / T7) — pure, SDK-decoupled logic.
 *
 * Built ENTIRELY as a plugin (no Paperclip changes), mirroring paperclip-plugin-discord:
 *   - Approve/Reject are Action.Submit buttons (a click posts a bot activity the plugin
 *     handles; no synchronous invoke-response contract — the host webhook returns a fixed
 *     200/502 envelope and can't carry an invoke response).
 *   - The decision calls the Paperclip approval REST API (POST /api/approvals/{id}/approve
 *     |reject) with the board API key, exactly like the Discord plugin.
 *   - The in-place refresh is EVENT-DRIVEN: on the approval.decided event the worker edits
 *     the original card via the Bot Connector (updateActivity) — the analog of Discord's
 *     editMessage. Governance/idempotency stay server-side.
 *
 * This module holds the pure pieces (cards, submit parsing, actor mapping, REST client);
 * the worker owns the activity subscription, state, and updateActivity call.
 */

import { adaptiveCard, factSet, openUrlAction, submitAction, textBlock, type AdaptiveCard } from "./adaptive-card.js";

export type ApprovalVerb = "approve" | "reject";

/** The `data` payload carried by an approval Action.Submit button. */
export interface ApprovalSubmitData {
  /** Namespaced so we can tell approval submits apart from other Action.Submit cards. */
  pcAction: "approval";
  verb: ApprovalVerb;
  approvalId: string;
  // Action.Submit `data` is an open bag; index signature keeps it assignable to the
  // adaptive-card action's Record<string, unknown> without a cast.
  [key: string]: unknown;
}

/** Map a Teams user's Entra object id to the Paperclip actor id (parity with discord:{user}). */
export function teamsActor(aadObjectId?: string | null): string {
  const id = typeof aadObjectId === "string" ? aadObjectId.trim() : "";
  return `teams:${id || "unknown"}`;
}

// --------------------------------------------------------------------------
// Cards
// --------------------------------------------------------------------------

export interface ApprovalCardInput {
  approvalId: string;
  title?: string;
  requester?: string;
  issueIdentifier?: string;
  /** Optional deep link to the approval in Paperclip. */
  link?: string;
}

/** The pending approval card with Approve/Reject (Action.Submit) + optional View link. */
export function buildApprovalCard(input: ApprovalCardInput): AdaptiveCard {
  const body = [
    textBlock("🔔 Approval requested", { size: "Large", weight: "Bolder" }),
    ...(input.title ? [textBlock(input.title, { weight: "Bolder", size: "Medium" })] : []),
    factSet([
      { title: "Requester", value: input.requester ?? "" },
      { title: "Issue", value: input.issueIdentifier ?? "" },
    ]),
  ];
  const actions = [
    submitAction("Approve", submitData("approve", input.approvalId)),
    submitAction("Reject", submitData("reject", input.approvalId)),
    ...(input.link ? [openUrlAction("View", input.link)] : []),
  ];
  return adaptiveCard(body, actions);
}

function submitData(verb: ApprovalVerb, approvalId: string): ApprovalSubmitData {
  return { pcAction: "approval", verb, approvalId };
}

/** The decided card (Approved/Rejected by {name}), with the actions REMOVED. */
export function buildDecidedCard(verb: ApprovalVerb, opts: { title?: string; byName?: string } = {}): AdaptiveCard {
  const decided = verb === "approve" ? "Approved" : "Rejected";
  const emoji = verb === "approve" ? "✅" : "❌";
  const by = opts.byName ? ` by ${opts.byName}` : "";
  return adaptiveCard([
    textBlock(`${emoji} ${decided}${by}`, { size: "Large", weight: "Bolder", color: verb === "approve" ? "Good" : "Attention" }),
    ...(opts.title ? [textBlock(opts.title, { isSubtle: true })] : []),
  ]);
}

/**
 * The pending card with an error banner, KEEPING the actions so the user can retry
 * (AC #5). Re-uses the approval card and prepends the failure notice.
 */
export function buildApprovalErrorCard(input: ApprovalCardInput, error: string): AdaptiveCard {
  const base = buildApprovalCard(input);
  base.body = [textBlock(`⚠️ Couldn't record your decision — ${error}. Please try again.`, { wrap: true, color: "Attention" }), ...base.body];
  return base;
}

// --------------------------------------------------------------------------
// Submit parsing
// --------------------------------------------------------------------------

/**
 * Parse an inbound Action.Submit value into a normalized decision, or null when the
 * activity is not one of our approval submits (so the worker ignores other messages).
 */
export function parseApprovalSubmit(value: unknown): { verb: ApprovalVerb; approvalId: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.pcAction !== "approval") return null;
  const verb = v.verb;
  const approvalId = typeof v.approvalId === "string" ? v.approvalId.trim() : "";
  if ((verb !== "approve" && verb !== "reject") || !approvalId) return null;
  return { verb, approvalId };
}

// --------------------------------------------------------------------------
// approval.decided event → decision (for the event-driven refresh)
// --------------------------------------------------------------------------

/** Minimal shape of the approval.decided plugin event we read. */
export interface ApprovalDecidedEvent {
  entityId?: string;
  actorId?: string;
  payload?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Extract the approval id + decider from an approval.decided event.
 *
 * VERIFIED (activity-log.ts): approval.approved AND approval.rejected both map to the
 * single `approval.decided` plugin event, whose payload is the activity details
 * ({ type, requestedByAgentId, linkedIssueIds }) — it does NOT carry the outcome. So the
 * VERB is NOT derivable from the event; the caller must read it via {@link ApprovalsClient.getStatus}.
 * The decider is the event's top-level `actorId` (the board identity, not the Teams user).
 */
export function extractDecidedApprovalRef(ev: ApprovalDecidedEvent): { approvalId: string; decidedBy?: string } | null {
  const p = (ev.payload && typeof ev.payload === "object" ? ev.payload : {}) as Record<string, unknown>;
  const approvalId = str(p.approvalId) ?? str(ev.entityId);
  if (!approvalId) return null;
  return { approvalId, decidedBy: str(ev.actorId) ?? str(p.decidedByUserId) };
}

/** Map an approval record `status` string to the decision verb, or null if not yet decided. */
export function verbFromStatus(status: unknown): ApprovalVerb | null {
  const s = str(status)?.toLowerCase() ?? "";
  if (s.startsWith("approv")) return "approve";
  if (s.startsWith("reject")) return "reject";
  return null;
}

// --------------------------------------------------------------------------
// Approval REST client (over an injected fetch — no SDK dependency)
// --------------------------------------------------------------------------

export interface ApprovalFetchResponse {
  status: number;
  text(): Promise<string>;
}
export type ApprovalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<ApprovalFetchResponse>;

export interface ApprovalsClientDeps {
  baseUrl: string;
  /** Board API key for authenticated deployments; omit for local_trusted. */
  apiKey?: string;
  fetchFn: ApprovalFetch;
}

export interface ApprovalDecisionResult {
  ok: boolean;
  status: number;
  /** The approval's ACTUAL decision from the response record (may differ from the
   *  click when it was already decided elsewhere — idempotent case). */
  verb?: ApprovalVerb;
  /** The decider recorded on the approval record (board identity today). */
  decidedBy?: string;
  error?: string;
}

export interface ApprovalStatusResult {
  ok: boolean;
  status: number;
  /** Decision verb derived from the approval's status, when decided. */
  verb?: ApprovalVerb;
  /** The decider recorded on the approval record. */
  decidedBy?: string;
  error?: string;
}

/** Parse an approval record body → its actual decision verb + decider. Never throws. */
function parseApprovalRecord(text: string): { verb?: ApprovalVerb; decidedBy?: string } {
  try {
    const r = JSON.parse(text) as { status?: unknown; decidedByUserId?: unknown };
    return { verb: verbFromStatus(r.status) ?? undefined, decidedBy: str(r.decidedByUserId) };
  } catch {
    return {};
  }
}

export interface ApprovalsClient {
  decide(
    verb: ApprovalVerb,
    approvalId: string,
    opts: { actor: string; decisionNote?: string },
  ): Promise<ApprovalDecisionResult>;
  /** Read an approval's current decision (GET /api/approvals/{id}) — used by the
   *  approval.decided handler, since the event doesn't carry the outcome. */
  getStatus(approvalId: string): Promise<ApprovalStatusResult>;
}

/**
 * Client for the Paperclip approval REST API. `decide` POSTs to
 * `/api/approvals/{id}/{approve|reject}` with `{ decidedByUserId, decisionNote? }` — the
 * same shape the Discord plugin sends. The server currently derives the audit actor from
 * the board key and ignores `decidedByUserId`; we send it anyway for parity/forward-compat
 * and also fold the actor into the note so attribution is at least visible. Never throws.
 */
export function createApprovalsClient(deps: ApprovalsClientDeps): ApprovalsClient {
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async decide(verb, approvalId, opts): Promise<ApprovalDecisionResult> {
      if (!base || !/^https?:\/\//.test(base)) {
        return { ok: false, status: 0, error: "no valid Paperclip base URL configured" };
      }
      if (!approvalId) return { ok: false, status: 0, error: "missing approvalId" };
      const url = `${base}/api/approvals/${encodeURIComponent(approvalId)}/${verb}`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (deps.apiKey) headers["Authorization"] = `Bearer ${deps.apiKey}`;
      const note = opts.decisionNote ?? `Decided from Microsoft Teams by ${opts.actor}`;
      const body = JSON.stringify({ decidedByUserId: opts.actor, decisionNote: note });
      try {
        const res = await deps.fetchFn(url, { method: "POST", headers, body });
        const text = await res.text().catch(() => "");
        if (res.status >= 200 && res.status < 300) {
          // Return the ACTUAL decision from the response record (idempotency-safe): if the
          // approval was already decided — possibly differently — the card must reflect the
          // real outcome, not the verb the user just clicked.
          const rec = parseApprovalRecord(text);
          return { ok: true, status: res.status, verb: rec.verb ?? verb, decidedBy: rec.decidedBy };
        }
        return { ok: false, status: res.status, error: `approval ${verb} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}` };
      } catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async getStatus(approvalId): Promise<ApprovalStatusResult> {
      if (!base || !/^https?:\/\//.test(base)) return { ok: false, status: 0, error: "no valid Paperclip base URL configured" };
      if (!approvalId) return { ok: false, status: 0, error: "missing approvalId" };
      const url = `${base}/api/approvals/${encodeURIComponent(approvalId)}`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (deps.apiKey) headers["Authorization"] = `Bearer ${deps.apiKey}`;
      try {
        const res = await deps.fetchFn(url, { method: "GET", headers });
        const text = await res.text().catch(() => "");
        if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status, error: `approval read failed (${res.status})` };
        const rec = parseApprovalRecord(text);
        return { ok: true, status: res.status, verb: rec.verb, decidedBy: rec.decidedBy };
      } catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
