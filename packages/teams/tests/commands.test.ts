import { describe, expect, it } from "vitest";
import {
  dispatchCommand,
  issueFilterFromArg,
  parseCommand,
  statusBadge,
  MAX_ISSUE_LINKS,
  type CommandDeps,
  type CommandAgent,
  type CommandIssue,
} from "../src/commands.js";
import { validateAdaptiveCard, type AdaptiveCard } from "../src/adaptive-card.js";

const AGENTS: CommandAgent[] = [
  { name: "Builder", status: "running" },
  { name: "Reviewer", status: "active" },
  { name: "Idle One", status: "idle" },
  { name: "Crashed", status: "failed" },
];
const DONE: CommandIssue[] = [{ title: "Ship v1", status: "done" }];
const OPEN_ISSUES: CommandIssue[] = [
  { title: "Fix login", status: "todo", url: "https://pc.example.com/p/PCLIP/issues/PCLIP-1" },
  { title: "Add search", status: "in_progress", url: "https://pc.example.com/p/PCLIP/issues/PCLIP-2" },
];

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    listAgents: async () => AGENTS,
    listRecentCompletions: async () => DONE,
    listIssues: async () => OPEN_ISSUES,
    approve: async () => ({ ok: true, verb: "approve" }),
    ...over,
  };
}

const ok = (c: AdaptiveCard) => expect(validateAdaptiveCard(c)).toEqual({ ok: true, errors: [] });

describe("parseCommand", () => {
  it("strips <at> mention spans and parses the command + args", () => {
    expect(parseCommand("<at>Paperclip</at> issues open")).toMatchObject({ command: "issues", args: ["open"] });
  });
  it("strips a leading @mention token", () => {
    expect(parseCommand("@Paperclip status")).toMatchObject({ command: "status", args: [] });
  });
  it("is case-insensitive; keeps the raw token", () => {
    expect(parseCommand("STATUS")).toMatchObject({ command: "status", raw: "STATUS" });
  });
  it("empty or whitespace → help", () => {
    expect(parseCommand("").command).toBe("help");
    expect(parseCommand("   ").command).toBe("help");
    expect(parseCommand("<at>Paperclip</at>").command).toBe("help");
  });
  it("unknown command → help, preserving the raw token", () => {
    expect(parseCommand("frobnicate now")).toMatchObject({ command: "help", raw: "frobnicate", args: ["now"] });
  });
  it("approve keeps its id arg", () => {
    expect(parseCommand("approve ap-123")).toMatchObject({ command: "approve", args: ["ap-123"] });
  });
});

describe("issueFilterFromArg + statusBadge", () => {
  it("maps issue filters", () => {
    expect(issueFilterFromArg("open")).toBe("open");
    expect(issueFilterFromArg("done")).toBe("done");
    expect(issueFilterFromArg(undefined)).toBe("all");
    expect(issueFilterFromArg("weird")).toBe("all");
  });
  it("badges active vs done vs failed distinctly", () => {
    expect(statusBadge("running")).toBe(statusBadge("active"));
    expect(statusBadge("done")).not.toBe(statusBadge("running"));
    expect(statusBadge("failed")).not.toBe(statusBadge("done"));
  });
});

describe("dispatchCommand", () => {
  it("status: filters to active agents + shows completions (AC #1)", async () => {
    const { card, command } = await dispatchCommand(parseCommand("status"), deps());
    expect(command).toBe("status");
    ok(card);
    const json = JSON.stringify(card);
    expect(json).toContain("Builder");   // running
    expect(json).toContain("Reviewer");  // active
    expect(json).not.toContain("Idle One"); // idle filtered out of the ACTIVE list
    expect(json).toContain("Ship v1");   // completion
  });

  it("agents: lists all agents with status", async () => {
    const { card } = await dispatchCommand(parseCommand("agents"), deps());
    ok(card);
    expect(JSON.stringify(card)).toContain("Idle One"); // agents shows everyone
  });

  it("issues open: renders Action.OpenUrl deep links (AC #2)", async () => {
    const { card } = await dispatchCommand(parseCommand("issues open"), deps());
    ok(card);
    const links = (card.actions ?? []).filter((a) => a.type === "Action.OpenUrl");
    expect(links.length).toBe(2);
    expect(links.every((a) => typeof a.url === "string" && a.url.startsWith("https://"))).toBe(true);
  });

  it("issues: caps Action.OpenUrl at MAX_ISSUE_LINKS", async () => {
    const many = Array.from({ length: MAX_ISSUE_LINKS + 4 }, (_, i) => ({ title: `I${i}`, status: "todo", url: `https://pc/i/${i}` }));
    const { card } = await dispatchCommand(parseCommand("issues"), deps({ listIssues: async () => many }));
    expect((card.actions ?? []).filter((a) => a.type === "Action.OpenUrl").length).toBe(MAX_ISSUE_LINKS);
  });

  it("issues: empty renders a no-issues card, not silence", async () => {
    const { card } = await dispatchCommand(parseCommand("issues done"), deps({ listIssues: async () => [] }));
    ok(card);
    expect(JSON.stringify(card)).toMatch(/No done issues/i);
  });

  it("approve <id>: success card (AC #3)", async () => {
    const { card } = await dispatchCommand(parseCommand("approve ap-1"), deps());
    ok(card);
    expect(JSON.stringify(card)).toContain("Approved approval");
  });

  it("approve: API rejection → polite failure card, never silence", async () => {
    const { card } = await dispatchCommand(parseCommand("approve ap-1"), deps({ approve: async () => ({ ok: false, error: "approval not found (404)" }) }));
    ok(card);
    expect(JSON.stringify(card)).toMatch(/Couldn't approve/i);
  });

  it("approve when approvals not configured (no approve dep) → polite refusal (AC #3)", async () => {
    const { card } = await dispatchCommand(parseCommand("approve ap-1"), deps({ approve: undefined }));
    ok(card);
    expect(JSON.stringify(card)).toMatch(/aren't enabled/i);
  });

  it("approve without an id → usage card", async () => {
    const { card } = await dispatchCommand(parseCommand("approve"), deps());
    ok(card);
    expect(JSON.stringify(card)).toMatch(/Usage/i);
  });

  it("unknown command → help card naming the bad token (AC #4)", async () => {
    const { card, command } = await dispatchCommand(parseCommand("frobnicate"), deps());
    expect(command).toBe("help");
    ok(card);
    expect(JSON.stringify(card)).toContain("frobnicate");
  });

  it("help → help card without an 'unknown' note", async () => {
    const { card } = await dispatchCommand(parseCommand("help"), deps());
    ok(card);
    expect(JSON.stringify(card)).not.toMatch(/Unknown command/i);
  });
});
