import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGraphTokenCache, fetchGraphAppToken, fetchTeamMembers, fetchUsersByKeys, readTeamRoster, resolveGraphUsers, type GraphFetch } from "../src/graph-members.js";

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
const err = (status: number, body: unknown) => ({
  ok: false,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

beforeEach(() => _resetGraphTokenCache());

describe("fetchGraphAppToken", () => {
  it("mints a client-credentials token (with lifetime) for graph .default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ access_token: "tok-123", expires_in: 3600 }));
    const { token, expiresInSec } = await fetchGraphAppToken({ tenantId: "TENANT", clientId: "CID", clientSecret: "SECRET" }, fetchImpl as unknown as GraphFetch);
    expect(token).toBe("tok-123");
    expect(expiresInSec).toBe(3600);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("login.microsoftonline.com/TENANT/oauth2/v2.0/token");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("grant_type=client_credentials");
    expect(init.body).toContain("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default");
    expect(init.body).toContain("client_secret=SECRET");
    expect(init.signal).toBeDefined(); // per-request timeout
  });

  it("throws a secret-free error on a token failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(401, { error: "invalid_client", error_description: "bad secret" }));
    await expect(
      fetchGraphAppToken({ tenantId: "t", clientId: "c", clientSecret: "s" }, fetchImpl as unknown as GraphFetch),
    ).rejects.toThrow(/graph token failed \(401\): bad secret/);
  });

  it("requires tenant, clientId, and secret", async () => {
    const f = vi.fn() as unknown as GraphFetch;
    await expect(fetchGraphAppToken({ tenantId: "", clientId: "c", clientSecret: "s" }, f)).rejects.toThrow(/tenantId required/);
    await expect(fetchGraphAppToken({ tenantId: "t", clientId: "", clientSecret: "s" }, f)).rejects.toThrow(/clientId \+ clientSecret/);
  });
});

describe("fetchTeamMembers", () => {
  it("maps userId/displayName/email (lowercased) to the roster shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        value: [
          { userId: "aad-1", displayName: "Diwakar MA", email: "Diwakar.MA@dexwox.com" },
          { userId: "aad-2", displayName: "Ferin C", email: "ferin.c@dexwox.com" },
        ],
      }),
    );
    const members = await fetchTeamMembers({ groupId: "GID", token: "T" }, fetchImpl as unknown as GraphFetch);
    expect(members).toEqual([
      { aadObjectId: "aad-1", id: "aad-1", name: "Diwakar MA", email: "diwakar.ma@dexwox.com" },
      { aadObjectId: "aad-2", id: "aad-2", name: "Ferin C", email: "ferin.c@dexwox.com" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("graph.microsoft.com/v1.0/teams/GID/members");
    expect(init.headers.authorization).toBe("Bearer T");
    expect(init.signal).toBeDefined();
  });

  it("follows @odata.nextLink for the whole roster and dedupes by AAD id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ value: [{ userId: "a", displayName: "A", email: "a@x.com" }], "@odata.nextLink": "https://graph.microsoft.com/next" }))
      .mockResolvedValueOnce(ok({ value: [{ userId: "b", displayName: "B", email: "b@x.com" }, { userId: "a", displayName: "A dup", email: "a@x.com" }] }));
    const members = await fetchTeamMembers({ groupId: "g", token: "t" }, fetchImpl as unknown as GraphFetch);
    expect(members.map((m) => m.id)).toEqual(["a", "b"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips members with no userId (app/bot members); keeps email '' when Graph omits it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ value: [{ displayName: "App Bot" }, { userId: "aad-3", displayName: "Guest" }] }));
    const members = await fetchTeamMembers({ groupId: "g", token: "t" }, fetchImpl as unknown as GraphFetch);
    expect(members).toEqual([{ aadObjectId: "aad-3", id: "aad-3", name: "Guest", email: "" }]);
  });

  it("throws on a non-ok Graph response so the caller's catch surfaces it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(403, "Forbidden: missing RSC"));
    await expect(fetchTeamMembers({ groupId: "g", token: "t" }, fetchImpl as unknown as GraphFetch)).rejects.toThrow(
      /graph members failed \(403\).*Forbidden/,
    );
  });
});

