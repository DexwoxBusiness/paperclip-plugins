/**
 * Reconciliation backstop (PCLIP-5): a scheduled job that heals drift between
 * Plane and the plugin's ID-mapping caused by Plane CE's unreliable "issue
 * updated" webhooks (makeplane/plane#4097) and duplicate deliveries (#6848).
 *
 * Strategy — per mapped project, page Plane work items NEWEST-FIRST and process
 * everything changed since the last successful run, tracked by a per-project
 * `updated_at` watermark persisted in plugin state (survives restarts). Each
 * changed item is healed through the SAME idempotent write the webhook path uses
 * ({@link upsertMappedIssue}): a missed create/update is applied and a duplicate
 * is impossible (idempotency by origin + the plugin_entities unique key — AC #2).
 * An item that no longer carries the rule's qualifying label is staled (never
 * deleted), mirroring PCLIP-2.
 *
 * Bounded + rate-limit-aware (AC #3): Plane exposes no server-side `updated_at`
 * filter (only order_by/cursor/per_page — doc-verified), so paging is newest-
 * first with an EARLY STOP once an item at/older than the watermark is reached,
 * plus a hard page cap. A Plane rate-limit/outage stops that project's run
 * WITHOUT advancing its watermark, so the next cycle resumes and nothing is
 * dropped; idempotency makes the re-processing safe.
 *
 * First-run / very-large-project note: with no server-side time filter, the
 * newest-first scan cannot bulk-backfill a project whose changed backlog exceeds
 * the page cap in a single run. When the cap is hit the watermark is still
 * advanced (to guarantee forward progress into steady state) and a WARNING is
 * surfaced in the run summary — never a silent skip. Reconciliation is a drift
 * backstop, not a bulk importer; steady-state deltas are tiny and never hit the
 * cap. Raise maxPagesPerProject for a one-off large backfill.
 *
 * Observability (AC #4): reconcile() returns a {@link ReconcileRunSummary}
 * (duration, per-outcome counts, pages, warnings, errors) that the worker
 * persists to plugin state and logs.
 */

import { PlaneApiError, type PlaneListWorkItem, type PlaneReconcilePort } from "./plane-client.js";
import type { IdMappingStore } from "./id-mapping.js";
import { upsertMappedIssue, type IssueUpsertDeps, type SyncRule } from "./sync-rules.js";

/** Plugin-state K/V slice this job persists its per-project watermark in. */
export interface ReconcileStateStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ReconcileRunSummary {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** Number of mapped projects reconciled this run. */
  projects: number;
  pagesFetched: number;
  /** Items examined (changed since the watermark). */
  scanned: number;
  created: number;
  updated: number;
  staled: number;
  skipped: number;
  /** created + updated + staled — the AC #1 "healed count". */
  healed: number;
  /** Non-fatal notes (e.g. page cap reached for a project). */
  warnings: string[];
  /** Fatal per-project halts (rate limit / outage); watermark not advanced. */
  errors: string[];
  /** True when no project halted with an error. */
  ok: boolean;
}

export interface ReconcileDeps {
  /** Live sync rules (same config the webhook path reads). */
  getRules(): Promise<SyncRule[]>;
  /** Plane paging (PCLIP-7 REST client). */
  plane: PlaneReconcilePort;
  /** Shared idempotent upsert deps (issues + idMapping.link + originKind + log). */
  upsert: IssueUpsertDeps;
  /** Mapping reads + stale (never delete) for label-loss handling. */
  idMapping: Pick<IdMappingStore, "resolveByPlaneId" | "markStaleByPlaneId">;
  /** Per-project watermark persistence. */
  state: ReconcileStateStore;
  log(message: string, fields?: Record<string, unknown>): void;
  now?: () => number;
  /** Hard cap on pages per project per run (defensive; default 50 = 5000 items). */
  maxPagesPerProject?: number;
  /** Page size, Plane max 100 (default 100). */
  perPage?: number;
}

export interface Reconciler {
  reconcile(runId?: string): Promise<ReconcileRunSummary>;
}

/** Per-project watermark key (ISO8601 of the newest reconciled updated_at). */
export function watermarkKey(planeProjectId: string): string {
  return `reconcile:watermark:${planeProjectId}`;
}

function toMs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** Case-insensitive membership: does the item carry the rule's label UUID? */
function passesLabelFilter(rule: SyncRule, item: PlaneListWorkItem): boolean {
  if (!rule.labelFilter) return true;
  const f = rule.labelFilter.toLowerCase();
  return item.labels.some((l) => l.toLowerCase() === f);
}

// Mutable accumulator shared across a run (kept internal).
interface Acc extends Omit<ReconcileRunSummary, "finishedAt" | "durationMs" | "healed" | "ok"> {}

