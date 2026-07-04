import { describe, expect, it } from "vitest";
import { createReconciler, watermarkKey, type ReconcileStateStore } from "../src/reconcile.js";
import { PlaneApiError, type PlaneListWorkItem, type PlaneWorkItemPage } from "../src/plane-client.js";
import type { IssueUpsertDeps, SyncRule } from "../src/sync-rules.js";

const ORIGIN = "plugin:test" as const;
const RULE: SyncRule = { planeProjectId: "proj-1", companyId: "co-1", paperclipProjectId: "pp-1" };

function wi(id: string, updatedAt: string, extra: Partial<PlaneListWorkItem> = {}): PlaneListWorkItem {
  return { id, name: `Item ${id}`, descriptionHtml: `<p>${id}</p>`, updatedAt, labels: [], state: "s1", ...extra };
}

/** In-memory ctx.issues fake keyed by origin (emulates the unique-origin guard). */
function makeIssues() {
  const byOrigin = new Map<string, string>();
  const updated: string[] = [];
  let seq = 0;
  const key = (companyId: string, projectId: string, originKind: string, originId: string) =>
    `${companyId}|${projectId}|${originKind}|${originId}`;
  const port: IssueUpsertDeps["issues"] = {
    findByOrigin: async ({ companyId, projectId, originKind, originId }) => {
      const id = byOrigin.get(key(companyId, projectId, originKind, originId));
      return id ? { id } : null;
    },
    create: async ({ companyId, projectId, originKind, originId }) => {
      const id = `pc-${++seq}`;
      byOrigin.set(key(companyId, projectId, originKind, originId), id);
      return { id };
    },
    update: async ({ issueId }) => void updated.push(issueId),
  };
  return { port, updated, createdCount: () => seq };
}

/** In-memory PCLIP-6 mapping fake (forward Plane-id keyed). */
function makeMapping() {
  const fwd = new Map<string, { paperclipIssueId: string; stale: boolean }>();
  const port = {
    resolveByPlaneId: async (planeId: string, _type?: string, opts?: { includeStale?: boolean }) => {
      const r = fwd.get(planeId);
      if (!r) return null;
      if (r.stale && !opts?.includeStale) return null;
      return { planeId, paperclipIssueId: r.paperclipIssueId, planeType: "issue", stale: r.stale };
    },
    link: async ({ planeId, paperclipIssueId }: { planeId: string; paperclipIssueId: string }) => {
      fwd.set(planeId, { paperclipIssueId, stale: false });
      return { planeId, paperclipIssueId, planeType: "issue", stale: false };
    },
    markStaleByPlaneId: async (planeId: string) => {
      const r = fwd.get(planeId);
      if (!r) return null;
      r.stale = true;
      return { planeId, paperclipIssueId: r.paperclipIssueId, planeType: "issue", stale: true };
    },
  };
  return { port, fwd };
}

/** Paginating Plane fake: serves items newest-first (as order_by=-updated_at would). */
function makePlane(itemsByProject: Record<string, PlaneListWorkItem[]>, fail?: { onCall: number; error: PlaneApiError }) {
  let calls = 0;
  const listProjectWorkItems = async (input: {
    projectId: string;
    cursor?: string;
    perPage?: number;
  }): Promise<PlaneWorkItemPage> => {
    calls++;
    if (fail && calls === fail.onCall) throw fail.error;
    const perPage = input.perPage ?? 100;
    const all = [...(itemsByProject[input.projectId] ?? [])].sort(
      (a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0),
    );
    const start = input.cursor ? Number(input.cursor) : 0;
    const items = all.slice(start, start + perPage);
    const nextStart = start + perPage;
    const hasMore = nextStart < all.length;
    return { items, nextCursor: hasMore ? String(nextStart) : undefined, hasMore };
  };
  return { port: { listProjectWorkItems }, callCount: () => calls };
}

function makeState(): ReconcileStateStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

function makeReconciler(opts: {
  items: Record<string, PlaneListWorkItem[]>;
  rules?: SyncRule[];
  perPage?: number;
  maxPages?: number;
  fail?: { onCall: number; error: PlaneApiError };
  state?: ReturnType<typeof makeState>;
}) {
  const issues = makeIssues();
  const mapping = makeMapping();
  const plane = makePlane(opts.items, opts.fail);
  const state = opts.state ?? makeState();
  const reconciler = createReconciler({
    getRules: async () => opts.rules ?? [RULE],
    plane: plane.port,
    upsert: { idMapping: mapping.port, issues: issues.port, originKind: ORIGIN, log: () => {} },
    idMapping: mapping.port,
    state,
    log: () => {},
    now: () => 1_000,
    perPage: opts.perPage,
    maxPagesPerProject: opts.maxPages,
  });
  return { reconciler, issues, mapping, plane, state };
}

