import { describe, expect, it } from "vitest";
import { getAuthConfigWithDefaults } from "@microsoft/agents-hosting";

/**
 * Ground-truth guard for the "don't set authConfig.issuers" decision (PCLIP-23).
 *
 * Reviewers have repeatedly asked to hard-code `authConfig.issuers`. That is wrong:
 *   - jwt-middleware.js never reads authConfig.issuers (inbound = audience + signature
 *     + expiry), so setting it is inert for inbound validation; AND
 *   - getAuthConfigWithDefaults AUTO-FILLS issuers from tenantId. Hard-coding a partial
 *     list OVERRIDES that and DROPS the single-tenant Entra issuers.
 *
 * These tests pin the SDK behavior so the decision can't be silently reverted.
 */
const TENANT = "11111111-2222-3333-4444-555555555555";

describe("Agents SDK auth config — issuers must be left unset (PCLIP-23)", () => {
  it("auto-fills the tenant-derived Entra issuers when issuers is unset", () => {
    const cfg = getAuthConfigWithDefaults({ clientId: "app-123", tenantId: TENANT, clientSecret: "s" });
    expect(cfg.issuers).toContain("https://api.botframework.com");
    expect(cfg.issuers).toContain(`https://login.microsoftonline.com/${TENANT}/v2.0`);
    expect(cfg.issuers).toContain(`https://sts.windows.net/${TENANT}/`);
  });

  it("a hard-coded issuers list OVERRIDES the SDK defaults and DROPS the tenant issuers", () => {
    // Demonstrates WHY we don't set issuers: doing so strips the single-tenant issuer.
    const cfg = getAuthConfigWithDefaults({
      clientId: "app-123",
      tenantId: TENANT,
      clientSecret: "s",
      issuers: ["https://api.botframework.com"],
    });
    expect(cfg.issuers).toEqual(["https://api.botframework.com"]);
    expect(cfg.issuers).not.toContain(`https://login.microsoftonline.com/${TENANT}/v2.0`);
  });
});
