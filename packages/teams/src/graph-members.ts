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
 * SDK-decoupled + pure over an injectable `fetch` so the token flow and pagination are unit-tested
 * without a live tenant. Mints an app-only (client-credentials) token for the bot's Entra app and
 * reads GET /teams/{groupId}/members, following @odata.nextLink for the full roster.
 */

/** Minimal fetch surface (native `fetch` satisfies it); injectable for tests. */
export type GraphFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
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

/**
 * Mint an app-only Graph token (client-credentials) for the bot's Entra app. Throws with a clean,
 * secret-free message on failure so the caller logs it and returns an empty roster.
 */
export async function fetchGraphAppToken(
  input: { tenantId: string; clientId: string; clientSecret: string },
  fetchImpl: GraphFetch,
): Promise<string> {
  const tenant = (input.tenantId ?? "").trim();
  if (!tenant) throw new Error("graph token: tenantId required (set the bot's single-tenant Entra tenant id)");
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
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    // Never echo the secret; surface only the AAD error class/description.
    throw new Error(`graph token failed (${res.status}): ${json.error_description || json.error || "no access_token"}`);
  }
  return json.access_token;
}

/**
 * Read a team's members via Graph, following @odata.nextLink for the whole roster. Members without a
 * `userId` (e.g. app/bot members) are skipped — they aren't @-mentionable people. Deduped by AAD id.
 */
export async function fetchTeamMembers(
  input: { groupId: string; token: string },
  fetchImpl: GraphFetch,
): Promise<GraphMember[]> {
  const groupId = (input.groupId ?? "").trim();
  if (!groupId) throw new Error("graph members: team groupId required");
  const out: GraphMember[] = [];
  const seen = new Set<string>();
  let url: string | undefined = `${GRAPH}/teams/${encodeURIComponent(groupId)}/members?$top=100`;
  while (url) {
    const res = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${input.token}` } });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`graph members failed (${res.status}) for team ${groupId}: ${detail}`);
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

/** Token + members in one call. `fetchImpl` defaults to native fetch (present in the Node worker). */
export async function readTeamRoster(
  input: { tenantId: string; clientId: string; clientSecret: string; groupId: string },
  fetchImpl: GraphFetch = ((url, init) => (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init)) as unknown as GraphFetch,
): Promise<GraphMember[]> {
  const token = await fetchGraphAppToken(input, fetchImpl);
  return fetchTeamMembers({ groupId: input.groupId, token }, fetchImpl);
}