export function createReconciler(deps: ReconcileDeps): Reconciler {
  const now = deps.now ?? Date.now;
  const maxPages = Math.max(1, deps.maxPagesPerProject ?? 50);
  const perPage = Math.min(Math.max(deps.perPage ?? 100, 1), 100);

  async function reconcileItem(rule: SyncRule, item: PlaneListWorkItem, acc: Acc): Promise<void> {
    if (!passesLabelFilter(rule, item)) {
      // Lost/lacking the qualifying label: stop syncing it — stale a live mapping
      // (auditable, never delete). Unmapped + non-qualifying: nothing to do.
      const mapped = await deps.idMapping.resolveByPlaneId(item.id, "issue", { includeStale: true });
      if (mapped && !mapped.stale) {
        await deps.idMapping.markStaleByPlaneId(item.id);
        acc.staled++;
        deps.log("reconcile staled mapping (label no longer qualifies)", { planeId: item.id });
      } else {
        acc.skipped++;
      }
      return;
    }
    const title = item.name && item.name.trim() ? item.name : `Plane issue ${item.id}`;
    const res = await upsertMappedIssue(deps.upsert, {
      rule,
      planeId: item.id,
      title,
      description: item.descriptionHtml,
    });
    if (res.kind === "created") acc.created++;
    else acc.updated++;
  }

  async function reconcileProject(rule: SyncRule, acc: Acc): Promise<void> {
    const wmKey = watermarkKey(rule.planeProjectId);
    const rawWm = await deps.state.get(wmKey);
    const watermark = typeof rawWm === "string" ? rawWm : undefined;
    const wmMs = toMs(watermark);

    let newestMs = wmMs;
    let newestIso = watermark;
    let cursor: string | undefined;
    let pages = 0;
    let reachedWatermark = false;

    try {
      while (pages < maxPages) {
        const page = await deps.plane.listProjectWorkItems({
          projectId: rule.planeProjectId,
          cursor,
          perPage,
          orderBy: "-updated_at",
        });
        pages++;
        acc.pagesFetched++;

        for (const item of page.items) {
          if (!item.id) continue;
          const itemMs = toMs(item.updatedAt);
          // Early stop: newest-first, so an item at/older than the watermark means
          // everything remaining was reconciled in a prior run.
          if (wmMs !== undefined && itemMs !== undefined && itemMs <= wmMs) {
            reachedWatermark = true;
            break;
          }
          acc.scanned++;
          await reconcileItem(rule, item, acc);
          if (itemMs !== undefined && (newestMs === undefined || itemMs > newestMs)) {
            newestMs = itemMs;
            newestIso = item.updatedAt;
          }
        }

        if (reachedWatermark || !page.hasMore) break;
        cursor = page.nextCursor;
      }

      if (!reachedWatermark && pages >= maxPages) {
        // Progress is still made (watermark advances below), but older changed
        // items beyond the cap were not scanned this run — surface it, never silent.
        const msg = `project ${rule.planeProjectId}: page cap (${maxPages}) reached; items older than this run were not scanned — raise maxPagesPerProject or rely on webhook sync for backfill`;
        acc.warnings.push(msg);
        deps.log("reconcile page cap reached", { projectId: rule.planeProjectId, maxPages });
      }

      // Advance the watermark only after a clean page loop (no fetch error).
      if (newestIso && newestIso !== watermark) {
        await deps.state.set(wmKey, newestIso);
      }
    } catch (e) {
      // Rate limit / outage: DO NOT advance the watermark — resume next cycle.
      // Idempotency makes re-scanning the same window safe (AC #2, #3).
      const kind = e instanceof PlaneApiError ? e.kind : "unknown";
      acc.errors.push(`project ${rule.planeProjectId}: halted (${kind})`);
      deps.log("reconcile project halted (will resume next cycle)", {
        projectId: rule.planeProjectId,
        error: kind,
      });
    }
  }

  return {
    async reconcile(runId?: string): Promise<ReconcileRunSummary> {
      const startedAt = now();
      const acc: Acc = {
        startedAt,
        projects: 0,
        pagesFetched: 0,
        scanned: 0,
        created: 0,
        updated: 0,
        staled: 0,
        skipped: 0,
        warnings: [],
        errors: [],
      };

      const rules = await deps.getRules();
      for (const rule of rules) {
        acc.projects++;
        await reconcileProject(rule, acc);
      }

      const finishedAt = now();
      const healed = acc.created + acc.updated + acc.staled;
      const summary: ReconcileRunSummary = {
        ...acc,
        finishedAt,
        durationMs: finishedAt - startedAt,
        healed,
        ok: acc.errors.length === 0,
      };
      deps.log("reconcile run complete", {
        runId,
        durationMs: summary.durationMs,
        projects: summary.projects,
        scanned: summary.scanned,
        healed: summary.healed,
        created: summary.created,
        updated: summary.updated,
        staled: summary.staled,
        skipped: summary.skipped,
        pagesFetched: summary.pagesFetched,
        warnings: summary.warnings.length,
        errors: summary.errors.length,
        ok: summary.ok,
      });
      return summary;
    },
  };
}
