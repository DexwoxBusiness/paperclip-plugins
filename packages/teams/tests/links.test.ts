import { describe, expect, it } from "vitest";
import { buildDeepLink, normalizeBaseUrl, normalizeCompanyPrefix, prefixFromIdentifier } from "../src/links.js";
import { buildNotificationCard, type TeamsNotification } from "../src/notifications.js";
import { validateAdaptiveCard } from "../src/adaptive-card.js";

const BASE = "https://paperclip.example.com";

describe("deep links (PCLIP-20)", () => {
  it("normalizes the base URL (trims trailing slash; rejects non-http)", () => {
    expect(normalizeBaseUrl("https://x.com/")).toBe("https://x.com");
    expect(normalizeBaseUrl("  https://x.com//  ")).toBe("https://x.com");
    expect(normalizeBaseUrl("ftp://x")).toBe("");
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl(undefined)).toBe("");
  });

  it("derives the company prefix from a readable issue id", () => {
    expect(prefixFromIdentifier("PCLIP-123")).toBe("PCLIP");
    expect(prefixFromIdentifier("abc-1")).toBe("abc");
    expect(prefixFromIdentifier("550e8400-uuid")).toBeUndefined(); // not PREFIX-<digits>
    expect(prefixFromIdentifier(undefined)).toBeUndefined();
  });

  it("links issue.created / issue.done to the exact issue (prefix derived from the readable id)", () => {
    const created: TeamsNotification = { kind: "issue-created", title: "t", issueId: "uuid-1", issueIdentifier: "PCLIP-7" };
    expect(buildDeepLink(created, { baseUrl: BASE })).toBe(`${BASE}/PCLIP/issues/uuid-1`);
    const done: TeamsNotification = { kind: "issue-done", title: "t", issueId: "uuid-2", issueIdentifier: "PCLIP-8" };
    expect(buildDeepLink(done, { baseUrl: BASE })).toBe(`${BASE}/PCLIP/issues/uuid-2`);
  });

  it("links an issue without a derivable prefix to the unprefixed (redirecting) route", () => {
    const created: TeamsNotification = { kind: "issue-created", title: "t", issueId: "uuid-1" };
    expect(buildDeepLink(created, { baseUrl: BASE })).toBe(`${BASE}/issues/uuid-1`);
  });

  it("links an approval to the exact approval — prefix from the linked issue id", () => {
    const approval: TeamsNotification = { kind: "approval", approvalId: "appr-1", title: "t", requester: "r", issueIdentifier: "PCLIP-2" };
    expect(buildDeepLink(approval, { baseUrl: BASE })).toBe(`${BASE}/PCLIP/approvals/appr-1`);
  });

  it("omits an approval link when no prefix is derivable and none is configured (approvals need a prefix)", () => {
    const approval: TeamsNotification = { kind: "approval", approvalId: "appr-1", title: "t", requester: "r" };
    expect(buildDeepLink(approval, { baseUrl: BASE })).toBeUndefined();
    // ...but an explicit config prefix enables it
    expect(buildDeepLink(approval, { baseUrl: BASE, companyPrefix: "ACME" })).toBe(`${BASE}/ACME/approvals/appr-1`);
  });

  it("links an agent-error to the issue, else the agent, else nothing", () => {
    expect(buildDeepLink({ kind: "agent-error", error: "e", issueId: "i1", issueIdentifier: "PCLIP-3" }, { baseUrl: BASE })).toBe(`${BASE}/PCLIP/issues/i1`);
    expect(buildDeepLink({ kind: "agent-error", error: "e", agentId: "ag1" }, { baseUrl: BASE })).toBe(`${BASE}/agents/ag1`);
    expect(buildDeepLink({ kind: "agent-error", error: "e" }, { baseUrl: BASE })).toBeUndefined();
  });

  it("returns no link when the base URL is unset/invalid (card still delivers, no button)", () => {
    const n: TeamsNotification = { kind: "issue-created", title: "t", issueId: "uuid-1", issueIdentifier: "PCLIP-7" };
    expect(buildDeepLink(n, { baseUrl: "" })).toBeUndefined();
    expect(buildDeepLink(n, { baseUrl: "localhost:3100" })).toBeUndefined(); // not http(s)
  });

  it("rejects loopback/localhost base URLs — no broken button on Teams recipients' machines (Codex)", () => {
    for (const bad of ["http://localhost:3100", "https://localhost", "http://127.0.0.1:8080", "http://[::1]:3000", "http://0.0.0.0", "https://app.localhost"]) {
      expect(normalizeBaseUrl(bad)).toBe("");
    }
    expect(normalizeBaseUrl("https://paperclip.example.com")).toBe("https://paperclip.example.com");
    const n: TeamsNotification = { kind: "issue-created", title: "t", issueId: "uuid-1", issueIdentifier: "PCLIP-7" };
    expect(buildDeepLink(n, { baseUrl: "http://localhost:3100" })).toBeUndefined();
  });

  it("normalizes an operator-configured prefix, rejecting bad input (Kody)", () => {
    expect(normalizeCompanyPrefix("PCLIP")).toBe("PCLIP");
    expect(normalizeCompanyPrefix("  PCLIP  ")).toBe("PCLIP");
    expect(normalizeCompanyPrefix("foo/bar")).toBeUndefined();
    expect(normalizeCompanyPrefix("my prefix")).toBeUndefined();
    expect(normalizeCompanyPrefix("PC LIP")).toBeUndefined();
    expect(normalizeCompanyPrefix("")).toBeUndefined();
    // a bad configured prefix falls back to the derived one, never a broken segment
    const approval: TeamsNotification = { kind: "approval", approvalId: "appr-1", title: "t", requester: "r", issueIdentifier: "PCLIP-2" };
    expect(buildDeepLink(approval, { baseUrl: BASE, companyPrefix: "bad/prefix" })).toBe(`${BASE}/PCLIP/approvals/appr-1`);
  });

  it("prefers an explicit company prefix over the derived one", () => {
    const n: TeamsNotification = { kind: "issue-created", title: "t", issueId: "uuid-1", issueIdentifier: "PCLIP-7" };
    expect(buildDeepLink(n, { baseUrl: BASE, companyPrefix: "OVERRIDE" })).toBe(`${BASE}/OVERRIDE/issues/uuid-1`);
  });

  it("a card built with a deep link is a valid v1.5 card with a View action (AC #1/#3)", () => {
    const n: TeamsNotification = { kind: "approval", approvalId: "appr-1", title: "Deploy", requester: "Bob", issueIdentifier: "PCLIP-2" };
    const link = buildDeepLink(n, { baseUrl: BASE })!;
    const card = buildNotificationCard({ ...n, link });
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    expect(card.actions?.[0]).toMatchObject({ type: "Action.OpenUrl", title: "View in Paperclip", url: `${BASE}/PCLIP/approvals/appr-1` });
  });
});
