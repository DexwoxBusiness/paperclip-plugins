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

/** Strip tags to a compact plain-text rendering for the human `content` string. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatWorkItem(wi: PlaneWorkItem): string {
  const labels = wi.labels.length ? wi.labels.join(", ") : "(none)";
  const comments = wi.comments.length
    ? wi.comments.map((c) => `- ${c.author ?? "unknown"}: ${stripHtml(c.bodyHtml)}`).join("\n")
    : "(no comments)";
  return [
    `${wi.identifier}: ${wi.name}`,
    `State: ${wi.state}${wi.priority ? ` | Priority: ${wi.priority}` : ""}`,
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

export interface PlaneAgentTools {
  getWorkItem(params: unknown): Promise<ToolResultShape>;
  searchWorkItems(params: unknown): Promise<ToolResultShape>;
  createWorkItem(params: unknown): Promise<ToolResultShape>;
  addComment(params: unknown): Promise<ToolResultShape>;
  updateState(params: unknown): Promise<ToolResultShape>;
}

/**
 * Build the tool handlers. `getClient` is a getter so the worker can swap the
 * concrete authenticated client in later (PCLIP-7) without re-registering tools.
 */
export function createAgentTools(getClient: () => PlaneClientPort): PlaneAgentTools {
  return {
    getWorkItem: (params) =>
      runTool(async () => {
        const wi = await getClient().getWorkItem(requireString(params, "id"));
        return { content: formatWorkItem(wi), data: wi };
      }),

    searchWorkItems: (params) =>
      runTool(async () => {
        const res = await getClient().searchWorkItems({
          text: optString(params, "query"),
          label: optString(params, "label"),
          state: optString(params, "state"),
          cursor: optString(params, "cursor"),
        });
        const lines = res.items.map((i) => `${i.identifier} [${i.state}] ${i.name} — ${i.url}`);
        const header = `${res.items.length} result(s)${res.nextCursor ? " (more available; pass cursor to page)" : ""}`;
        return { content: [header, ...lines].join("\n"), data: res };
      }),

    createWorkItem: (params) =>
      runTool(async () => {
        const res = await getClient().createWorkItem({
          projectId: requireString(params, "projectId"),
          name: requireString(params, "name"),
          descriptionHtml: optString(params, "descriptionHtml"),
          priority: optPriority(params),
        });
        return { content: `Created ${res.identifier}: ${res.url}`, data: res };
      }),

    addComment: (params) =>
      runTool(async () => {
        const res = await getClient().addComment(requireString(params, "id"), requireString(params, "commentHtml"));
        return { content: `Comment added: ${res.url}`, data: res };
      }),

    updateState: (params) =>
      runTool(async () => {
        const res = await getClient().updateState(requireString(params, "id"), requireString(params, "state"));
        return { content: `${res.identifier} moved to "${res.state}": ${res.url}`, data: res };
      }),
  };
}
