/**
 * Agent tool handlers (PCLIP-3): get/search/create/comment/update-state Plane
 * work items. Pure logic over {@link PlaneClientPort} so every AC is unit-testable
 * with a fake client. Handlers validate the (untrusted) agent params, format a
 * {@link ToolResultShape} with a readable `content` string + structured `data`
 * (incl. the Plane URL, AC #3), and map failures to a structured, actionable
 * error the agent can reason about — never a stack trace (AC #4).
 */

import {
  PlaneApiError,
  errorHint,
  type PlaneClientPort,
  type PlaneCreateInput,
  type PlaneWorkItem,
} from "./plane-client.js";

/** Mirror of the SDK ToolResult (content? / data? / error?) kept SDK-decoupled. */
export interface ToolResultShape {
  content?: string;
  data?: unknown;
  error?: string;
}

/** Raised for invalid agent-supplied params; mapped to a structured tool error. */
class ToolInputError extends Error {}

function asRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

function requireString(params: unknown, key: string): string {
  const v = asRecord(params)[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new ToolInputError(`'${key}' is required and must be a non-empty string`);
  }
  return v.trim();
}

function optString(params: unknown, key: string): string | undefined {
  const v = asRecord(params)[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

function optPriority(params: unknown): PlaneCreateInput["priority"] {
  const v = optString(params, "priority");
  if (v === undefined) return undefined;
  if (!(PRIORITIES as readonly string[]).includes(v)) {
    throw new ToolInputError(`'priority' must be one of ${PRIORITIES.join(", ")}`);
  }
  return v as PlaneCreateInput["priority"];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function fromCodePointSafe(code: number): string | undefined {
  try {
    return code > 0 ? String.fromCodePoint(code) : undefined;
  } catch {
    return undefined; // out-of-range code point
  }
}

/**
 * Decode common named + numeric HTML entities in a SINGLE pass. A single pass is
 * deliberate: sequential per-entity replaces would cascade (decoding `&amp;`
 * first turns the literal text `&amp;lt;` into `<` — a wrong double-decode, the
 * bug in the naive fix). One regex scan consumes each entity exactly once.
 * Unknown entities are left untouched.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? fromCodePointSafe(code) ?? match : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Strip HTML tags to a compact plain-text rendering for the human `content`
 * string, decoding entities so the agent sees `<script>` rather than the raw
 * `&lt;script&gt;` (Kody). Tags are removed BEFORE decoding, so escaped markup in
 * the source (e.g. `&lt;b&gt;`) surfaces as visible text, not stripped.
 */
function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function formatWorkItem(wi: PlaneWorkItem): string {
  const labels = wi.labels.length ? wi.labels.join(", ") : "(none)";
  const assignees = wi.assignees.length ? wi.assignees.map((a) => a.name || a.email || a.id).join(", ") : "(unassigned)";
  const comments = wi.comments.length
    ? wi.comments.map((c) => `- ${c.author ?? "unknown"}: ${stripHtml(c.bodyHtml)}`).join("\n")
    : "(no comments)";
  return [
    `${wi.identifier}: ${wi.name}`,
    `State: ${wi.state}${wi.priority ? ` | Priority: ${wi.priority}` : ""}`,
    `Assignees: ${assignees}`,
    `Labels: ${labels}`,
    `URL: ${wi.url}`,
    "",
    "Description:",
    stripHtml(wi.descriptionHtml) || "(no description)",
    "",
    "Comments:",
    comments,
  ].join("\n");
}

/**
 * Execute a tool body, converting ToolInputError and PlaneApiError into a
 * structured ToolResult. A PlaneApiError carries a coarse `kind` + HTTP status
 * so the agent can branch (retry on rate_limited, surface auth issues, etc.).
 */
async function runTool(body: () => Promise<ToolResultShape>): Promise<ToolResultShape> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof ToolInputError) {
      return { error: `Invalid input: ${e.message}`, data: { kind: "bad_request" } };
    }
    if (e instanceof PlaneApiError) {
      return {
        error: `${errorHint(e.kind)}${e.status ? ` (HTTP ${e.status})` : ""}`,
        data: {
          kind: e.kind,
          status: e.status,
          ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
        },
      };
    }
    // Defensive: never leak an unexpected error's stack trace to the agent.
    return { error: "Unexpected error executing the Plane tool.", data: { kind: "unknown" } };
  }
}

/** Default per-call deadline (AC #3: create/comment/update must land within 5s). */
export const DEFAULT_TOOL_TIMEOUT_MS = 5000;

/**
 * Race a client call against a deadline. On timeout the call rejects as a
 * PlaneApiError("unavailable"), which runTool maps to a structured, retryable
 * error — so the 5s visibility SLA is ENFORCED at the tool layer, independent of
 * the concrete client (PCLIP-7). The timer is always cleared to avoid leaks.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PlaneApiError("unavailable", undefined, `Plane call exceeded the ${ms}ms SLA`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface PlaneAgentTools {
  getWorkItem(params: unknown): Promise<ToolResultShape>;
  searchWorkItems(params: unknown): Promise<ToolResultShape>;
  listMembers(params: unknown): Promise<ToolResultShape>;
  listWorkItems(params: unknown): Promise<ToolResultShape>;
  createWorkItem(params: unknown): Promise<ToolResultShape>;
  addComment(params: unknown): Promise<ToolResultShape>;
  updateState(params: unknown): Promise<ToolResultShape>;
}

export interface AgentToolsOptions {
  /** Per-call deadline in ms. Default {@link DEFAULT_TOOL_TIMEOUT_MS}; 0 disables. */
  timeoutMs?: number;
}

