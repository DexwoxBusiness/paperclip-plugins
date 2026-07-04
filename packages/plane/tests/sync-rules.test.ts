import { describe, expect, it } from "vitest";
import type { ParsedPlaneEvent } from "../src/plane-events.js";
import {
  createSyncRulesHandler,
  evaluateSyncDecision,
  extractIssueLabels,
  normalizeSyncRules,
  validateSyncRulesConfig,
  type IssuesPort,
  type ProjectLookupPort,
  type SyncRule,
} from "../src/sync-rules.js";

const ORIGIN = "plugin:dexwox.plane-sync" as const;
const RULE: SyncRule = { planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "pcproj-B", labelFilter: "lbl-agent" };

function issueEvent(overrides: Partial<ParsedPlaneEvent> = {}, data: Record<string, unknown> = {}): ParsedPlaneEvent {
  return {
    event: "issue",
    action: "created",
    entityId: "plane-1",
    projectId: "P-A",
    workspaceId: "ws",
    payload: {
      event: "issue",
      action: "created",
      data: { id: "plane-1", project: "P-A", name: "Title", description_html: "<p>d</p>", labels: ["lbl-agent"], ...data },
    } as ParsedPlaneEvent["payload"],
    ...overrides,
  };
}

function makeIssues() {
  const byId = new Map<string, { id: string; companyId: string; projectId?: string; title?: string; description?: string; originKind?: string; originId?: string }>();
  let seq = 0;
  const created: string[] = [];
  const port: IssuesPort = {
    async findByOrigin({ companyId, projectId, originKind, originId }) {
      for (const i of byId.values()) {
        if (i.companyId === companyId && i.projectId === projectId && i.originKind === originKind && i.originId === originId) return { id: i.id };
      }
      return null;
    },
    async create(input) {
      const id = `pc-${++seq}`;
      byId.set(id, { id, ...input });
      created.push(id);
      return { id };
    },
    async update({ issueId, title, description }) {
      const i = byId.get(issueId);
      if (i) {
        i.title = title;
        i.description = description;
      }
    },
  };
  return { port, byId, created };
}