describe("fetchUsersByKeys (ONE batched filter request; matches mail OR userPrincipalName)", () => {
  it("filters by mail in (...) or userPrincipalName in (...) with the advanced-query header + $count", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({
        value: [
          { id: "o1", displayName: "One", mail: "one@x.com", userPrincipalName: "one.upn@x.com" },
          { id: "o2", displayName: "Two", mail: null, userPrincipalName: "two@x.com" },
        ],
      }),
    );
    const users = await fetchUsersByKeys({ token: "T", keys: ["one@x.com", "two@x.com"] }, fetchImpl as unknown as GraphFetch);
    expect(users).toEqual([
      { id: "o1", name: "One", email: "one@x.com", upn: "one.upn@x.com" },
      { id: "o2", name: "Two", email: "two@x.com", upn: "two@x.com" }, // no mail → email falls back to upn
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("graph.microsoft.com/v1.0/users?");
    expect(url).toContain("$count=true"); // required for the `in` operator on mail (advanced query)
    expect(decodeURIComponent(url)).toContain("mail in ('one@x.com','two@x.com') or userPrincipalName in ('one@x.com','two@x.com')");
    expect(init.headers.ConsistencyLevel).toBe("eventual"); // required for advanced queries
    expect(init.headers.authorization).toBe("Bearer T");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // ONE request for the whole batch (no N+1)
  });

  it("follows @odata.nextLink and dedupes by object id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ value: [{ id: "a", displayName: "A", mail: "a@x.com", userPrincipalName: "a@x.com" }], "@odata.nextLink": "https://graph.microsoft.com/next" }))
      .mockResolvedValueOnce(ok({ value: [{ id: "b", displayName: "B", mail: "b@x.com", userPrincipalName: "b@x.com" }, { id: "a", displayName: "A dup", mail: "a@x.com", userPrincipalName: "a@x.com" }] }));
    const users = await fetchUsersByKeys({ token: "t", keys: ["a@x.com", "b@x.com"] }, fetchImpl as unknown as GraphFetch);
    expect(users.map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("escapes single quotes in keys (OData) and throws on a non-ok response", async () => {
    const okFetch = vi.fn().mockResolvedValue(ok({ value: [] }));
    await fetchUsersByKeys({ token: "t", keys: ["o'brien@x.com"] }, okFetch as unknown as GraphFetch);
    expect(decodeURIComponent(String(okFetch.mock.calls[0][0]))).toContain("'o''brien@x.com'");
    const bad = vi.fn().mockResolvedValue(err(403, "Authorization_RequestDenied"));
    await expect(fetchUsersByKeys({ token: "t", keys: ["a@x.com"] }, bad as unknown as GraphFetch)).rejects.toThrow(/graph users filter failed \(403\)/);
  });
});

describe("resolveGraphUsers (one batched request for misses, keyed by lowercased request, cached)", () => {
  it("mints one token + ONE batched request, keys the map by lowercased request, dedupes case-insensitively", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ access_token: "TT", expires_in: 3600 })) // token (once)
      .mockResolvedValueOnce(ok({ value: [{ id: "o1", displayName: "One", mail: "one@x.com", userPrincipalName: "one@x.com" }] })); // batch (once)
    const map = await resolveGraphUsers({ tenantId: "t", clientId: "c", clientSecret: "s", keys: ["One@x.com", "one@x.com", "ghost@x.com"] }, fetchImpl as unknown as GraphFetch);
    expect(map.get("one@x.com")?.id).toBe("o1");
    expect(map.has("ghost@x.com")).toBe(false); // no match in the batch → left unresolved (not fabricated)
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 token + 1 batched users request (NOT N+1)
  });

  it("resolves a key by mail even when it differs from the UPN (the /users/{email} 404 bug)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ access_token: "TT", expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ value: [{ id: "ox", displayName: "Biz", mail: "business@dexwox.com", userPrincipalName: "b.yuvaraj@dexwox.com" }] }));
    const map = await resolveGraphUsers({ tenantId: "t", clientId: "c", clientSecret: "s", keys: ["business@dexwox.com"] }, fetchImpl as unknown as GraphFetch);
    expect(map.get("business@dexwox.com")?.id).toBe("ox"); // matched by mail, not UPN
  });

  it("serves a repeat request from the per-tenant cache (no second token or Graph call)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ access_token: "TT", expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ value: [{ id: "o1", displayName: "One", mail: "one@x.com", userPrincipalName: "one@x.com" }] }));
    const input = { tenantId: "t", clientId: "c", clientSecret: "s", keys: ["one@x.com"] };
    await resolveGraphUsers(input, fetchImpl as unknown as GraphFetch);
    const again = await resolveGraphUsers(input, fetchImpl as unknown as GraphFetch);
    expect(again.get("one@x.com")?.id).toBe("o1");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // still just the first run's 2 calls — second served from cache
  });

  it("on a 401 from the batch, drops the token and retries once with a fresh one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ access_token: "T1", expires_in: 3600 })) // token 1
      .mockResolvedValueOnce(err(401, "expired")) // batch → 401
      .mockResolvedValueOnce(ok({ access_token: "T2", expires_in: 3600 })) // token 2
      .mockResolvedValueOnce(ok({ value: [{ id: "o", displayName: "U", mail: "u@x.com", userPrincipalName: "u@x.com" }] }));
    const map = await resolveGraphUsers({ tenantId: "t", clientId: "c", clientSecret: "s", keys: ["u@x.com"] }, fetchImpl as unknown as GraphFetch);
    expect(map.get("u@x.com")?.id).toBe("o");
    expect(fetchImpl.mock.calls[3][1].headers.authorization).toBe("Bearer T2");
  });

  it("returns an empty map for no keys (no token round-trip)", async () => {
    const fetchImpl = vi.fn();
    expect((await resolveGraphUsers({ tenantId: "t", clientId: "c", clientSecret: "s", keys: [] }, fetchImpl as unknown as GraphFetch)).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("readTeamRoster", () => {
  it("mints a token then reads members with it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ access_token: "TT", expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ value: [{ userId: "u1", displayName: "U1", email: "u1@x.com" }] }));
    const members = await readTeamRoster({ tenantId: "t", clientId: "c", clientSecret: "s", groupId: "g" }, fetchImpl as unknown as GraphFetch);
    expect(members).toEqual([{ aadObjectId: "u1", id: "u1", name: "U1", email: "u1@x.com" }]);
    expect(fetchImpl.mock.calls[1][1].headers.authorization).toBe("Bearer TT");
  });

  it("caches the app token and reuses it across roster reads (no second token round-trip)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ access_token: "TT", expires_in: 3600 })) // token (once)
      .mockResolvedValueOnce(ok({ value: [{ userId: "u1", displayName: "U1", email: "u1@x.com" }] })) // members read #1
      .mockResolvedValueOnce(ok({ value: [{ userId: "u1", displayName: "U1", email: "u1@x.com" }] })); // members read #2
    const input = { tenantId: "t", clientId: "c", clientSecret: "s", groupId: "g" };
    await readTeamRoster(input, fetchImpl as unknown as GraphFetch);
    await readTeamRoster(input, fetchImpl as unknown as GraphFetch);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 token + 2 members, NOT 4
    const tokenCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/oauth2/v2.0/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("on a 401 members response, drops the cached token and retries once with a fresh one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ access_token: "T1", expires_in: 3600 })) // token 1
      .mockResolvedValueOnce(err(401, "token expired")) // members → 401
      .mockResolvedValueOnce(ok({ access_token: "T2", expires_in: 3600 })) // token 2 (re-mint)
      .mockResolvedValueOnce(ok({ value: [{ userId: "u", displayName: "U", email: "u@x.com" }] })); // members OK
    const members = await readTeamRoster({ tenantId: "t", clientId: "c", clientSecret: "s", groupId: "g" }, fetchImpl as unknown as GraphFetch);
    expect(members.map((m) => m.id)).toEqual(["u"]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[3][1].headers.authorization).toBe("Bearer T2"); // retried with the fresh token
  });
});
