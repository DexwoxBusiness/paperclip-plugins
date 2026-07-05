/**
 * `@Paperclip` command set (PCLIP-27 / T10) — pure, SDK-decoupled logic.
 *
 * Parity with the Slack plugin's `/clip` commands:
 *   `@Paperclip status | agents | issues [open|done] | approve <id> | help`.
 *
 * Commands reach the v2 bot as @mention MESSAGE activities. bot.ts strips the mention and
 * passes the remaining text here; this module parses it, calls injected ctx-backed data
 * functions (so the core needs no SDK), and returns an Adaptive Card the bot posts back via
 * the Connector. Unknown/empty commands render help (never silence — AC #4).
 */

import { adaptiveCard, factSet, openUrlAction, textBlock, type AdaptiveCard, type CardAction } from "./adaptive-card.js";

// --------------------------------------------------------------------------
// Types (plain data — no SDK)
// --------------------------------------------------------------------------

export interface CommandAgent {
  name: string;
  status: string;
}
export interface CommandIssue {
  title: string;
  status: string;
  /** Deep link into Paperclip, when resolvable. */
  url?: string;
}
export interface CommandApproveResult {
  ok: boolean;
  /** The actual decision recorded by the server (idempotency-safe). */
  verb?: "approve" | "reject";
  error?: string;
}

/**
 * Injected data access — each function is backed by `ctx` in the worker, keeping this
 * module SDK-decoupled and unit-testable. `approve` is OPTIONAL: omit it to signal that
 * interactive approvals are not configured (no board key), which yields a polite refusal
 * card rather than silence (AC #3).
 */
export interface CommandDeps {
  listAgents(): Promise<CommandAgent[]>;
  /** Recently completed work (Paperclip "done" issues), for the status card. */
  listRecentCompletions(): Promise<CommandIssue[]>;
  listIssues(filter: IssueFilter): Promise<CommandIssue[]>;
  /**
   * Approve a pending approval. `opts.actor`/`opts.actorName` carry the acting Teams user
   * so the decision is attributed to the real person (audit parity with the T7 button flow),
   * not a generic label.
   */
  approve?(approvalId: string, opts: CommandActor): Promise<CommandApproveResult>;
}

/** The acting Teams user, threaded from the bot turn into approval attribution. */
export interface CommandActor {
  /** Paperclip actor id, e.g. `teams:{aadObjectId}`. */
  actor: string;
  /** The user's sanitized display name, for the decision note. */
  actorName?: string;
}

export type IssueFilter = "open" | "done" | "all";

/** Agent statuses considered "active" for the status card (mirrors the Slack plugin). */
export const ACTIVE_AGENT_STATUSES: ReadonlySet<string> = new Set(["active", "running"]);

/** Canonical commands we handle; anything else routes to help. */
export type CommandName = "status" | "agents" | "issues" | "approve" | "help";

