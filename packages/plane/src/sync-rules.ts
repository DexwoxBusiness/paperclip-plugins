/**
 * Configurable sync rules: Plane project -> Paperclip project with an optional
 * label filter (PCLIP-2).
 *
 * Consumes the verified Plane events produced by the webhook path (PCLIP-1) and
 * upserts the mapped Paperclip issue, recording the mapping via PCLIP-6. Pure
 * decision logic is separated from the SDK so every AC is unit-testable
 * (same pattern as webhook-handler / id-mapping).
 *
 * Idempotency ("no duplicate Paperclip issue"): creates carry
 * originKind=`plugin:<pluginId>` + originId=<planeIssueId>. The handler resolves
 * an existing mapping first (PCLIP-6), then falls back to an origin lookup so a
 * create that succeeded but whose mapping link failed is RE-LINKED on retry
 * rather than duplicated (engineering standard #1).
 *
 * Label filter: Plane webhook payloads carry label UUIDs, so `labelFilter` is a
 * Plane label ID. The matcher also accepts label objects/names if a payload ever
 * includes them, but name-based configuration needs the Plane REST client
 * (PCLIP-3) and is surfaced as a validation warning until then.
 */

import type { ParsedPlaneEvent } from "./plane-events.js";
import type { IdMappingStore } from "./id-mapping.js";

/** One project mapping with an optional label gate. */
export interface SyncRule {
  /** Plane project UUID (matched against the event's projectId). */
  planeProjectId: string;
  /** Target Paperclip company UUID. */
  companyId: string;
  /** Target Paperclip project UUID. */
  paperclipProjectId: string;
  /** Optional Plane label UUID; only issues carrying it sync. */
  labelFilter?: string;
}

/**
 * Parse the raw config array into runtime rules, dropping structurally invalid
 * entries (those are rejected loudly at save time by onValidateConfig; at
 * runtime a malformed rule simply never matches). Zero-state: non-array -> [].
 */
export function normalizeSyncRules(raw: unknown): SyncRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: SyncRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    // planeProjectId is matched against the event's projectId (a Plane UUID);
    // canonicalize to lowercase so uppercase config still matches (Kody).
    const planeProjectId = typeof r.planeProjectId === "string" ? r.planeProjectId.trim().toLowerCase() : "";
    const companyId = typeof r.companyId === "string" ? r.companyId.trim() : "";
    const paperclipProjectId = typeof r.paperclipProjectId === "string" ? r.paperclipProjectId.trim() : "";
    if (!planeProjectId || !companyId || !paperclipProjectId) continue;
    const labelFilter =
      typeof r.labelFilter === "string" && r.labelFilter.trim() ? r.labelFilter.trim() : undefined;
    rules.push({ planeProjectId, companyId, paperclipProjectId, labelFilter });
  }
  return rules;
}

/** Port for save-time validation: does a Paperclip project exist in a company? */
export interface ProjectLookupPort {
  projectExists(companyId: string, projectId: string): Promise<boolean>;
}

