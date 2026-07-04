/**
 * Deep links into Paperclip (PCLIP-20, T3). Every card gets an Action.OpenUrl to
 * the EXACT entity — issue / approval / agent — not the dashboard root (AC #1),
 * built from the configured public base URL (AC #2).
 *
 * Verified against the host router (tools/paperclip ui/src/App.tsx):
 *  - Detail routes live under a `:companyPrefix` segment (the company's issue
 *    prefix, e.g. "PCLIP"): `/{PREFIX}/issues/{uuid}`, `/{PREFIX}/approvals/{uuid}`,
 *    `/{PREFIX}/agents/{uuid}`. `:issueId`/`:approvalId` are UUIDs (the readable
 *    "PROJ-123" is display-only).
 *  - Unprefixed `/issues/{uuid}` and `/agents/{uuid}` redirect to the prefixed form
 *    (UnprefixedBoardRedirect), so they work WITHOUT the prefix. Approvals and costs
 *    have no such redirect, so those require the prefix.
 *
 * The company prefix is the readable-id prefix ("PCLIP" in "PCLIP-123"), so it is
 * derived from the notification's issue identifier, with an optional config
 * override ({@link DeepLinkOptions.companyPrefix}). Pure + SDK-decoupled.
 */

import type { TeamsNotification } from "./notifications.js";

const READABLE_ID_RE = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;
/** Shape of a company URL prefix on its own (the router's `:companyPrefix`). */
const PREFIX_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Trim + strip trailing slash; return "" unless it's an http(s) URL whose host is
 * PUBLIC (AC #2). A loopback/localhost base resolves to the RECIPIENT's own machine
 * in Teams, so such links are useless — we reject them and the card ships without a
 * button (Codex) rather than a broken one.
 */
export function normalizeBaseUrl(base?: string): string {
  const b = (base ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(b)) return "";
  let host: string;
  try {
    host = new URL(b).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || /^127\./.test(host)) {
    return "";
  }
  return b;
}

/** Company URL prefix (issuePrefix, e.g. "PCLIP") from a readable id like "PCLIP-123". */
export function prefixFromIdentifier(identifier?: string): string | undefined {
  const m = (identifier ?? "").trim().match(READABLE_ID_RE);
  return m ? m[1] : undefined;
}

/**
 * Validate an operator-configured company prefix to the router's `:companyPrefix`
 * shape ([A-Za-z][A-Za-z0-9]*). Anything else (slashes, spaces, punctuation) would
 * be percent-encoded into a segment that can't match the route, so it is treated as
 * unset (Kody) — the link then derives the prefix from the issue id or is omitted.
 */
export function normalizeCompanyPrefix(prefix?: string): string | undefined {
  const p = (prefix ?? "").trim();
  return PREFIX_RE.test(p) ? p : undefined;
}

export interface DeepLinkOptions {
  baseUrl?: string;
  /** Company URL prefix override; else derived from the notification's readable issue id. */
  companyPrefix?: string;
}

function seg(prefix?: string): string {
  return prefix ? `/${encodeURIComponent(prefix)}` : "";
}

/**
 * Build the Action.OpenUrl target for a notification, or undefined when there's
 * nothing safe to link to (no base URL, missing entity id, or an approval/costs
 * link with no resolvable company prefix). A card with no link is delivered
 * without a button rather than pointing at a wrong/404 page.
 */
export function buildDeepLink(n: TeamsNotification, opts: DeepLinkOptions): string | undefined {
  const base = normalizeBaseUrl(opts.baseUrl);
  if (!base) return undefined;
  const configuredPrefix = normalizeCompanyPrefix(opts.companyPrefix);

  switch (n.kind) {
    case "issue-created":
    case "issue-done": {
      if (!n.issueId) return undefined;
      // Issues have an unprefixed redirect, so the prefix is optional here.
      const prefix = configuredPrefix ?? prefixFromIdentifier(n.issueIdentifier);
      return `${base}${seg(prefix)}/issues/${encodeURIComponent(n.issueId)}`;
    }
    case "approval": {
      // The approval deep-link TARGET is the approval itself (/{prefix}/approvals/
      // {approvalId}), NOT an issue — so this case needs `approvalId` (always set)
      // plus the company prefix, and deliberately does NOT use an `issueId`. The
      // prefix is derived from the approval's linked-issue identifier that
      // adaptApprovalCreated already captures (or the config override). Approvals
      // have NO unprefixed redirect in the host router, so with no resolvable prefix
      // we return undefined (card ships without a button) rather than a 404 link.
      const prefix = configuredPrefix ?? prefixFromIdentifier(n.issueIdentifier);
      if (!prefix) return undefined;
      return `${base}/${encodeURIComponent(prefix)}/approvals/${encodeURIComponent(n.approvalId)}`;
    }
    case "agent-error": {
      // "error cards" (T3 AC #3) means agent-error — the ONLY error notification
      // kind. It links to the failing run's issue when known, else the agent; both
      // have unprefixed redirects so the prefix is optional. (budget-threshold is a
      // spend alert, not an error, and is intentionally not treated as an error card.)
      const prefix = configuredPrefix ?? prefixFromIdentifier(n.issueIdentifier);
      if (n.issueId) return `${base}${seg(prefix)}/issues/${encodeURIComponent(n.issueId)}`;
      if (n.agentId) return `${base}${seg(prefix)}/agents/${encodeURIComponent(n.agentId)}`;
      return undefined;
    }
    case "budget-threshold": {
      // Not in the T3 AC set; costs has no unprefixed route, so link only with a prefix.
      if (!configuredPrefix) return undefined;
      return `${base}/${encodeURIComponent(configuredPrefix)}/costs`;
    }
  }
}