export interface ParsedCommand {
  /** The canonical command (unknown/empty normalize to "help"). */
  command: CommandName;
  /** The raw first token as typed (for echoing an "unknown command" note). */
  raw: string;
  args: string[];
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(["status", "agents", "issues", "approve", "help"]);

/**
 * Parse an inbound message into a command. Strips Teams mention markup (`<at>…</at>`) and
 * any leading `@mention` tokens (the bot name may survive `removeRecipientMention` on some
 * clients), then takes the first remaining word as the command. Unknown or empty → help.
 */
export function parseCommand(text: string): ParsedCommand {
  const cleaned = (text ?? "")
    .replace(/<at\b[^>]*>.*?<\/at>/gi, " ") // strip <at>Paperclip</at> mention spans
    .replace(/&nbsp;/gi, " ")
    .trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  // Drop leading stray @mentions (e.g. "@Paperclip") the client may leave in the text.
  while (tokens.length && tokens[0].startsWith("@")) tokens.shift();
  const raw = tokens[0] ?? "";
  const lower = raw.toLowerCase();
  const command: CommandName = KNOWN_COMMANDS.has(lower) ? (lower as CommandName) : "help";
  return { command, raw, args: tokens.slice(1) };
}

/** Map an `issues` argument to a filter (mirrors Slack: open→todo, done→done, else all). */
export function issueFilterFromArg(arg: string | undefined): IssueFilter {
  const a = (arg ?? "").toLowerCase();
  return a === "open" ? "open" : a === "done" ? "done" : "all";
}

// --------------------------------------------------------------------------
// Cards
// --------------------------------------------------------------------------

/** Status glyph for an agent/issue status (text, so it renders identically everywhere). */
export function statusBadge(status: string): string {
  const s = (status ?? "").toLowerCase();
  if (ACTIVE_AGENT_STATUSES.has(s)) return "🟢";
  if (s === "done") return "✅";
  if (s === "paused" || s === "pending_approval") return "⏸️";
  if (s === "failed" || s === "error" || s === "terminated") return "🔴";
  return "⚪";
}

function bullets(lines: string[], emptyText: string) {
  return lines.length ? lines.map((l) => textBlock(l)) : [textBlock(emptyText, { isSubtle: true })];
}

export function buildStatusCard(activeAgents: CommandAgent[], recentCompletions: CommandIssue[]): AdaptiveCard {
  return adaptiveCard([
    textBlock("📊 Paperclip status", { size: "Large", weight: "Bolder" }),
    factSet([
      { title: "Active agents", value: String(activeAgents.length) },
      { title: "Recent completions", value: String(recentCompletions.length) },
    ]),
    textBlock("Active agents", { weight: "Bolder", spacing: "Medium" }),
    ...bullets(activeAgents.map((a) => `${statusBadge(a.status)} ${a.name}`), "No active agents"),
    textBlock("Recent completions", { weight: "Bolder", spacing: "Medium" }),
    ...bullets(recentCompletions.map((i) => `✅ ${i.title}`), "No recent completions"),
  ]);
}

export function buildAgentsCard(agents: CommandAgent[]): AdaptiveCard {
  return adaptiveCard([
    textBlock(`🤖 Agents (${agents.length})`, { size: "Large", weight: "Bolder" }),
    ...bullets(agents.map((a) => `${statusBadge(a.status)} ${a.name} — ${a.status}`), "No agents found"),
  ]);
}

/** Max Action.OpenUrl buttons on the issues card (Teams renders a bounded action set). */
export const MAX_ISSUE_LINKS = 6;

export function buildIssuesCard(issues: CommandIssue[], filter: IssueFilter): AdaptiveCard {
  const label = filter === "all" ? "" : ` (${filter})`;
  const body = [
    textBlock(`📋 Issues${label} — ${issues.length}`, { size: "Large", weight: "Bolder" }),
    ...bullets(
      issues.map((i) => `${statusBadge(i.status)} ${i.title} — ${i.status}`),
      `No ${filter === "all" ? "" : filter + " "}issues found`,
    ),
  ];
  // AC #2: Action.OpenUrl deep links (bounded so the card stays clean).
  const actions: CardAction[] = issues
    .filter((i) => typeof i.url === "string" && i.url)
    .slice(0, MAX_ISSUE_LINKS)
    .map((i) => openUrlAction(truncate(i.title, 28), i.url as string));
  return adaptiveCard(body, actions);
}

export function buildHelpCard(unknownRaw?: string): AdaptiveCard {
  const intro = unknownRaw
    ? textBlock(`Unknown command \`${unknownRaw}\`. Try one of these:`, { wrap: true })
    : textBlock("Mention me with one of these commands:", { wrap: true });
  return adaptiveCard([
    textBlock("💬 @Paperclip commands", { size: "Large", weight: "Bolder" }),
    intro,
    textBlock("• **status** — active agents and recent completions"),
    textBlock("• **agents** — all agents with status"),
    textBlock("• **issues [open|done]** — list issues with links"),
    textBlock("• **approve <id>** — approve a pending approval"),
    textBlock("• **help** — show this message"),
  ]);
}

export function buildApproveResultCard(result: CommandApproveResult, approvalId: string): AdaptiveCard {
  if (result.ok) {
    const decided = result.verb === "reject" ? "Rejected" : "Approved";
    const emoji = result.verb === "reject" ? "❌" : "✅";
    return adaptiveCard([textBlock(`${emoji} ${decided} approval \`${approvalId}\``, { weight: "Bolder", color: result.verb === "reject" ? "Attention" : "Good" })]);
  }
  return adaptiveCard([
    textBlock(`⚠️ Couldn't approve \`${approvalId}\``, { weight: "Bolder", color: "Attention" }),
    textBlock(result.error ? `${result.error}. Check the id and try again.` : "Check the id and try again.", { wrap: true, isSubtle: true }),
  ]);
}

export function buildApprovalsDisabledCard(): AdaptiveCard {
  return adaptiveCard([
    textBlock("🔒 Approvals aren't enabled here", { weight: "Bolder" }),
    textBlock("Ask an admin to configure the Paperclip board API key (paperclipBoardApiKeyRef) to approve from Teams.", { wrap: true, isSubtle: true }),
  ]);
}

export function buildApproveUsageCard(): AdaptiveCard {
  return adaptiveCard([textBlock("Usage: `@Paperclip approve <approval-id>`", { wrap: true })]);
}

function truncate(s: string, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// --------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------

export interface CommandOutcome {
  card: AdaptiveCard;
  /** Canonical command actually handled — used for the `teams.commands.handled` metric. */
  command: CommandName;
}

/**
 * Dispatch a parsed command to the right card, awaiting injected data as needed. Never
 * throws for control flow; the worker wraps the call and still replies with help on an
 * unexpected error so the user is never left in silence.
 */
export async function dispatchCommand(parsed: ParsedCommand, deps: CommandDeps, actor: CommandActor = { actor: "teams:unknown" }): Promise<CommandOutcome> {
  switch (parsed.command) {
    case "status": {
      const agents = await deps.listAgents();
      const active = agents.filter((a) => ACTIVE_AGENT_STATUSES.has((a.status ?? "").toLowerCase()));
      const completions = await deps.listRecentCompletions();
      return { card: buildStatusCard(active, completions), command: "status" };
    }
    case "agents":
      return { card: buildAgentsCard(await deps.listAgents()), command: "agents" };
    case "issues": {
      const filter = issueFilterFromArg(parsed.args[0]);
      return { card: buildIssuesCard(await deps.listIssues(filter), filter), command: "issues" };
    }
    case "approve": {
      const approvalId = (parsed.args[0] ?? "").trim();
      if (!approvalId) return { card: buildApproveUsageCard(), command: "approve" };
      if (!deps.approve) return { card: buildApprovalsDisabledCard(), command: "approve" };
      const result = await deps.approve(approvalId, actor);
      return { card: buildApproveResultCard(result, approvalId), command: "approve" };
    }
    case "help":
    default:
      // Show the unknown token only when the user actually typed something unrecognized.
      return { card: buildHelpCard(parsed.command === "help" && KNOWN_COMMANDS.has(parsed.raw.toLowerCase()) ? undefined : parsed.raw || undefined), command: "help" };
  }
}
