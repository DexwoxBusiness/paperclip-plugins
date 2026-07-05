/**
 * Inbound Entra/Bot-Framework token authorization for the v2 bot messaging
 * endpoint (PCLIP-23 / T6, AC #3).
 *
 * The Microsoft 365 Agents SDK's `CloudAdapter.process()` accepts anonymous
 * identity when `request.user` is absent — it does NOT itself reject unauthenticated
 * calls (verified against @microsoft/agents-hosting v1.6). The security boundary is
 * the `authorizeJWT` middleware, which is Express-only. The Paperclip plugin has no
 * Express server (inbound arrives via `onWebhook`), so we authorize the call here
 * BEFORE dispatching to the adapter, and reject unauthenticated/invalid calls.
 *
 * Split of responsibilities:
 *   - Cryptographic verification (signature, JWKS key resolution, token decode) is
 *     delegated to an injected {@link TokenVerifier} — in production backed by the
 *     Agents SDK / Entra JWKS (buildJwksUri/resolveAuthority). We do NOT hand-roll
 *     JWT crypto (the retired Bot Framework SDK is banned; the Agents SDK owns this).
 *   - CLAIMS POLICY (audience = our bot app id, allowed issuer, exp/nbf within clock
 *     skew, token presence) is enforced HERE as SDK-decoupled, fully unit-tested logic.
 *
 * This module is pure over its inputs (header string + injected verifier + clock), so
 * the accept/reject matrix is deterministic in tests without real tokens or network.
 */

/** Decoded token claims we care about (superset-tolerant). */
export interface BotTokenClaims {
  /** Audience — must equal the bot's Microsoft App Id. */
  aud?: string;
  /** Issuer — must be an allowed Entra/Bot-Framework issuer. */
  iss?: string;
  /** Expiry (epoch SECONDS, per JWT). */
  exp?: number;
  /** Not-before (epoch SECONDS). */
  nbf?: number;
  /** Calling app id (Bot Framework: the bot's app id). */
  appid?: string;
  azp?: string;
  /**
   * The channel endpoint the token is bound to. Bot Connector channel tokens emit this as
   * the LOWERCASE claim `serviceurl` (BotBuilder `AuthenticationConstants.ServiceUrlClaim`);
   * the camelCase `serviceUrl` is accepted as a fallback for tolerant issuers. Absent on
   * Emulator / some single-tenant Entra tokens.
   */
  serviceurl?: string;
  serviceUrl?: string;
  [claim: string]: unknown;
}

/**
 * Default issuer for Azure Bot Service channel tokens (public cloud).
 *
 * This is grounded in the official Bot Connector authentication spec
 * (learn.microsoft.com "Authenticate requests with the Bot Connector API",
 * "Connector to Bot" §), which requires: issuer === "https://api.botframework.com",
 * audience === the bot's Microsoft App ID, ≤5-min clock skew, RS256 signature from the
 * OpenID keys doc. The EMULATOR / single-tenant path uses tenant issuers instead
 * (`https://sts.windows.net/{tenant}/` v1 or `https://login.microsoftonline.com/{tenant}/v2.0`
 * v2), which the worker adds to the allow-list when a tenant is configured. Sovereign
 * clouds/other Entra issuers can be added via config. Signature+audience are enforced by
 * the SDK's authorizeJWT; this issuer allow-list is our defense-in-depth gate.
 */
export const BOT_FRAMEWORK_ISSUERS: readonly string[] = ["https://api.botframework.com"];

export interface InboundAuthConfig {
  /** The bot's Microsoft App Id (client id) — the required token audience. */
  audience: string;
  /** Allowed token issuers. Defaults to {@link BOT_FRAMEWORK_ISSUERS}. */
  allowedIssuers?: readonly string[];
  /** Allowed clock skew in seconds for exp/nbf. Default 300 (5 min). */
  clockSkewSec?: number;
}

export type AuthDecision = { ok: true; claims: BotTokenClaims } | { ok: false; reason: string };

/**
 * Rejection of an inbound bot call (PCLIP-25 / T8, AC #2).
 *
 * The plugin webhook route has NO way to return an HTTP 401/403 body — the host maps any
 * worker throw to a fixed `502 {status:"failed", error: <thrown message>}` and echoes that
 * message back to the caller. To avoid leaking verification internals (SDK/JWKS text,
 * expected audience, issuer lists) in that response, the thrown MESSAGE is a stable,
 * generic `"unauthorized"`, while the DETAILED reason is carried on `.reason` for the
 * worker to log internally (ctx.logger / delivery correlation) and NEVER surfaced to the
 * caller. Callers detect an auth rejection via `instanceof` (not string matching), so the
 * distinct auth-rejection metric stays robust if the message ever changes.
 */
