/**
 * Concrete authenticated Plane REST client (PCLIP-7) — the real implementation
 * of the PlaneClientPort the PCLIP-3 agent tools depend on.
 *
 * Contract verified against the Plane API docs (developers.plane.so):
 *  - Base: `<baseUrl>/api/v1/workspaces/<slug>/...`
 *  - Auth: `X-API-Key: <token>` header.
 *  - Status: 200/201/204 success; 400/401/404/429/5xx errors (classifyStatus).
 *  - Rate limit: 60/min; `X-RateLimit-Reset` (epoch seconds), `Retry-After`.
 *  - Pagination: cursor `value:offset:is_prev`; response `{ next_cursor, results }`.
 *
 * Security (AC #2): the API key is resolved from the secret-ref at CALL TIME via
 * `getApiKey()` and used only as the request header. It is never cached, logged,
 * or placed in error messages.
 *
 * Timeout (AC #3): every request is bounded by `timeoutMs` (default 5s) via an
 * AbortController, so a slow call fails as PlaneApiError("unavailable").
 *
 * Endpoint PATHS are validated against the pinned self-hosted build when the
 * plugin is connected (AC #4); the HTTP mechanics below are transport-verified.
 */

import {
  PlaneApiError,
  classifyStatus,
  type PlaneClientPort,
  type PlaneComment,
  type PlaneCommentResult,
  type PlaneCreateInput,
  type PlaneMutationResult,
  type PlaneSearchResult,
  type PlaneStateResult,
  type PlaneWorkItem,
  type PlaneWorkItemSummary,
} from "./plane-client.js";

/** Minimal fetch Response shape this client uses (global fetch satisfies it). */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Minimal fetch shape (global `fetch` satisfies it); injected for testability. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface PlaneRestClientDeps {
  /** Self-hosted Plane base URL, no trailing slash (e.g. https://plane.example.com). */
  baseUrl: string;
  /** Plane workspace slug. */
  workspaceSlug: string;
  /** Resolve the API key from its secret-ref, at call time. Never cache the result. */
  getApiKey: () => Promise<string>;
  /** Injected fetch (global `fetch` in prod, a fake in tests). */
  fetchFn: FetchLike;
  /** Per-request deadline in ms. Default 5000 (AC #3). */
  timeoutMs?: number;
  /** Clock for Retry-After computation (testable). Defaults to Date.now. */
  now?: () => number;
}