function makeIdMapping() {
  const fwd = new Map<string, { paperclipIssueId: string; stale: boolean }>();
  return {
    fwd,
    resolveByPlaneId: async (planeId: string) => {
      const r = fwd.get(planeId);
      return r && !r.stale ? { planeId, paperclipIssueId: r.paperclipIssueId, planeType: "issue", stale: false } : null;
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
}

function makeHandler(rules: SyncRule[], overrides: Partial<{ idMapping: ReturnType<typeof makeIdMapping>; issues: IssuesPort }> = {}) {
  const issues = makeIssues();
  const idMapping = overrides.idMapping ?? makeIdMapping();
  const logs: string[] = [];
  const handler = createSyncRulesHandler({
    getRules: async () => rules,
    idMapping,
    issues: overrides.issues ?? issues.port,
    originKind: ORIGIN,
    log: (m) => void logs.push(m),
  });
  return { handler, issues, idMapping, logs };
}

describe("normalizeSyncRules", () => {
  it("returns [] for non-array and drops malformed / trims valid", () => {
    expect(normalizeSyncRules(undefined)).toEqual([]);
    expect(normalizeSyncRules("x")).toEqual([]);
    const rules = normalizeSyncRules([
      { planeProjectId: " P-A ", companyId: "co-1", paperclipProjectId: "pcproj-B", labelFilter: " lbl " },
      { planeProjectId: "P-B" }, // missing fields -> dropped
      42,
    ]);
    expect(rules).toEqual([{ planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "pcproj-B", labelFilter: "lbl" }]);
  });

  it("lowercases planeProjectId so uppercase config still matches events (Kody)", () => {
    const rules = normalizeSyncRules([{ planeProjectId: "ABC-Def-01", companyId: "co-1", paperclipProjectId: "p" }]);
    expect(rules[0].planeProjectId).toBe("abc-def-01");
  });
});

describe("extractIssueLabels", () => {
  it("handles string[] and object[] label shapes", () => {
    expect([...extractIssueLabels({ data: { labels: ["a", "b"] } })].sort()).toEqual(["a", "b"]);
    expect([...extractIssueLabels({ data: { labels: [{ id: "id1", name: "Agent" }] } })].sort()).toEqual(["agent", "id1"]);
    expect([...extractIssueLabels({ data: {} })]).toEqual([]);
  });
});

describe("evaluateSyncDecision (PCLIP-2)", () => {
  it("skips non-issue events", () => {
    expect(evaluateSyncDecision(issueEvent({ event: "issue_comment" }), [RULE])).toMatchObject({ kind: "skip", reason: "not-an-issue-event" });
  });
  it("skips when no mapping exists for the project (AC #3)", () => {
    expect(evaluateSyncDecision(issueEvent({ projectId: "P-Z" }), [RULE])).toMatchObject({ kind: "skip", reason: "no-mapping" });
  });
  it("skips when the label filter is not satisfied (AC #2)", () => {
    expect(evaluateSyncDecision(issueEvent({}, { labels: ["other"] }), [RULE])).toMatchObject({ kind: "skip", reason: "label-filter" });
  });
  it("syncs when project maps and the label is present (AC #1)", () => {
    expect(evaluateSyncDecision(issueEvent(), [RULE])).toMatchObject({ kind: "sync" });
  });
});

describe("createSyncRulesHandler (PCLIP-2)", () => {
  it("creates a Paperclip issue for a labeled issue in a mapped project (AC #1)", async () => {
    const { handler, issues, idMapping } = makeHandler([RULE]);
    const out = await handler.handle(issueEvent());
    expect(out).toMatchObject({ kind: "created" });
    expect(issues.created).toHaveLength(1);
    const created = issues.byId.get(issues.created[0])!;
    expect(created).toMatchObject({ companyId: "co-1", projectId: "pcproj-B", originKind: ORIGIN, originId: "plane-1", title: "Title" });
    expect(idMapping.fwd.get("plane-1")?.paperclipIssueId).toBe(created.id); // linked
  });

  it("creates nothing for an unlabeled issue under a label filter (AC #2)", async () => {
    const { handler, issues } = makeHandler([RULE]);
    const out = await handler.handle(issueEvent({}, { labels: [] }));
    expect(out).toMatchObject({ kind: "skipped", reason: "label-filter" });
    expect(issues.created).toHaveLength(0);
  });

  it("acknowledges and skips events for an unmapped project without error (AC #3)", async () => {
    const { handler, issues } = makeHandler([RULE]);
    const out = await handler.handle(issueEvent({ projectId: "P-Z" }));
    expect(out).toMatchObject({ kind: "skipped", reason: "no-mapping" });
    expect(issues.created).toHaveLength(0);
  });

  it("updates in place when the issue is already mapped", async () => {
    const { handler, issues, idMapping } = makeHandler([RULE]);
    await idMapping.link({ planeId: "plane-1", paperclipIssueId: "pc-existing" });
    // P2-created issues carry origin metadata; the update path finds them by origin.
    issues.byId.set("pc-existing", { id: "pc-existing", companyId: "co-1", projectId: "pcproj-B", originKind: ORIGIN, originId: "plane-1" });
    const out = await handler.handle(issueEvent({ action: "updated" }, { name: "New title" }));
    expect(out).toMatchObject({ kind: "updated", paperclipIssueId: "pc-existing" });
    expect(issues.created).toHaveLength(0);
    expect(issues.byId.get("pc-existing")?.title).toBe("New title");
  });

  it("no rule with no label filter still creates (project mapping only)", async () => {
    const rule: SyncRule = { planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "pcproj-B" };
    const { handler, issues } = makeHandler([rule]);
    const out = await handler.handle(issueEvent({}, { labels: [] }));
    expect(out).toMatchObject({ kind: "created" });
    expect(issues.created).toHaveLength(1);
  });

  it("is idempotent: a create whose link failed is re-linked on retry, not duplicated (standard #1)", async () => {
    const idMapping = makeIdMapping();
    let failLinkOnce = true;
    const originalLink = idMapping.link;
    idMapping.link = async (args) => {
      if (failLinkOnce) {
        failLinkOnce = false;
        throw new Error("transient link failure after create");
      }
      return originalLink(args);
    };
    const { handler, issues } = makeHandler([RULE], { idMapping });

    await expect(handler.handle(issueEvent())).rejects.toThrow("transient");
    expect(issues.created).toHaveLength(1); // created but not linked

    // Plane retry: resolveByPlaneId is null, but findByOrigin finds the orphan.
    const out = await handler.handle(issueEvent());
    expect(out).toMatchObject({ kind: "updated" });
    expect(issues.created).toHaveLength(1); // NOT duplicated
    expect(idMapping.fwd.get("plane-1")?.paperclipIssueId).toBe(issues.created[0]);
  });

  it("marks the mapping stale when the Plane issue is deleted (never deletes the Paperclip issue)", async () => {
    const { handler, issues, idMapping } = makeHandler([RULE]);
    await idMapping.link({ planeId: "plane-1", paperclipIssueId: "pc-1" });
    const out = await handler.handle(issueEvent({ action: "deleted" }));
    expect(out).toMatchObject({ kind: "staled", paperclipIssueId: "pc-1" });
    expect(idMapping.fwd.get("plane-1")?.stale).toBe(true);
    expect(issues.created).toHaveLength(0);
  });

  it("skips a delete for an unmapped issue", async () => {
    const { handler } = makeHandler([RULE]);
    const out = await handler.handle(issueEvent({ action: "deleted", entityId: "ghost" }));
    expect(out).toMatchObject({ kind: "skipped", reason: "deleted-unmapped" });
  });

  it("stales an already-synced issue when its qualifying label is removed on update (label filter is authoritative)", async () => {
    const { handler, issues, idMapping } = makeHandler([RULE]);
    issues.byId.set("pc-1", { id: "pc-1", companyId: "co-1" });
    await idMapping.link({ planeId: "plane-1", paperclipIssueId: "pc-1" });
    // update event with the label removed
    const out = await handler.handle(issueEvent({ action: "updated" }, { labels: [] }));
    expect(out).toMatchObject({ kind: "staled", paperclipIssueId: "pc-1" });
    expect(idMapping.fwd.get("plane-1")?.stale).toBe(true);
  });

  it("skips issue_comment events — comment mirroring is out of PCLIP-2 scope (no error)", async () => {
    const { handler, issues } = makeHandler([RULE]);
    const out = await handler.handle(issueEvent({ event: "issue_comment" }));
    expect(out).toMatchObject({ kind: "skipped", reason: "not-an-issue-event" });
    expect(issues.created).toHaveLength(0);
  });

  it("matches the project rule case-insensitively (Kody: uppercase config UUID)", async () => {
    const upper = "ABCDEF01-1111-4111-8111-111111111111";
    const rule: SyncRule = { planeProjectId: upper, companyId: "co-1", paperclipProjectId: "pcproj-B" };
    const { handler, issues } = makeHandler([rule]);
    const lower = upper.toLowerCase();
    const out = await handler.handle(issueEvent({ projectId: lower }, { project: lower, labels: [] }));
    expect(out).toMatchObject({ kind: "created" });
    expect(issues.created).toHaveLength(1);
  });

  it("re-homes a Plane issue moved to a different mapped project (creates in the new target)", async () => {
    const rules: SyncRule[] = [
      { planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "projX" },
      { planeProjectId: "P-B", companyId: "co-2", paperclipProjectId: "projY" },
    ];
    const { handler, issues, idMapping } = makeHandler(rules);
    const first = await handler.handle(issueEvent({ projectId: "P-A" }, { project: "P-A", labels: [] }));
    expect(first).toMatchObject({ kind: "created" });
    const oldId = issues.created[0];
    expect(issues.byId.get(oldId)?.companyId).toBe("co-1");

    const second = await handler.handle(issueEvent({ projectId: "P-B", action: "updated" }, { project: "P-B", labels: [] }));
    expect(second).toMatchObject({ kind: "created" });
    expect(issues.created).toHaveLength(2);
    const newId = issues.created[1];
    expect(issues.byId.get(newId)?.companyId).toBe("co-2");
    expect(idMapping.fwd.get("plane-1")?.paperclipIssueId).toBe(newId);
  });

  it("re-homes a move to a different project in the SAME company (Kody: not stranded in old project)", async () => {
    const rules: SyncRule[] = [
      { planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "projX" },
      { planeProjectId: "P-B", companyId: "co-1", paperclipProjectId: "projY" }, // same company, different project
    ];
    const { handler, issues, idMapping } = makeHandler(rules);
    await handler.handle(issueEvent({ projectId: "P-A" }, { project: "P-A", labels: [] }));
    const oldId = issues.created[0];
    expect(issues.byId.get(oldId)?.projectId).toBe("projX");

    // Move A -> B within co-1: must create in projY, not update the projX issue.
    const moved = await handler.handle(issueEvent({ projectId: "P-B", action: "updated" }, { project: "P-B", labels: [] }));
    expect(moved).toMatchObject({ kind: "created" });
    expect(issues.created).toHaveLength(2);
    const newId = issues.created[1];
    expect(issues.byId.get(newId)?.projectId).toBe("projY");
    expect(idMapping.fwd.get("plane-1")?.paperclipIssueId).toBe(newId);

    // A subsequent update in projY updates the SAME issue — no further duplicates.
    const again = await handler.handle(issueEvent({ projectId: "P-B", action: "updated" }, { project: "P-B", name: "Renamed", labels: [] }));
    expect(again).toMatchObject({ kind: "updated", paperclipIssueId: newId });
    expect(issues.created).toHaveLength(2);
  });
});

describe("validateSyncRulesConfig (PCLIP-2 AC #5)", () => {
  const PA = "11111111-1111-4111-8111-111111111111"; // valid Plane project UUID
  const lookup = (known: Set<string>): ProjectLookupPort => ({
    projectExists: async (companyId, projectId) => known.has(`${companyId}/${projectId}`),
  });

  it("accepts valid rules whose Paperclip project exists", async () => {
    const res = await validateSyncRulesConfig(
      [{ planeProjectId: PA, companyId: "co-1", paperclipProjectId: "pcproj-B" }],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects an invalid (non-UUID) Plane project ID with a clear message (AC #5, Plane side)", async () => {
    const res = await validateSyncRulesConfig(
      [{ planeProjectId: "not-a-uuid", companyId: "co-1", paperclipProjectId: "pcproj-B" }],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/planeProjectId "not-a-uuid" is not a valid Plane project UUID/);
  });

  it("rejects unknown Paperclip project IDs with a clear message", async () => {
    const res = await validateSyncRulesConfig(
      [{ planeProjectId: PA, companyId: "co-1", paperclipProjectId: "ghost" }],
      lookup(new Set()),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/Paperclip project ghost not found in company co-1/);
  });

  it("rejects missing required fields and duplicate Plane project mappings", async () => {
    const res = await validateSyncRulesConfig(
      [
        { planeProjectId: PA, companyId: "co-1", paperclipProjectId: "pcproj-B" },
        { planeProjectId: PA, companyId: "co-1", paperclipProjectId: "pcproj-B" }, // dup
        { companyId: "co-1" }, // missing planeProjectId + paperclipProjectId
      ],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(new RegExp(`duplicate mapping for Plane project ${PA}`));
    expect(res.errors.join("\n")).toMatch(/planeProjectId is required/);
    expect(res.errors.join("\n")).toMatch(/paperclipProjectId is required/);
  });

  it("checks Paperclip existence for multiple rules concurrently (still reports each miss)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slowLookup: ProjectLookupPort = {
      projectExists: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        return false;
      },
    };
    const rules = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ].map((id) => ({ planeProjectId: id, companyId: "co-1", paperclipProjectId: `pc-${id}` }));
    const res = await validateSyncRulesConfig(rules, slowLookup);
    expect(res.ok).toBe(false);
    expect(res.errors.filter((e) => e.includes("not found"))).toHaveLength(3);
    expect(maxConcurrent).toBeGreaterThan(1); // ran in parallel, not sequentially
  });

  it("warns (not errors) on a non-UUID labelFilter", async () => {
    const res = await validateSyncRulesConfig(
      [{ planeProjectId: PA, companyId: "co-1", paperclipProjectId: "pcproj-B", labelFilter: "agent" }],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res.ok).toBe(true);
    expect(res.warnings.join("\n")).toMatch(/name-based label filtering needs the Plane client/);
  });

  it("detects duplicate Plane project mappings case-insensitively (Kody)", async () => {
    const res = await validateSyncRulesConfig(
      [
        { planeProjectId: PA.toUpperCase(), companyId: "co-1", paperclipProjectId: "pcproj-B" },
        { planeProjectId: PA, companyId: "co-1", paperclipProjectId: "pcproj-B" },
      ],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(new RegExp(`duplicate mapping for Plane project ${PA}`));
  });

  it("rejects a non-array config", async () => {
    const res = await validateSyncRulesConfig({ nope: true }, lookup(new Set()));
    expect(res).toMatchObject({ ok: false });
  });
});
