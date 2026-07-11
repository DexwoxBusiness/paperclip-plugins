import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGraphTokenCache, fetchGraphAppToken, fetchTeamMembers, readTeamRoster, type GraphFetch } from "../src/graph-members.js";

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