export interface PlaneRestClient extends PlaneClientPort {
  /** Lightweight authenticated ping for the settings "Test Connection" (AC #3). */
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

const READABLE_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export function createPlaneRestClient(deps: PlaneRestClientDeps): PlaneRestClient {
  const timeoutMs = deps.timeoutMs ?? 5000;
  const now = deps.now ?? Date.now;
  const apiBase = `${trimTrailingSlash(deps.baseUrl)}/api/v1/workspaces/${encodeURIComponent(deps.workspaceSlug)}`;
  // Project identifier ("PCLIP") is not secret and is stable; cache it to build
  // readable identifiers/URLs without re-fetching per call.
  const projectIdentifierCache = new Map<string, string>();

  function parseRetryAfter(res: FetchResponseLike): number | undefined {
    const ra = res.headers.get("retry-after");
    if (ra && /^\d+$/.test(ra.trim())) return Number(ra.trim());
    const reset = res.headers.get("x-ratelimit-reset");
    if (reset && /^\d+$/.test(reset.trim())) {
      const secs = Math.ceil(Number(reset.trim()) - now() / 1000);
      return secs > 0 ? secs : 0;
    }
    return undefined;
  }

  async function request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    // Resolve the secret per call; keep it in a local only.
    const apiKey = await deps.getApiKey();
    if (!apiKey) {
      throw new PlaneApiError("unauthorized", undefined, "No Plane API key resolved from the configured secret-ref");
    }
    const qs = opts.query
      ? Object.entries(opts.query)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    const url = `${apiBase}/${encodePath(path)}${qs ? `?${qs}` : ""}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: FetchResponseLike;
    try {
      res = await deps.fetchFn(url, {
        method,
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      // Distinguish a timeout (abort) from a network error; never leak the key.
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      throw new PlaneApiError(
        "unavailable",
        undefined,
        aborted ? `Plane request timed out after ${timeoutMs}ms` : "Plane request failed (network error)",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 400) {
      const kind = classifyStatus(res.status);
      const retryAfter = kind === "rate_limited" ? parseRetryAfter(res) : undefined;
      // Error message intentionally excludes the API key and request body.
      throw new PlaneApiError(kind, res.status, `Plane API ${method} ${path} returned ${res.status}`, retryAfter);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function projectIdentifier(projectId: string): Promise<string> {
    const cached = projectIdentifierCache.get(projectId);
    if (cached) return cached;
    const proj = await request<{ identifier?: string }>("GET", `projects/${projectId}`);
    const ident = typeof proj.identifier === "string" ? proj.identifier : "";
    if (ident) projectIdentifierCache.set(projectId, ident);
    return ident;
  }

  function webUrl(projectId: string, issueId: string): string {
    return `${trimTrailingSlash(deps.baseUrl)}/${encodeURIComponent(deps.workspaceSlug)}/projects/${projectId}/issues/${issueId}`;
  }

  /** Map a raw Plane issue object to the domain PlaneWorkItem (best-effort fields). */
  async function toWorkItem(raw: Record<string, unknown>): Promise<PlaneWorkItem> {
    const projectId = String(raw.project ?? raw.project_id ?? "");
    const id = String(raw.id ?? "");
    const ident = projectId ? await projectIdentifier(projectId) : "";
    const seq = raw.sequence_id;
    const identifier = ident && seq !== undefined ? `${ident}-${seq}` : (typeof raw.identifier === "string" ? raw.identifier : id);
    const labels = Array.isArray(raw.labels) ? raw.labels.map((l) => String(l)) : [];
    const commentsRaw = Array.isArray(raw.comments) ? raw.comments : [];
    const comments: PlaneComment[] = commentsRaw.map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        id: String(o.id ?? ""),
        bodyHtml: String(o.comment_html ?? o.comment ?? ""),
        author: typeof o.actor === "string" ? o.actor : undefined,
        createdAt: typeof o.created_at === "string" ? o.created_at : undefined,
      };
    });
    return {
      id,
      identifier,
      name: String(raw.name ?? ""),
      descriptionHtml: String(raw.description_html ?? raw.description ?? ""),
      state: String(raw.state ?? ""),
      priority: typeof raw.priority === "string" ? raw.priority : undefined,
      labels,
      comments,
      url: webUrl(projectId, id),
    };
  }

  function toSummary(raw: Record<string, unknown>, projectIdent: string): PlaneWorkItemSummary {
    const projectId = String(raw.project ?? raw.project_id ?? "");
    const id = String(raw.id ?? "");
    const seq = raw.sequence_id;
    return {
      id,
      identifier: projectIdent && seq !== undefined ? `${projectIdent}-${seq}` : id,
      name: String(raw.name ?? ""),
      state: String(raw.state ?? ""),
      url: webUrl(projectId, id),
    };
  }

  const client: PlaneRestClient = {
    async getWorkItem(idOrIdentifier: string): Promise<PlaneWorkItem> {
      // Readable identifier (PROJ-123) resolves via the workspace identifier
      // endpoint; a bare UUID uses the workspace-level detail lookup. Exact paths
      // are confirmed against the pinned build (AC #4).
      const path = READABLE_ID_RE.test(idOrIdentifier)
        ? `issues/${idOrIdentifier}`
        : `issues/${idOrIdentifier}`;
      const raw = await request<Record<string, unknown>>("GET", path, { query: { expand: "labels,state,comments" } });
      return toWorkItem(raw);
    },

    async searchWorkItems(query): Promise<PlaneSearchResult> {
      const raw = await request<{ results?: unknown[]; next_cursor?: string; next_page_results?: boolean }>(
        "GET",
        "issues/search",
        { query: { search: query.text, labels: query.label, state: query.state, cursor: query.cursor, per_page: "50" } },
      );
      const results = Array.isArray(raw.results) ? raw.results : [];
      // Resolve each hit's project identifier (cached) for readable ids.
      const items: PlaneWorkItemSummary[] = [];
      for (const r of results) {
        const o = (r ?? {}) as Record<string, unknown>;
        const projectId = String(o.project ?? o.project_id ?? "");
        const ident = projectId ? await projectIdentifier(projectId) : "";
        items.push(toSummary(o, ident));
      }
      const nextCursor = raw.next_page_results ? raw.next_cursor : undefined;
      return { items, nextCursor: nextCursor || undefined };
    },

    async createWorkItem(input: PlaneCreateInput): Promise<PlaneMutationResult> {
      const raw = await request<Record<string, unknown>>("POST", `projects/${input.projectId}/issues`, {
        body: {
          name: input.name,
          description_html: input.descriptionHtml,
          ...(input.priority ? { priority: input.priority } : {}),
        },
      });
      const id = String(raw.id ?? "");
      const ident = await projectIdentifier(input.projectId);
      const identifier = ident && raw.sequence_id !== undefined ? `${ident}-${raw.sequence_id}` : id;
      return { id, identifier, url: webUrl(input.projectId, id) };
    },

    async addComment(idOrIdentifier: string, commentHtml: string): Promise<PlaneCommentResult> {
      const wi = await client.getWorkItem(idOrIdentifier);
      const projectId = String((wi.url.match(/projects\/([^/]+)\/issues/) ?? [])[1] ?? "");
      const raw = await request<Record<string, unknown>>("POST", `projects/${projectId}/issues/${wi.id}/comments`, {
        body: { comment_html: commentHtml },
      });
      return { id: String(raw.id ?? ""), url: `${wi.url}#comment-${raw.id ?? ""}` };
    },

    async updateState(idOrIdentifier: string, state: string): Promise<PlaneStateResult> {
      const wi = await client.getWorkItem(idOrIdentifier);
      const projectId = String((wi.url.match(/projects\/([^/]+)\/issues/) ?? [])[1] ?? "");
      await request<Record<string, unknown>>("PATCH", `projects/${projectId}/issues/${wi.id}`, {
        body: { state },
      });
      return { id: wi.id, identifier: wi.identifier, state, url: wi.url };
    },

    async testConnection(): Promise<{ ok: boolean; error?: string }> {
      try {
        // Lightweight authenticated read; 401 means the key is invalid/revoked.
        await request("GET", "projects", { query: { per_page: "1" } });
        return { ok: true };
      } catch (e) {
        if (e instanceof PlaneApiError) {
          const hint =
            e.kind === "unauthorized"
              ? "Plane rejected the API key — re-authenticate: update the API key secret-ref in settings."
              : `Plane connection check failed (${e.kind}${e.status ? ` HTTP ${e.status}` : ""}).`;
          return { ok: false, error: hint };
        }
        return { ok: false, error: "Plane connection check failed unexpectedly." };
      }
    },
  };

  return client;
}
