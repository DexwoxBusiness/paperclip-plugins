/**
 * Plane REST client contract (PCLIP-3).
 *
 * The five agent tools talk to Plane through {@link PlaneClientPort}. The port
 * is SDK- and transport-decoupled so the tool logic is unit-testable with a fake
 * (same pattern as IssuesPort / EntitiesPort). The CONCRETE authenticated HTTP
 * client — secret-ref API key resolution, base URL, workspace slug, retries,
 * status→error mapping — is delivered by PCLIP-7 and injected here.
 *
 * Error contract (AC #4): every failure surfaces as a {@link PlaneApiError} with
 * a coarse {@link PlaneApiErrorKind} and the HTTP status, so tool handlers can
 * return a structured, actionable error to the agent instead of a stack trace.
 */

/** Coarse, agent-actionable classification of a Plane API failure. */
export type PlaneApiErrorKind =
  | "unauthorized" // 401/403 — bad/again missing API key
  | "not_found" // 404 — work item / project does not exist
  | "rate_limited" // 429 — back off and retry
  | "bad_request" // 400/422 — invalid input
  | "unavailable" // 5xx / network / not-configured
  | "unknown";

export class PlaneApiError extends Error {
  constructor(
    readonly kind: PlaneApiErrorKind,
    readonly status: number | undefined,
    message: string,
    /** Optional Retry-After seconds for rate limits, when the client can parse it. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PlaneApiError";
  }
}

/** Map an HTTP status to a {@link PlaneApiErrorKind}. */
export function classifyStatus(status: number): PlaneApiErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "unavailable";
  return "unknown";
}

/** A short, human-facing hint per error kind (agents relay this to users). */
export function errorHint(kind: PlaneApiErrorKind): string {
  switch (kind) {
    case "unauthorized":
      return "Plane rejected the API key — check the configured secret-ref (PCLIP-7).";
    case "not_found":
      return "The work item or project was not found in Plane.";
    case "rate_limited":
      return "Plane is rate-limiting requests — retry after a short backoff.";
    case "bad_request":
      return "Plane rejected the request as invalid — check the tool inputs.";
    case "unavailable":
      return "Plane is unavailable or the client is not configured — try again later.";
    default:
      return "Unexpected Plane API error.";
  }
}

/** A Plane comment as surfaced to agents. */
export interface PlaneComment {
  id: string;
  bodyHtml: string;
  author?: string;
  createdAt?: string;
}

/** A Plane workspace/project member — the identity join to Teams (and others) by email. */
export interface PlaneMember {
  /** Plane user UUID. */
  id: string;
  /** Display name: display_name, else first+last, else email/id. */
  name: string;
  /** Email, lowercased for case-insensitive joins ("" when Plane doesn't expose it). */
  email: string;
  /** Plane role: 20=Admin, 15=Member, 10=Viewer, 5=Guest. */
  role: number;
}

/** A work item assignee (a Plane user; email present only when the field was expanded). */
export interface PlaneAssignee {
  id: string;
  name: string;
  /** Lowercased; "" when the assignee is an id only (not expanded). */
  email: string;
}

/** A fully-hydrated Plane work item (AC #1: one response with everything). */
export interface PlaneWorkItem {
  /** Work item UUID. */
  id: string;
  /** Readable identifier, e.g. "PCLIP-12". */
  identifier: string;
  name: string;
  descriptionHtml: string;
  state: string;
  priority?: string;
  labels: string[];
  /** Assignees (expanded when available; id-only otherwise). */
  assignees: PlaneAssignee[];
  comments: PlaneComment[];
  /** Absolute Plane URL to the work item. */
  url: string;
}

/** A single search hit (AC #2: readable identifiers, paginated). */
export interface PlaneWorkItemSummary {
  id: string;
  identifier: string;
  name: string;
  state: string;
  url: string;
  /** Assignees, populated by list_work_items (the semantic search endpoint does not expand them). */
  assignees?: PlaneAssignee[];
}

export interface PlaneSearchResult {
  items: PlaneWorkItemSummary[];
  /** Opaque cursor for the next page, or undefined when exhausted. */
  nextCursor?: string;
}

export interface PlaneCreateInput {
  /** Plane project UUID to create the work item in. */
  projectId: string;
  name: string;
  descriptionHtml?: string;
  priority?: "urgent" | "high" | "medium" | "low" | "none";
}

export interface PlaneMutationResult {
  id: string;
  identifier: string;
  url: string;
}

export interface PlaneCommentResult {
  id: string;
  url: string;
}

export interface PlaneStateResult {
  id: string;
  identifier: string;
  state: string;
  url: string;
}

/**
 * The Plane operations the agent tools need. `idOrIdentifier` accepts either a
 * readable identifier ("PCLIP-12") or a work item UUID; resolution is the
 * concrete client's responsibility (PCLIP-7). Methods reject with
 * {@link PlaneApiError} on failure.
 */
export interface PlaneClientPort {
  getWorkItem(idOrIdentifier: string): Promise<PlaneWorkItem>;
  searchWorkItems(query: { text?: string; label?: string; state?: string; cursor?: string }): Promise<PlaneSearchResult>;
  /** Workspace members, or a project's members when `projectId` is given — the identity join. */
  listMembers(projectId?: string): Promise<PlaneMember[]>;
  /** List a project's work items (assignees expanded), optionally filtered to one assignee UUID. */
  listWorkItems(input: { projectId: string; assigneeId?: string; cursor?: string }): Promise<PlaneSearchResult>;