export interface SyncRulesValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the raw syncRules config at save time (PCLIP-2 AC #5): reject
 * malformed rules and unknown project IDs on BOTH sides of the mapping with
 * clear messages, and warn on a non-UUID labelFilter.
 *
 * Plane side: Plane project IDs are UUIDs, but we have no Plane API to check
 * existence until PCLIP-3, so we validate the UUID FORMAT here (an ill-formed
 * planeProjectId can never match an event's projectId, so it is rejected).
 * Paperclip side: existence is checked via {@link ProjectLookupPort}
 * (ctx.projects.get). The existence lookups run in parallel (Kody perf).
 * Pure over the port so it is unit-testable.
 */
export async function validateSyncRulesConfig(raw: unknown, lookup: ProjectLookupPort): Promise<SyncRulesValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw !== undefined && !Array.isArray(raw)) {
    return { ok: false, errors: ["syncRules must be an array"], warnings };
  }
  const arr = Array.isArray(raw) ? raw : [];
  const seenPlane = new Set<string>();
  const existenceChecks: Array<{ at: string; companyId: string; projectId: string }> = [];
  for (let i = 0; i < arr.length; i++) {
    const at = `syncRules[${i}]`;
    const item = arr[i];
    if (!item || typeof item !== "object") {
      errors.push(`${at}: must be an object`);
      continue;
    }
    const r = item as Record<string, unknown>;
    // Lowercase planeProjectId so case-variant duplicates are detected and the
    // stored/validated form matches runtime matching (Kody).
    const planeProjectId = typeof r.planeProjectId === "string" ? r.planeProjectId.trim().toLowerCase() : "";
    const companyId = typeof r.companyId === "string" ? r.companyId.trim() : "";
    const paperclipProjectId = typeof r.paperclipProjectId === "string" ? r.paperclipProjectId.trim() : "";

    if (!planeProjectId) errors.push(`${at}: planeProjectId is required`);
    else if (!UUID_RE.test(planeProjectId)) errors.push(`${at}: planeProjectId "${planeProjectId}" is not a valid Plane project UUID`);
    if (!companyId) errors.push(`${at}: companyId is required`);
    if (!paperclipProjectId) errors.push(`${at}: paperclipProjectId is required`);

    if (planeProjectId) {
      if (seenPlane.has(planeProjectId)) errors.push(`${at}: duplicate mapping for Plane project ${planeProjectId}`);
      seenPlane.add(planeProjectId);
    }
    // Defer the Paperclip existence check; it hits the host and is parallelized.
    if (companyId && paperclipProjectId) existenceChecks.push({ at, companyId, projectId: paperclipProjectId });

    const labelFilter = typeof r.labelFilter === "string" ? r.labelFilter.trim() : "";
    if (labelFilter && !UUID_RE.test(labelFilter)) {
      warnings.push(
        `${at}: labelFilter "${labelFilter}" is not a UUID — name-based label filtering needs the Plane client (PCLIP-3), so this may never match.`,
      );
    }
  }

  // Run all Paperclip existence lookups concurrently (Kody perf); append their
  // errors in rule order afterwards so messages stay deterministic.
  const results = await Promise.all(
    existenceChecks.map(async (c) => ({ c, exists: await lookup.projectExists(c.companyId, c.projectId) })),
  );
  for (const { c, exists } of results) {
    if (!exists) errors.push(`${c.at}: Paperclip project ${c.projectId} not found in company ${c.companyId}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Extract the set of label tokens (IDs, and names if present) from a Plane payload. */
export function extractIssueLabels(payload: unknown): Set<string> {
  const labels = new Set<string>();
  const data = (payload as { data?: { labels?: unknown } } | undefined)?.data;
  const raw = data?.labels;
  if (!Array.isArray(raw)) return labels;
  for (const l of raw) {
    if (typeof l === "string") {
      labels.add(l);
    } else if (l && typeof l === "object") {
      const o = l as Record<string, unknown>;
      if (typeof o.id === "string") labels.add(o.id);
      if (typeof o.name === "string") labels.add(o.name.toLowerCase());
    }
  }
  return labels;
}

function labelMatches(labelFilter: string, payload: unknown): boolean {
  const labels = extractIssueLabels(payload);
  return labels.has(labelFilter) || labels.has(labelFilter.toLowerCase());
}

export type SyncDecision =
  | { kind: "skip"; reason: "not-an-issue-event" | "no-mapping" | "label-filter" }
  | { kind: "sync"; rule: SyncRule };

/** Case-insensitive Plane project match (project IDs are UUIDs). */
function findRule(rules: SyncRule[], projectId: string | undefined): SyncRule | undefined {
  if (!projectId) return undefined;
  const key = projectId.toLowerCase();
  return rules.find((r) => r.planeProjectId.toLowerCase() === key);
}

/**
 * Decide whether a created/updated issue event should sync, and to which
 * project. Skips non-issue events, projects with no mapping (AC #3), and issues
 * that fail the label filter (AC #2). Deleted events are handled by the handler.
 */
export function evaluateSyncDecision(event: ParsedPlaneEvent, rules: SyncRule[]): SyncDecision {
  if (event.event !== "issue") return { kind: "skip", reason: "not-an-issue-event" };
  const rule = findRule(rules, event.projectId);
  if (!rule) return { kind: "skip", reason: "no-mapping" };
  if (rule.labelFilter && !labelMatches(rule.labelFilter, event.payload)) {
    return { kind: "skip", reason: "label-filter" };
  }
  return { kind: "sync", rule };
}

function extractTitle(payload: unknown): string | undefined {
  const name = (payload as { data?: { name?: unknown } } | undefined)?.data?.name;
  return typeof name === "string" && name.trim() ? name : undefined;
}

function extractDescription(payload: unknown): string | undefined {
  const data = (payload as { data?: { description_html?: unknown; description?: unknown } } | undefined)?.data;
  const d = data?.description_html ?? data?.description;
  return typeof d === "string" ? d : undefined;
}

/**
 * Structural mirror of the host's PluginIssueOriginKind (`plugin:${string}`),
 * declared locally so this module stays SDK-decoupled while remaining assignable
 * to ctx.issues.create's originKind.
 */
export type IssueOriginKind = `plugin:${string}`;

/** Host issue operations this handler needs (wraps ctx.issues). */
export interface IssuesPort {
  /**
   * Find the issue created for this Plane origin IN THE GIVEN PROJECT, or null.
   * Scoping by projectId (not just company) is what makes a same-company move to
   * a different Paperclip project create a fresh issue in the new project rather
   * than stranding the moved issue in the old one (Kody).
   */
  findByOrigin(input: {
    companyId: string;
    projectId: string;
    originKind: IssueOriginKind;
    originId: string;
  }): Promise<{ id: string } | null>;
  create(input: {
    companyId: string;
    projectId: string;
    title: string;
    description?: string;
    originKind: IssueOriginKind;
    originId: string;
  }): Promise<{ id: string }>;
  update(input: { issueId: string; companyId: string; title?: string; description?: string }): Promise<void>;
}

export interface SyncRulesHandlerDeps {
  /** Current sync rules, read fresh per event (live config; AC #4 no restart). */
  getRules(): Promise<SyncRule[]>;
  idMapping: Pick<IdMappingStore, "resolveByPlaneId" | "link" | "markStaleByPlaneId">;
  issues: IssuesPort;
  /** originKind stamped on created issues, e.g. `plugin:dexwox.plane-sync`. */
  originKind: IssueOriginKind;
  log(message: string, fields?: Record<string, unknown>): void;
}

export type SyncOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "created"; paperclipIssueId: string }
  | { kind: "updated"; paperclipIssueId: string }
  | { kind: "staled"; paperclipIssueId: string };

export interface SyncRulesHandler {
  handle(event: ParsedPlaneEvent): Promise<SyncOutcome>;
}

export function createSyncRulesHandler(deps: SyncRulesHandlerDeps): SyncRulesHandler {
  return {
    async handle(event: ParsedPlaneEvent): Promise<SyncOutcome> {
      // Scope: PCLIP-2 syncs ISSUES only. issue_comment (and other) events are
      // enabled for intake (PCLIP-1) but comment mirroring is a separate,
      // later item — they are acknowledged here and skipped, never errored.
      if (event.event !== "issue") {
        return skip("not-an-issue-event", event);
      }
      const rules = await deps.getRules();
      const rule = findRule(rules, event.projectId);
      if (!rule) {
        // AC #3: acknowledged and skipped — no error, no throw, no spam.
        deps.log("plane sync skipped: no mapping", { projectId: event.projectId, planeId: event.entityId });
        return { kind: "skipped", reason: "no-mapping" };
      }
      const planeId = event.entityId;
      if (!planeId) {
        deps.log("plane sync skipped: issue event missing id", { projectId: event.projectId });
        return { kind: "skipped", reason: "missing-entity-id" };
      }

      // A deleted Plane issue must not keep syncing: mark the mapping stale
      // (auditable, never delete the Paperclip issue). Label filter is bypassed
      // because delete payloads may omit labels.
      if (event.action === "deleted") {
        const mapped = await deps.idMapping.resolveByPlaneId(planeId);
        if (!mapped) return { kind: "skipped", reason: "deleted-unmapped" };
        await deps.idMapping.markStaleByPlaneId(planeId);
        deps.log("plane sync staled mapping (issue deleted)", { planeId, paperclipIssueId: mapped.paperclipIssueId });
        return { kind: "staled", paperclipIssueId: mapped.paperclipIssueId };
      }

      // AC #2: the label filter gates every event, not just creates. If an
      // already-synced issue loses the qualifying label on an update, stop
      // syncing it — mark the mapping stale (never delete). An unmapped issue
      // that fails the filter is simply skipped (nothing to create).
      if (rule.labelFilter && !labelMatches(rule.labelFilter, event.payload)) {
        const mapped = await deps.idMapping.resolveByPlaneId(planeId);
        if (mapped) {
          await deps.idMapping.markStaleByPlaneId(planeId);
          deps.log("plane sync unsynced: qualifying label removed", { planeId, paperclipIssueId: mapped.paperclipIssueId });
          return { kind: "staled", paperclipIssueId: mapped.paperclipIssueId };
        }
        deps.log("plane sync skipped: label filter", { planeId, labelFilter: rule.labelFilter });
        return { kind: "skipped", reason: "label-filter" };
      }

      const title = extractTitle(event.payload) ?? `Plane issue ${planeId}`;
      const description = extractDescription(event.payload);

      // The Paperclip issue for this Plane origin IN THE CURRENT RULE'S TARGET
      // (company AND project) is the source of truth. Scoping the lookup by
      // project makes the upsert both:
      //  - IDEMPOTENT: a create whose mapping link failed is found here and
      //    re-linked on the Plane retry, never duplicated (standard #1); and
      //  - MOVE-AWARE across BOTH company and project changes: if the Plane
      //    issue moved to a different mapped project (even within the SAME
      //    company), no issue for this origin exists in the new project, so we
      //    create one there and link() re-homes the mapping (staling the old
      //    row). A plain update() cannot move an issue between projects, so
      //    company-only scoping would strand a same-company move (Kody).
      const existing = await deps.issues.findByOrigin({
        companyId: rule.companyId,
        projectId: rule.paperclipProjectId,
        originKind: deps.originKind,
        originId: planeId,
      });
      if (existing) {
        // Heal the mapping if it is missing or points elsewhere, then update.
        const mapped = await deps.idMapping.resolveByPlaneId(planeId);
        if (!mapped || mapped.paperclipIssueId !== existing.id) {
          await deps.idMapping.link({ planeId, paperclipIssueId: existing.id, title });
        }
        await deps.issues.update({ issueId: existing.id, companyId: rule.companyId, title, description });
        deps.log("plane sync updated", { planeId, paperclipIssueId: existing.id });
        return { kind: "updated", paperclipIssueId: existing.id };
      }

      // Nothing for this origin in the target project: create there and link.
      const created = await deps.issues.create({
        companyId: rule.companyId,
        projectId: rule.paperclipProjectId,
        title,
        description,
        originKind: deps.originKind,
        originId: planeId,
      });
      await deps.idMapping.link({ planeId, paperclipIssueId: created.id, title });
      deps.log("plane sync created", { planeId, paperclipIssueId: created.id, projectId: rule.paperclipProjectId });
      return { kind: "created", paperclipIssueId: created.id };
    },
  };

  function skip(reason: string, event: ParsedPlaneEvent): SyncOutcome {
    deps.log("plane sync skipped", { reason, event: event.event, planeId: event.entityId });
    return { kind: "skipped", reason };
  }
}