describe("reconcile (PCLIP-5)", () => {
  it("heals a missed create — unmapped item is created (AC #1)", async () => {
    const h = makeReconciler({ items: { "proj-1": [wi("i1", "2026-07-04T10:00:00Z")] } });
    const s = await h.reconciler.reconcile("run-1");
    expect(s).toMatchObject({ created: 1, updated: 0, staled: 0, healed: 1, ok: true });
    expect(h.issues.createdCount()).toBe(1);
    expect(h.mapping.fwd.get("i1")).toMatchObject({ stale: false });
    // watermark advanced to the newest updated_at
    expect(h.state.map.get(watermarkKey("proj-1"))).toBe("2026-07-04T10:00:00Z");
  });

  it("heals a missed update and is idempotent across runs — no duplicate (AC #1, #2)", async () => {
    const items = { "proj-1": [wi("i1", "2026-07-04T10:00:00Z")] };
    const h = makeReconciler({ items });
    await h.reconciler.reconcile("run-1"); // creates pc-1, watermark = 10:00
    // Plane item changes again (newer than the watermark).
    items["proj-1"] = [wi("i1", "2026-07-04T11:00:00Z")];
    const s2 = await h.reconciler.reconcile("run-2");
    expect(s2).toMatchObject({ created: 0, updated: 1, healed: 1, ok: true });
    // Still exactly one Paperclip issue for this origin (idempotent by origin).
    expect(h.issues.createdCount()).toBe(1);
    expect(h.issues.updated).toEqual(["pc-1"]);
    expect(h.state.map.get(watermarkKey("proj-1"))).toBe("2026-07-04T11:00:00Z");
  });

  it("stops early at the watermark — older items are not re-scanned (AC #3 bounded)", async () => {
    const state = makeState();
    state.map.set(watermarkKey("proj-1"), "2026-07-04T10:00:00Z");
    const h = makeReconciler({
      state,
      items: {
        "proj-1": [
          wi("new", "2026-07-04T11:00:00Z"),
          wi("edge", "2026-07-04T10:00:00Z"), // == watermark -> stop here
          wi("old", "2026-07-04T09:00:00Z"),
        ],
      },
    });
    const s = await h.reconciler.reconcile("run-1");
    expect(s.scanned).toBe(1); // only "new"
    expect(h.issues.createdCount()).toBe(1);
    expect(h.state.map.get(watermarkKey("proj-1"))).toBe("2026-07-04T11:00:00Z");
  });

  it("pages through a large project until exhausted (AC #3)", async () => {
    const items = Array.from({ length: 5 }, (_, i) => wi(`i${i}`, `2026-07-04T1${i}:00:00Z`));
    const h = makeReconciler({ items: { "proj-1": items }, perPage: 2, maxPages: 10 });
    const s = await h.reconciler.reconcile("run-1");
    expect(s.scanned).toBe(5);
    expect(s.pagesFetched).toBe(3); // 2 + 2 + 1
    expect(h.issues.createdCount()).toBe(5);
  });

  it("enforces the page cap defensively and warns (AC #3 no unbounded loop)", async () => {
    const items = Array.from({ length: 6 }, (_, i) => wi(`i${i}`, `2026-07-04T1${i}:00:00Z`));
    const h = makeReconciler({ items: { "proj-1": items }, perPage: 2, maxPages: 2 });
    const s = await h.reconciler.reconcile("run-1");
    expect(s.pagesFetched).toBe(2); // capped
    expect(s.scanned).toBe(4);
    expect(s.warnings.some((w) => w.includes("page cap"))).toBe(true);
    expect(s.ok).toBe(true); // a cap is a warning, not a failure
  });

  it("halts a project on a rate limit WITHOUT advancing the watermark (AC #3 respect limits)", async () => {
    const state = makeState();
    state.map.set(watermarkKey("proj-1"), "2026-07-04T08:00:00Z");
    const h = makeReconciler({
      state,
      items: { "proj-1": [wi("i1", "2026-07-04T12:00:00Z")] },
      fail: { onCall: 1, error: new PlaneApiError("rate_limited", 429, "slow down", 30) },
    });
    const s = await h.reconciler.reconcile("run-1");
    expect(s.ok).toBe(false);
    expect(s.errors.some((e) => e.includes("rate_limited"))).toBe(true);
    // watermark preserved so the next cycle resumes; nothing dropped
    expect(h.state.map.get(watermarkKey("proj-1"))).toBe("2026-07-04T08:00:00Z");
    expect(h.issues.createdCount()).toBe(0);
  });

  it("stales a mapping that lost its qualifying label; skips unmapped non-matching (PCLIP-2 parity)", async () => {
    const rule: SyncRule = { ...RULE, labelFilter: "lbl-1" };
    const h = makeReconciler({
      rules: [rule],
      items: {
        "proj-1": [
          wi("keep", "2026-07-04T12:00:00Z", { labels: ["lbl-1"] }), // qualifies -> heal
          wi("lost", "2026-07-04T11:00:00Z", { labels: [] }), // was mapped, now no label -> stale
          wi("never", "2026-07-04T10:00:00Z", { labels: [] }), // unmapped + no label -> skip
        ],
      },
    });
    // pre-map "lost" as an active mapping
    await h.mapping.port.link({ planeId: "lost", paperclipIssueId: "pc-existing" });
    const s = await h.reconciler.reconcile("run-1");
    expect(s).toMatchObject({ created: 1, staled: 1, skipped: 1, ok: true });
    expect(s.healed).toBe(2); // created + staled
    expect(h.mapping.fwd.get("lost")).toMatchObject({ stale: true });
  });

  it("reports duration and per-outcome counts for observability (AC #4)", async () => {
    const h = makeReconciler({ items: { "proj-1": [wi("i1", "2026-07-04T10:00:00Z")] } });
    const s = await h.reconciler.reconcile("run-1");
    expect(s).toMatchObject({ projects: 1, durationMs: 0, startedAt: 1000, finishedAt: 1000 });
    expect(typeof s.healed).toBe("number");
    expect(Array.isArray(s.errors)).toBe(true);
  });

  it("no rules -> a clean no-op run", async () => {
    const h = makeReconciler({ items: {}, rules: [] });
    const s = await h.reconciler.reconcile("run-1");
    expect(s).toMatchObject({ projects: 0, scanned: 0, healed: 0, ok: true });
  });
});