/**
 * Build the tool handlers. `getClient` is a getter so the worker can swap the
 * concrete authenticated client in later (PCLIP-7) without re-registering tools.
 * Every client call is bounded by a deadline (AC #3).
 */
export function createAgentTools(getClient: () => PlaneClientPort, options: AgentToolsOptions = {}): PlaneAgentTools {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const call = <T>(p: Promise<T>): Promise<T> => withDeadline(p, timeoutMs);
  return {
    getWorkItem: (params) =>
      runTool(async () => {
        const wi = await call(getClient().getWorkItem(requireString(params, "id")));
        return { content: formatWorkItem(wi), data: wi };
      }),

    searchWorkItems: (params) =>
      runTool(async () => {
        const res = await call(
          getClient().searchWorkItems({
            text: optString(params, "query"),
            label: optString(params, "label"),
            state: optString(params, "state"),
            cursor: optString(params, "cursor"),
          }),
        );
        const lines = res.items.map((i) => `${i.identifier} [${i.state}] ${i.name} — ${i.url}`);
        const header = `${res.items.length} result(s)${res.nextCursor ? " (more available; pass cursor to page)" : ""}`;
        return { content: [header, ...lines].join("\n"), data: res };
      }),

    listMembers: (params) =>
      runTool(async () => {
        const members = await call(getClient().listMembers(optString(params, "projectId")));
        const lines = members.map((m) => `${m.name} <${m.email || "no-email"}> — role ${m.role} — ${m.id}`);
        return { content: [`${members.length} member(s)`, ...lines].join("\n"), data: { members } };
      }),

    listWorkItems: (params) =>
      runTool(async () => {
        const res = await call(
          getClient().listWorkItems({
            projectId: requireString(params, "projectId"),
            assigneeId: optString(params, "assigneeId"),
            cursor: optString(params, "cursor"),
          }),
        );
        const lines = res.items.map((i) => {
          const who = (i.assignees ?? []).map((a) => a.name || a.email || a.id).join(", ") || "unassigned";
          return `${i.identifier} [${i.state}] ${i.name} — ${who} — ${i.url}`;
        });
        const header = `${res.items.length} work item(s)${res.nextCursor ? " (more; pass cursor to page)" : ""}`;
        return { content: [header, ...lines].join("\n"), data: res };
      }),

    createWorkItem: (params) =>
      runTool(async () => {
        const res = await call(
          getClient().createWorkItem({
            projectId: requireString(params, "projectId"),
            name: requireString(params, "name"),
            descriptionHtml: optString(params, "descriptionHtml"),
            priority: optPriority(params),
          }),
        );
        return { content: `Created ${res.identifier}: ${res.url}`, data: res };
      }),

    addComment: (params) =>
      runTool(async () => {
        const res = await call(getClient().addComment(requireString(params, "id"), requireString(params, "commentHtml")));
        return { content: `Comment added: ${res.url}`, data: res };
      }),

    updateState: (params) =>
      runTool(async () => {
        const res = await call(getClient().updateState(requireString(params, "id"), requireString(params, "state")));
        return { content: `${res.identifier} moved to "${res.state}": ${res.url}`, data: res };
      }),
  };
}

/** Minimal registrar port (subset of ctx.tools) so registration is testable. */
export interface ToolRegistrar {
  register(
    name: string,
    declaration: { displayName: string; description: string; parametersSchema: unknown },
    fn: (params: unknown) => Promise<ToolResultShape>,
  ): void;
}

export interface ToolDeclarationSource {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: unknown;
}

export interface ToolNameMap {
  getWorkItem: string;
  searchWorkItems: string;
  listMembers: string;
  listWorkItems: string;
  createWorkItem: string;
  addComment: string;
  updateState: string;
}

/**
 * Register all five tools against a {@link ToolRegistrar}, looking each
 * declaration up from the manifest by name. Extracted from the worker so the
 * full register→invoke path is unit-testable (AC #5) without the live host.
 * A missing declaration invokes `onMissing` rather than silently skipping.
 */
export function registerPlaneTools(
  registrar: ToolRegistrar,
  tools: PlaneAgentTools,
  declarations: readonly ToolDeclarationSource[],
  toolNames: ToolNameMap,
  onMissing?: (name: string) => void,
): void {
  const byName = new Map(declarations.map((d) => [d.name, d]));
  const wire = (name: string, handler: (params: unknown) => Promise<ToolResultShape>): void => {
    const decl = byName.get(name);
    if (!decl) {
      onMissing?.(name);
      return;
    }
    registrar.register(
      name,
      { displayName: decl.displayName, description: decl.description, parametersSchema: decl.parametersSchema },
      handler,
    );
  };
  wire(toolNames.getWorkItem, tools.getWorkItem);
  wire(toolNames.searchWorkItems, tools.searchWorkItems);
  wire(toolNames.listMembers, tools.listMembers);
  wire(toolNames.listWorkItems, tools.listWorkItems);
  wire(toolNames.createWorkItem, tools.createWorkItem);
  wire(toolNames.addComment, tools.addComment);
  wire(toolNames.updateState, tools.updateState);
}
