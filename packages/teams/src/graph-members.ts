/**
 * Read a Teams team's member roster via Microsoft Graph (T13 mention fix).
 *
 * WHY GRAPH, not the Bot Connector: Microsoft documents that bots CANNOT get member email/UPN via the
 * Bot Connector roster APIs (`TeamsInfo.getPagedMembers`) — those omit email/UPN and are being retired
 * ("Bots can't proactively retrieve the userPrincipalName or email properties ... and must use the
 * Graph APIs"). Reading email — which email→@mention resolution needs — requires the Graph roster API,
 * authorized by the RSC application permission `TeamMember.Read.Group`:
 *   https://learn.microsoft.com/microsoftteams/platform/resources/team-chat-member-api-changes
 *
 * SDK-decoupled + pure over an injectable `fetch` so the token flow, caching, timeout, and pagination
 * are unit-tested without a live tenant. Mints an app-only (client-credentials) token for the bot's
 * Entra app (cached until near expiry) and reads GET /teams/{groupId}/members, following
 * @odata.nextLink for the full roster. Every request carries an AbortSignal timeout so a stalled
 * Microsoft endpoint fails cleanly instead of blocking the worker until the OS TCP timeout.
 */

/** Minimal fetch surface (native `fetch` satisfies it); injectable for tests. */
export type GraphFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** A resolved roster member. Shaped to satisfy channel.ts's RawChannelMember (id/aadObjectId/name/email),
 * so normalizeMembers and resolveChannelMentions work unchanged. */
export interface GraphMember {
  /** AAD object id — used as the Teams mention id (Entra Object ID is a valid Adaptive Card mention id). */
  aadObjectId: string;
  /** Mirror of aadObjectId so `id ?? aadObjectId` resolvers pick it up too. */
  id: string;
  name: string;
  /** Lowercased for case-insensitive joins; "" when Graph omits it. */
  email: string;
}

const LOGIN_HOST = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh a cached token this long before its real expiry to avoid using one mid-flight. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Best-effort per-request timeout signal (AbortSignal.timeout is Node 18+/modern-runtime). */
function timeoutSignal(timeoutMs?: number): AbortSignal | undefined {
  const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const AS = (typeof AbortSignal !== "undefined" ? AbortSignal : undefined) as unknown as { timeout?: (ms: number) => AbortSignal } | undefined;
  return AS && typeof AS.timeout === "function" ? AS.timeout(ms) : undefined;
}

// -------------------------------------------------------------------------------------------------
// App-only token: minted once and cached per (tenant, client) until near expiry (valid ~1h).
// -------------------------------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
const tokenCache = new Map<string, CachedToken>();
const tokenKey = (tenantId: string, clientId: string): string => `${tenantId}|${clientId}`;

/** Test hook: drop all cached tokens so each test starts clean. */
export function _resetGraphTokenCache(): void {
  tokenCache.clear();
}

/**
 * Mint an app-only Graph token (client-credentials) for the bot's Entra app. Throws with a clean,
 * secret-free message on failure. Returns the token + its lifetime so the caller can cache it.
 */