  /**
   * Mutation contract (AC #3 — "visible within 5 seconds"). Plane's REST API is
   * synchronous: a create/comment/state-change resolves ONLY after Plane has
   * committed the write and returned the affected resource, so a successful
   * result means the change is already readable via Plane's API — no read-after-
   * write poll is needed. The concrete client (PCLIP-7) MUST apply a request
   * timeout of <= 5s so a slow/hung call fails as a `PlaneApiError("unavailable")`
   * rather than silently exceeding the visibility SLA. Each result carries the
   * absolute Plane `url`.
   */
  createWorkItem(input: PlaneCreateInput): Promise<PlaneMutationResult>;
  addComment(idOrIdentifier: string, commentHtml: string): Promise<PlaneCommentResult>;
  updateState(idOrIdentifier: string, state: string): Promise<PlaneStateResult>;
}

/** A work item as returned by the paginated project list (PCLIP-5 reconciliation). */
export interface PlaneListWorkItem {
  /** Work item UUID. */
  id: string;
  name: string;
  descriptionHtml: string;
  /** ISO8601 last-modified time; used as the reconciliation drift watermark. */
  updatedAt?: string;
  /** Label UUIDs on the item (matched against a rule's labelFilter). */
  labels: string[];
  /** State UUID (or name); informational for reconciliation. */
  state: string;
}

export interface PlaneWorkItemPage {
  items: PlaneListWorkItem[];
  /** Opaque cursor for the next page, when {@link PlaneWorkItemPage.hasMore}. */
  nextCursor?: string;
  hasMore: boolean;
}

export interface PlaneListWorkItemsInput {
  /** Plane project UUID to page through. */
  projectId: string;
  /** Pagination cursor from a previous page (Plane format `per_page:page:is_prev`). */
  cursor?: string;
  /** Page size (Plane max 100; default 100). */
  perPage?: number;
  /** Plane order_by, e.g. `-updated_at` (newest first). */
  orderBy?: string;
}

/**
 * The Plane data-access reconciliation (PCLIP-5) needs, kept SEPARATE from
 * {@link PlaneClientPort} so the agent-tool consumers and their fakes are
 * unaffected. The concrete REST client (PCLIP-7) implements both.
 */
export interface PlaneReconcilePort {
  /** Page a project's work items (cursor pagination). Rejects with {@link PlaneApiError}. */
  listProjectWorkItems(input: PlaneListWorkItemsInput): Promise<PlaneWorkItemPage>;
}

/**
 * A placeholder client used until PCLIP-7 injects the authenticated REST client.
 * Every call fails loudly with a structured, actionable error rather than a
 * confusing success — so the tools are registered and callable now (AC #5), and
 * the agent gets a clear "not configured" signal until auth lands.
 */
export function createUnconfiguredPlaneClient(): PlaneClientPort {
  const fail = (): never => {
    throw new PlaneApiError(
      "unavailable",
      undefined,
      "Plane API client is not configured yet — set the Plane API key secret-ref (PCLIP-7).",
    );
  };
  return {
    getWorkItem: async () => fail(),
    searchWorkItems: async () => fail(),
    listMembers: async () => fail(),
    listWorkItems: async () => fail(),
    createWorkItem: async () => fail(),
    addComment: async () => fail(),
    updateState: async () => fail(),
  };
}
