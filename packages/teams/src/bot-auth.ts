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