export async function fetchGraphAppToken(
  input: { tenantId: string; clientId: string; clientSecret: string; timeoutMs?: number },
  fetchImpl: GraphFetch,
): Promise<{ token: string; expiresInSec: number }> {
  const tenant = (input.tenantId ?? "").trim();
  if (!tenant) throw new Error("graph token: tenantId required (bot's Entra tenant, or the channel's tenant)");
  if (!input.clientId || !input.clientSecret) throw new Error("graph token: bot clientId + clientSecret required");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  }).toString();
  const res = await fetchImpl(`${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: timeoutSignal(input.timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    // Never echo the secret; surface only the AAD error class/description.
    throw new Error(`graph token failed (${res.status}): ${json.error_description || json.error || "no access_token"}`);
  }
  return { token: json.access_token, expiresInSec: typeof json.expires_in === "number" ? json.expires_in : 3600 };
}

/** Drop every expired entry — keeps the cache bounded to tenants with a currently-valid token, so a
 * long-running multi-tenant worker doesn't accumulate stale entries for tenants it never revisits. */
function purgeExpiredTokens(now: number): void {
  for (const [k, v] of tokenCache) if (now >= v.expiresAtMs) tokenCache.delete(k);
}

/** Return a cached token if still fresh, else mint one and cache it. */
async function getAppToken(input: { tenantId: string; clientId: string; clientSecret: string; timeoutMs?: number }, fetchImpl: GraphFetch): Promise<string> {
  const now = Date.now();
  const key = tokenKey((input.tenantId ?? "").trim(), input.clientId);
  const hit = tokenCache.get(key);
  if (hit && now < hit.expiresAtMs) return hit.token;
  purgeExpiredTokens(now); // bound memory: evict this stale entry + any never-revisited expired tenants
  const { token, expiresInSec } = await fetchGraphAppToken(input, fetchImpl);
  tokenCache.set(key, { token, expiresAtMs: now + Math.max(0, expiresInSec * 1000 - TOKEN_EXPIRY_SKEW_MS) });
  return token;
}

/** An error thrown by the Graph member read, carrying the HTTP status for 401-retry handling. */
class GraphMembersError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GraphMembersError";
  }
}

/**
 * Read a team's members via Graph, following @odata.nextLink for the whole roster. Members without a
 * `userId` (e.g. app/bot members) are skipped — they aren't @-mentionable people. Deduped by AAD id.
 */
export async function fetchTeamMembers(
  input: { groupId: string; token: string; timeoutMs?: number },
  fetchImpl: GraphFetch,
): Promise<GraphMember[]> {
  const groupId = (input.groupId ?? "").trim();
  if (!groupId) throw new Error("graph members: team groupId required");
  const out: GraphMember[] = [];
  const seen = new Set<string>();
  let url: string | undefined = `${GRAPH}/teams/${encodeURIComponent(groupId)}/members?$top=100`;
  while (url) {
    const res = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${input.token}` }, signal: timeoutSignal(input.timeoutMs) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new GraphMembersError(`graph members failed (${res.status}) for team ${groupId}: ${detail}`, res.status);
    }
    const page = (await res.json()) as { value?: unknown[]; ["@odata.nextLink"]?: string };
    for (const raw of page.value ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as { userId?: unknown; displayName?: unknown; email?: unknown };
      const aad = String(m.userId ?? "").trim();
      if (!aad || seen.has(aad)) continue;
      seen.add(aad);
      const email = String(m.email ?? "").trim().toLowerCase();
      const name = String(m.displayName ?? "").trim() || email || aad;
      out.push({ aadObjectId: aad, id: aad, name, email });
    }
    url = page["@odata.nextLink"];
  }
  return out;
}

/** Native global fetch adapted to {@link GraphFetch} (typed const → `url`/`init` infer, no implicit any). */
const defaultGraphFetch: GraphFetch = (url, init) =>
  (
    globalThis.fetch as unknown as (
      u: string,
      i: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
    ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>
  )(url, init);

/**
 * Token (cached) + members in one call. `fetchImpl` defaults to native fetch (present in the Node
 * worker). On a 401 from the member read, the cached token is dropped and the read retried once with
 * a freshly-minted token (covers a token that expired between mint and use).
 */
export async function readTeamRoster(
  input: { tenantId: string; clientId: string; clientSecret: string; groupId: string; timeoutMs?: number },
  fetchImpl: GraphFetch = defaultGraphFetch,
): Promise<GraphMember[]> {
  const readOnce = async (): Promise<GraphMember[]> => {
    const token = await getAppToken(input, fetchImpl);
    return fetchTeamMembers({ groupId: input.groupId, token, timeoutMs: input.timeoutMs }, fetchImpl);
  };
  try {
    return await readOnce();
  } catch (e) {
    if (e instanceof GraphMembersError && e.status === 401) {
      tokenCache.delete(tokenKey((input.tenantId ?? "").trim(), input.clientId)); // stale token → refresh + retry once
      return await readOnce();
    }
    throw e;
  }
}