export class BotInboundUnauthorizedError extends Error {
  /** Detailed, operator-facing reason — logged internally, never returned to the caller. */
  readonly reason: string;
  constructor(reason: string) {
    super("unauthorized");
    this.name = "BotInboundUnauthorizedError";
    this.reason = reason;
  }
}

/** Verifies a raw JWT (signature + JWKS) and returns its claims, or throws. Injected. */
export type TokenVerifier = (token: string) => Promise<BotTokenClaims>;

/**
 * Extract the bearer token from an Authorization header value. Node lowercases
 * header names and a value may arrive as string | string[]; we take the first.
 * Returns null for missing, wrong-scheme, or empty-token headers (all → reject).
 */
export function extractBearerToken(authorization?: string | string[] | null): string | null {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const match = /^Bearer[ \t]+(.+)$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Enforce the Bot-Framework token claims policy (defense-in-depth over the verifier's
 * cryptographic checks): audience must equal our app id, issuer must be allowed, and
 * the token must be currently valid within the allowed clock skew.
 */
export function assertBotClaims(claims: BotTokenClaims, config: InboundAuthConfig, nowMs: number): AuthDecision {
  if (!config.audience) return { ok: false, reason: "no bot audience (app id) configured" };
  const allowedIssuers = config.allowedIssuers ?? BOT_FRAMEWORK_ISSUERS;
  const skewSec = config.clockSkewSec ?? 300;
  const nowSec = Math.floor(nowMs / 1000);

  if (claims.aud !== config.audience) {
    return { ok: false, reason: `audience mismatch (expected the bot app id)` };
  }
  if (typeof claims.iss !== "string" || !allowedIssuers.includes(claims.iss)) {
    return { ok: false, reason: `issuer not allowed` };
  }
  if (typeof claims.exp !== "number" || nowSec > claims.exp + skewSec) {
    return { ok: false, reason: `token expired` };
  }
  if (typeof claims.nbf === "number" && nowSec < claims.nbf - skewSec) {
    return { ok: false, reason: `token not yet valid` };
  }
  return { ok: true, claims };
}

/**
 * Defense-in-depth serviceUrl binding — Bot Connector auth spec, Connector→Bot requirement
 * #7 ("the token contains a `serviceUrl` claim whose value matches the `serviceUrl` at the
 * root of the Activity"). Binding the token to the channel endpoint means a leaked/replayed
 * token can't be pointed at an attacker-controlled `serviceUrl` to hijack the bot's replies.
 *
 * The SDK's inbound `authorizeJWT` validates audience/issuer/RS256/expiry but does NOT check
 * serviceUrl (verified against @microsoft/agents-hosting jwt-middleware.js), so we enforce it
 * here. The claim is only present on Bot Connector channel tokens — Emulator / some
 * single-tenant Entra tokens omit it — so we bind ONLY when the claim is present (absent →
 * allowed, exactly like the optional `nbf`). Comparison is trailing-slash- and
 * case-insensitive, since serviceUrls are emitted inconsistently with a trailing slash.
 */
export function assertServiceUrl(
  claims: BotTokenClaims,
  activityServiceUrl: unknown,
): { ok: true } | { ok: false; reason: string } {
  const rawClaim = typeof claims.serviceurl === "string" ? claims.serviceurl : claims.serviceUrl;
  const claim = typeof rawClaim === "string" ? rawClaim.trim() : "";
  if (!claim) return { ok: true }; // no serviceUrl claim to bind (Emulator / Entra)
  const activityUrl = typeof activityServiceUrl === "string" ? activityServiceUrl.trim() : "";
  const norm = (u: string): string => u.replace(/\/+$/, "").toLowerCase();
  if (!activityUrl || norm(claim) !== norm(activityUrl)) {
    return { ok: false, reason: `serviceUrl claim does not match the activity serviceUrl` };
  }
  return { ok: true };
}

/**
 * Full inbound authorization: extract the bearer token, verify it cryptographically
 * (injected verifier), then enforce the claims policy. Any missing token, verification
 * failure, or policy violation returns a rejection with a reason — the worker rejects
 * the call on `ok: false` (AC #3). NEVER throws: verifier errors are caught and mapped
 * to a rejection so the caller has a single decision to act on.
 */
export async function authorizeInbound(
  authorization: string | string[] | undefined | null,
  verify: TokenVerifier,
  config: InboundAuthConfig,
  nowMs: number = Date.now(),
): Promise<AuthDecision> {
  const token = extractBearerToken(authorization);
  if (!token) return { ok: false, reason: "missing or malformed Authorization bearer token" };
  let claims: BotTokenClaims;
  try {
    claims = await verify(token);
  } catch (e) {
    return { ok: false, reason: `token verification failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return assertBotClaims(claims, config, nowMs);
}
