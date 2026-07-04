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

/** Trim + strip trailing slash; return "" unless it's an http(s) URL (AC #2). */
export function normalizeBaseUrl(base?: string): string {
  const b = (base ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(b) ? b : "";
}

/** Company URL prefix (issuePrefix, e.g. "PCLIP") from a readable id like "PCLIP-123". */
export function prefixFromIdentifier(identifier?: string): string | undefined {
  const m = (identifier ?? "").trim().match(READABLE_ID_RE);
  return m ? m[1] : undefined;
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
  const configuredPrefix = (opts.companyPrefix ?? "").trim() || undefined;

  switch (n.kind) {
    case "issue-created":
    case "issue-done": {
      if (!n.issueId) return undefined;
      // Issues have an unprefixed redirect, so the prefix is optional here.
      const prefix = configuredPrefix ?? prefixFromIdentifier(n.issueIdentifier);
      return `${base}${seg(prefix)}/issues/${encodeURIComponent(n.issueId)}`;
    }
    case "approval": {
      // Approvals have NO unprefixed redirect — the company prefix is required.
      const prefix = configuredPrefix ?? prefixFromIdentifier(n.issueIdentifier);
      if (!prefix) return undefined;
      return `${base}/${encodeURIComponent(prefix)}/approvals/${encodeURIComponent(n.approvalId)}`;
    }
    case "agent-error": {
      const prefix = configuredPrefix ?? prefixFromIdentifier(n.issueIdentifier);
      if (n.issueId) return `${base}${seg(prefix)}/issues/${encodeURIComponent(n.issueId)}`;
      // Agents also have an unprefixed redirect.
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
