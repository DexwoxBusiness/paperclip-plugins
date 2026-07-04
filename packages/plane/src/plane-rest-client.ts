/**
 * Concrete authenticated Plane REST client (PCLIP-7) — the real implementation
 * of the PlaneClientPort the PCLIP-3 agent tools depend on.
 *
 * Contract verified against the Plane API docs (developers.plane.so):
 *  - Base: `<baseUrl>/api/v1/workspaces/<slug>/...`; auth header `X-API-Key`.
 *  - Work items live under the `work-items` resource (NOT `issues`):
 *      get by identifier: GET  work-items/{PROJ}-{n}/
 *      search:            GET  work-items/search/?search=&limit=&workspace_search=
 *                         -> { issues: [{ id, name, sequence_id, project__identifier, project_id }] }
 *      create:            POST projects/{project_id}/work-items/
 *      comment:           POST projects/{project_id}/work-items/{id}/comments/
 *      update:            PATCH projects/{project_id}/work-items/{id}/
 *  - Status: 200/201/204 ok; 400/401/404/429/5xx (classifyStatus). Rate limit:
 *    `Retry-After` / `X-RateLimit-Reset` (epoch).
 *
 * Security (AC #2): the API key is resolved from the secret-ref at CALL TIME via
 * `getApiKey()` and used only as the request header — never cached, logged, or in
 * error messages.
 *
 * Timeout (AC #3): every request is bounded by `timeoutMs` (default 5s) via an
 * AbortController, so a slow call fails as PlaneApiError("unavailable").
 *
 * Exact endpoint PATHS are confirmed against the pinned self-hosted build on
 * connect (AC #4); the HTTP mechanics + payload shapes below are doc-backed and
 * unit-tested with a fake fetch.
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
  // Non-secret, stable lookups cached in-memory to avoid repeat HTTP requests.
  const projectIdentifierById = new Map<string, string>(); // project UUID -> "PCLIP"
  const projectIdByIdentifier = new Map<string, string>(); // "PCLIP" -> project UUID

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
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
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

  /** project UUID -> identifier ("PCLIP"), cached (one request per project). */
  async function projectIdentifier(projectId: string): Promise<string> {
    const cached = projectIdentifierById.get(projectId);
    if (cached) return cached;
    const proj = await request<{ identifier?: string }>("GET", `projects/${projectId}`);
    const ident = typeof proj.identifier === "string" ? proj.identifier : "";
    if (ident) {
      projectIdentifierById.set(projectId, ident);
      projectIdByIdentifier.set(ident.toUpperCase(), projectId);
    }
    return ident;
  }

  /** identifier prefix ("PCLIP") -> project UUID, via a single cached project list. */
  async function resolveProjectIdByIdentifier(readableIdentifier: string): Promise<string> {
    const key = readableIdentifier.split("-")[0].toUpperCase();
    const cached = projectIdByIdentifier.get(key);
    if (cached) return cached;
    const raw = await request<{ results?: unknown[] } | unknown[]>("GET", "projects", { query: { per_page: "100" } });
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.results) ? raw.results : [];
    for (const p of list) {
      const o = (p ?? {}) as Record<string, unknown>;
      if (typeof o.identifier === "string" && typeof o.id === "string") {
        projectIdByIdentifier.set(o.identifier.toUpperCase(), o.id);
        projectIdentifierById.set(o.id, o.identifier);
      }
    }
    return projectIdByIdentifier.get(key) ?? "";
  }

  /** Plane "browse by identifier" web URL — needs only the readable identifier. */
  function browseUrl(identifier: string): string {
    return `${trimTrailingSlash(deps.baseUrl)}/${encodeURIComponent(deps.workspaceSlug)}/browse/${identifier}/`;
  }

  function labelsOf(raw: Record<string, unknown>): string[] {
    return Array.isArray(raw.labels) ? raw.labels.map((l) => String(l)) : [];
  }

  function commentsOf(raw: Record<string, unknown>): PlaneComment[] {
    const arr = Array.isArray(raw.comments) ? raw.comments : [];
    return arr.map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        id: String(o.id ?? ""),
        bodyHtml: String(o.comment_html ?? o.comment ?? ""),
        author: typeof o.actor === "string" ? o.actor : undefined,
        createdAt: typeof o.created_at === "string" ? o.created_at : undefined,
      };
    });
  }

  /**
   * Resolve a work item's readable identifier. Prefers what we already know — the
   * input identifier, or `project__identifier` in the response — and only falls
   * back to a cached project lookup when neither is present, so the common paths
   * add NO extra HTTP request (Kody perf).
   */
  async function resolveIdentifier(raw: Record<string, unknown>, knownIdentifier?: string): Promise<string> {
    if (knownIdentifier) return knownIdentifier;
    const seq = raw.sequence_id;
    const projIdent = typeof raw.project__identifier === "string" ? raw.project__identifier : "";
    if (projIdent && seq !== undefined) return `${projIdent}-${seq}`;
    const projectId = String(raw.project ?? raw.project_id ?? "");
    if (projectId && seq !== undefined) {
      const ident = await projectIdentifier(projectId);
      if (ident) return `${ident}-${seq}`;
    }
    return typeof raw.identifier === "string" ? raw.identifier : String(raw.id ?? "");
  }

  async function toWorkItem(raw: Record<string, unknown>, knownIdentifier?: string): Promise<PlaneWorkItem> {
    const identifier = await resolveIdentifier(raw, knownIdentifier);
    return {
      id: String(raw.id ?? ""),
      identifier,
      name: String(raw.name ?? ""),
      descriptionHtml: String(raw.description_html ?? raw.description ?? ""),
      state: String(raw.state ?? ""),
      priority: typeof raw.priority === "string" ? raw.priority : undefined,
      labels: labelsOf(raw),
      comments: commentsOf(raw),
      url: browseUrl(identifier),
    };
  }

  /** Resolve a work item's UUID + project UUID (needed for project-scoped mutations). */
  async function fetchIssueRef(idOrIdentifier: string): Promise<{ id: string; projectId: string; identifier: string }> {
    const known = READABLE_ID_RE.test(idOrIdentifier) ? idOrIdentifier : undefined;
    const raw = await request<Record<string, unknown>>("GET", `work-items/${idOrIdentifier}`, {
      query: { expand: "labels,state" },
    });
    const id = String(raw.id ?? "");
    let projectId = String(raw.project ?? raw.project_id ?? "");
    if (!projectId && known) projectId = await resolveProjectIdByIdentifier(known);
    const identifier = await resolveIdentifier(raw, known);
    return { id, projectId, identifier };
  }

  const client: PlaneRestClient = {
    async getWorkItem(idOrIdentifier: string): Promise<PlaneWorkItem> {
      // Single work-items path — readable identifier (PROJ-123) or UUID. When the
      // input is a readable identifier we already know it, so no lookup is needed.
      const known = READABLE_ID_RE.test(idOrIdentifier) ? idOrIdentifier : undefined;
      const raw = await request<Record<string, unknown>>("GET", `work-items/${idOrIdentifier}`, {
        query: { expand: "labels,state,comments" },
      });
      return toWorkItem(raw, known);
    },

    async searchWorkItems(query): Promise<PlaneSearchResult> {
      // Plane's semantic search endpoint returns `{ issues: [...] }` (each hit
      // carries project__identifier + sequence_id) and takes `search` + `limit`.
      if (!query.text) return { items: [] };
      const raw = await request<{ issues?: unknown[] }>("GET", "work-items/search", {
        query: { search: query.text, limit: "50", workspace_search: "true" },
      });
      const issues = Array.isArray(raw.issues) ? raw.issues : [];
      const items: PlaneWorkItemSummary[] = issues.map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        const projIdent = typeof o.project__identifier === "string" ? o.project__identifier : "";
        const identifier =
          projIdent && o.sequence_id !== undefined ? `${projIdent}-${o.sequence_id}` : String(o.id ?? "");
        return {
          id: String(o.id ?? ""),
          identifier,
          name: String(o.name ?? ""),
          state: String(o.state ?? ""),
          url: browseUrl(identifier),
        };
      });
      // The search endpoint returns up to `limit` best matches (no cursor).
      return { items };
    },

    async createWorkItem(input: PlaneCreateInput): Promise<PlaneMutationResult> {
      const raw = await request<Record<string, unknown>>("POST", `projects/${input.projectId}/work-items`, {
        body: {
          name: input.name,
          description_html: input.descriptionHtml,
          ...(input.priority ? { priority: input.priority } : {}),
        },
      });
      const identifier = await resolveIdentifier(raw);
      return { id: String(raw.id ?? ""), identifier, url: browseUrl(identifier) };
    },

    async addComment(idOrIdentifier: string, commentHtml: string): Promise<PlaneCommentResult> {
      const ref = await fetchIssueRef(idOrIdentifier);
      const raw = await request<Record<string, unknown>>("POST", `projects/${ref.projectId}/work-items/${ref.id}/comments`, {
        body: { comment_html: commentHtml },
      });
      return { id: String(raw.id ?? ""), url: `${browseUrl(ref.identifier)}#comment-${raw.id ?? ""}` };
    },

    async updateState(idOrIdentifier: string, state: string): Promise<PlaneStateResult> {
      const ref = await fetchIssueRef(idOrIdentifier);
      await request<Record<string, unknown>>("PATCH", `projects/${ref.projectId}/work-items/${ref.id}`, { body: { state } });
      return { id: ref.id, identifier: ref.identifier, state, url: browseUrl(ref.identifier) };
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
