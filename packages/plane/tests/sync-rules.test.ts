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

const ORIGIN = "plugin:dexwox.plane-sync";
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
    async findByOrigin({ companyId, originKind, originId }) {
      for (const i of byId.values()) {
        if (i.companyId === companyId && i.originKind === originKind && i.originId === originId) return { id: i.id };
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
    issues.byId.set("pc-existing", { id: "pc-existing", companyId: "co-1" });
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
});

describe("validateSyncRulesConfig (PCLIP-2 AC #5)", () => {
  const lookup = (known: Set<string>): ProjectLookupPort => ({
    projectExists: async (companyId, projectId) => known.has(`${companyId}/${projectId}`),
  });

  it("accepts valid rules whose Paperclip project exists", async () => {
    const res = await validateSyncRulesConfig(
      [{ planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "pcproj-B" }],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects unknown Paperclip project IDs with a clear message", async () => {
    const res = await validateSyncRulesConfig(
      [{ planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "ghost" }],
      lookup(new Set()),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/Paperclip project ghost not found in company co-1/);
  });

  it("rejects missing required fields and duplicate Plane project mappings", async () => {
    const res = await validateSyncRulesConfig(
      [
        { planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "pcproj-B" },
        { planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "pcproj-B" }, // dup
        { companyId: "co-1" }, // missing planeProjectId + paperclipProjectId
      ],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/duplicate mapping for Plane project P-A/);
    expect(res.errors.join("\n")).toMatch(/planeProjectId is required/);
    expect(res.errors.join("\n")).toMatch(/paperclipProjectId is required/);
  });

  it("warns (not errors) on a non-UUID labelFilter", async () => {
    const res = await validateSyncRulesConfig(
      [{ planeProjectId: "P-A", companyId: "co-1", paperclipProjectId: "pcproj-B", labelFilter: "agent" }],
      lookup(new Set(["co-1/pcproj-B"])),
    );
    expect(res.ok).toBe(true);
    expect(res.warnings.join("\n")).toMatch(/name-based label filtering needs the Plane client/);
  });

  it("rejects a non-array config", async () => {
    const res = await validateSyncRulesConfig({ nope: true }, lookup(new Set()));
    expect(res).toMatchObject({ ok: false });
  });
});
