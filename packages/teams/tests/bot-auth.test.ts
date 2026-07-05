import { describe, expect, it } from "vitest";
import {
  assertBotClaims,
  authorizeInbound,
  BotInboundUnauthorizedError,
  extractBearerToken,
  type BotTokenClaims,
  type InboundAuthConfig,
} from "../src/bot-auth.js";

describe("BotInboundUnauthorizedError", () => {
  it("keeps a GENERIC host-facing message but carries the detailed reason (AC #2)", () => {
    const err = new BotInboundUnauthorizedError("token verification failed: jwks 500 from https://login.botframework.com/...");
    // The message is what the host echoes in its 502 body — must NOT leak internals.
    expect(err.message).toBe("unauthorized");
    // The detailed reason is available for internal logging only.
    expect(err.reason).toContain("jwks");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BotInboundUnauthorizedError");
  });
  it("is distinguishable via instanceof (robust vs string matching)", () => {
    const thrown: unknown = new BotInboundUnauthorizedError("issuer not allowed");
    expect(thrown instanceof BotInboundUnauthorizedError).toBe(true);
    expect(new Error("unauthorized") instanceof BotInboundUnauthorizedError).toBe(false);
  });
});

const APP_ID = "11111111-2222-3333-4444-555555555555";
const CFG: InboundAuthConfig = { audience: APP_ID };
const ISS = "https://api.botframework.com";
// A fixed "now": 2026-07-05T00:00:00Z in ms.
const NOW = Date.UTC(2026, 6, 5) ;
const nowSec = Math.floor(NOW / 1000);
const validClaims = (over: Partial<BotTokenClaims> = {}): BotTokenClaims => ({
  aud: APP_ID,
  iss: ISS,
  exp: nowSec + 600,
  nbf: nowSec - 60,
  appid: APP_ID,
  ...over,
});

describe("extractBearerToken", () => {
  it("parses a well-formed Bearer header (case-insensitive), trims", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer   xyz  ")).toBe("xyz");
    expect(extractBearerToken(["Bearer first", "Bearer second"])).toBe("first");
  });
  it("rejects missing, wrong-scheme, or empty tokens", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer   ")).toBeNull();
    expect(extractBearerToken("abc.def")).toBeNull();
  });
});

describe("assertBotClaims (PCLIP-23 AC #3 policy)", () => {
  it("accepts valid claims", () => {
    expect(assertBotClaims(validClaims(), CFG, NOW)).toEqual({ ok: true, claims: validClaims() });
  });
  it("rejects a wrong audience (token minted for another app)", () => {
    expect(assertBotClaims(validClaims({ aud: "other" }), CFG, NOW)).toMatchObject({ ok: false });
  });
  it("rejects a disallowed issuer", () => {
    expect(assertBotClaims(validClaims({ iss: "https://evil.example.com" }), CFG, NOW)).toMatchObject({ ok: false });
  });
  it("rejects an expired token (beyond skew) but allows within skew", () => {
    expect(assertBotClaims(validClaims({ exp: nowSec - 1000 }), CFG, NOW)).toMatchObject({ ok: false });
    expect(assertBotClaims(validClaims({ exp: nowSec - 100 }), CFG, NOW)).toMatchObject({ ok: true }); // within 300s skew
  });
  it("rejects a not-yet-valid token (beyond skew)", () => {
    expect(assertBotClaims(validClaims({ nbf: nowSec + 1000 }), CFG, NOW)).toMatchObject({ ok: false });
  });
  it("rejects when no audience is configured", () => {
    expect(assertBotClaims(validClaims(), { audience: "" }, NOW)).toMatchObject({ ok: false });
  });
  it("honors a custom allowed-issuer set (e.g. Entra tenant issuer)", () => {
    const tenantIss = "https://login.microsoftonline.com/tenant/v2.0";
    const cfg: InboundAuthConfig = { audience: APP_ID, allowedIssuers: [tenantIss] };
    expect(assertBotClaims(validClaims({ iss: tenantIss }), cfg, NOW)).toMatchObject({ ok: true });
    expect(assertBotClaims(validClaims({ iss: ISS }), cfg, NOW)).toMatchObject({ ok: false });
  });
});

describe("authorizeInbound (extract + verify + policy)", () => {
  const verifyOk = async (): Promise<BotTokenClaims> => validClaims();
  it("accepts a valid header + verified token", async () => {
    const d = await authorizeInbound(`Bearer good`, verifyOk, CFG, NOW);
    expect(d.ok).toBe(true);
  });
  it("rejects a missing/malformed header WITHOUT calling verify", async () => {
    let called = false;
    const verify = async () => {
      called = true;
      return validClaims();
    };
    expect(await authorizeInbound(undefined, verify, CFG, NOW)).toMatchObject({ ok: false });
    expect(await authorizeInbound("Basic x", verify, CFG, NOW)).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
  it("maps a verifier throw (bad signature / JWKS) to a rejection, never throws", async () => {
    const verify = async () => {
      throw new Error("signature invalid");
    };
    const d = await authorizeInbound("Bearer tampered", verify, CFG, NOW);
    expect(d).toMatchObject({ ok: false });
    expect((d as { reason: string }).reason).toMatch(/verification failed/i);
  });
  it("rejects a cryptographically-valid token that fails the claims policy", async () => {
    const verify = async () => validClaims({ aud: "someone-else" });
    expect(await authorizeInbound("Bearer x", verify, CFG, NOW)).toMatchObject({ ok: false });
  });
});
