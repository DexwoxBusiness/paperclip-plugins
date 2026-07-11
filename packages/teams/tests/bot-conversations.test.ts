import { describe, expect, it, vi } from "vitest";
import {
  conversationKey,
  createConversationStore,
  isPersonalConversationRef,
  resolveInboundChannelData,
  type ConversationRef,
  type ConversationStoreBackend,
} from "../src/bot-conversations.js";

describe("isPersonalConversationRef (PCLIP-43 — gate ask DMs to 1:1 chats, fail closed)", () => {
  it("passes only a personal 1:1 conversation", () => {
    expect(isPersonalConversationRef({ conversation: { id: "a", conversationType: "personal" } })).toBe(true);
    expect(isPersonalConversationRef({ conversation: { id: "b", conversationType: "channel" } })).toBe(false);
    expect(isPersonalConversationRef({ conversation: { id: "c", conversationType: "groupChat" } })).toBe(false);
    expect(isPersonalConversationRef({ conversation: { id: "d" } })).toBe(false);
    expect(isPersonalConversationRef(undefined)).toBe(false);
  });
});

function makeBackend(): ConversationStoreBackend & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

const ref = (id: string, over: Partial<ConversationRef> = {}): ConversationRef => ({
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  conversation: { id, conversationType: "channel" },
  ...over,
});

describe("resolveInboundChannelData (T13 — resolve team.aadGroupId on the inbound turn)", () => {
  it("fetches aadGroupId via getTeamDetails when a team turn lacks it, and merges it in", async () => {
    const fetch = vi.fn().mockResolvedValue("group-guid");
    const out = await resolveInboundChannelData({ team: { id: "19:team@thread.tacv2" } }, fetch);
    expect(out?.team?.aadGroupId).toBe("group-guid");
    expect(fetch).toHaveBeenCalledWith("19:team@thread.tacv2"); // the stored team thread id keys getTeamDetails
  });

  it("does NOT call getTeamDetails when aadGroupId is already present (no redundant Connector call)", async () => {
    const fetch = vi.fn();
    const out = await resolveInboundChannelData({ team: { id: "19:t", aadGroupId: "already" } }, fetch);
    expect(out?.team?.aadGroupId).toBe("already");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing for a non-team turn (personal chat / no team.id)", async () => {
    const fetch = vi.fn();
    expect(await resolveInboundChannelData(undefined, fetch)).toBeUndefined();
    expect(await resolveInboundChannelData({ tenant: { id: "t" } }, fetch)).toEqual({ tenant: { id: "t" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves channelData unchanged when the lookup fails or returns nothing (retried next turn, never throws)", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("connector 500"));
    expect(await resolveInboundChannelData({ team: { id: "19:t" } }, boom)).toEqual({ team: { id: "19:t" } });
    const empty = vi.fn().mockResolvedValue("   ");
    expect((await resolveInboundChannelData({ team: { id: "19:t" } }, empty))?.team?.aadGroupId).toBeUndefined();
  });
});

describe("conversationKey", () => {
  it("uses the conversation id; null when absent/blank", () => {
    expect(conversationKey(ref("19:abc@thread.tacv2"))).toBe("19:abc@thread.tacv2");
    expect(conversationKey({ conversation: { id: "  " } })).toBeNull();
    expect(conversationKey({})).toBeNull();
  });
});

describe("conversation store (PCLIP-23 proactive)", () => {
  it("remembers a reference and reads it back", async () => {
    const store = createConversationStore(makeBackend(), { now: () => 100 });
    const key = await store.remember(ref("19:team-1"));
    expect(key).toBe("19:team-1");
    const got = await store.get("19:team-1");
    expect(got?.reference.serviceUrl).toContain("smba");
    expect(got?.updatedAt).toBe(100);
  });

  it("is idempotent per conversation id — refresh, not duplicate", async () => {
    let t = 1;
    const store = createConversationStore(makeBackend(), { now: () => t });
    await store.remember(ref("19:team-1", { serviceUrl: "https://old/" }));
    t = 2;
    await store.remember(ref("19:team-1", { serviceUrl: "https://new/" }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].reference.serviceUrl).toBe("https://new/");
    expect(all[0].updatedAt).toBe(2);
  });

  it("returns null (no store write) for a reference without a conversation id", async () => {
    const backend = makeBackend();
    const store = createConversationStore(backend);
    expect(await store.remember({ channelId: "msteams" })).toBeNull();
    expect(backend.map.size).toBe(0);
  });

  it("lists newest-first and forgets a conversation", async () => {
    let t = 0;
    const store = createConversationStore(makeBackend(), { now: () => ++t });
    await store.remember(ref("a"));
    await store.remember(ref("b"));
    const list = await store.list();
    expect(list.map((c) => c.key)).toEqual(["b", "a"]);
    await store.forget("b");
    expect((await store.list()).map((c) => c.key)).toEqual(["a"]);
  });

  it("merge callback computes the stored ref from the existing entry (atomic read-modify-write)", async () => {
    let t = 1;
    const store = createConversationStore(makeBackend(), { now: () => t });
    // Turn 1: capture the team's AAD group id.
    await store.remember(ref("19:c", { channelData: { team: { id: "19:c", aadGroupId: "group-1" } } }));
    // Turn 2: a channelData WITHOUT team.aadGroupId — the merge must preserve the earlier capture.
    t = 2;
    await store.remember(ref("19:c", { serviceUrl: "https://new/" }), (existing) => {
      const priorCd = existing?.reference.channelData;
      return { ...ref("19:c", { serviceUrl: "https://new/" }), channelData: { ...priorCd, team: { ...priorCd?.team } } };
    });
    const got = await store.get("19:c");
    expect(got?.reference.channelData?.team?.aadGroupId).toBe("group-1"); // preserved across the turn
    expect(got?.reference.serviceUrl).toBe("https://new/"); // other fields refreshed
    expect(got?.updatedAt).toBe(2);
  });

  it("merge receives undefined when there is no prior entry", async () => {
    const store = createConversationStore(makeBackend(), { now: () => 5 });
    let sawExisting: unknown = "sentinel";
    await store.remember(ref("19:new"), (existing) => {
      sawExisting = existing;
      return ref("19:new", { channelData: { team: { aadGroupId: "g" } } });
    });
    expect(sawExisting).toBeUndefined();
    expect((await store.get("19:new"))?.reference.channelData?.team?.aadGroupId).toBe("g");
  });

  it("serializes concurrent remembers without losing entries", async () => {
    const store = createConversationStore(makeBackend());
    await Promise.all(Array.from({ length: 15 }, (_, i) => store.remember(ref(`c-${i}`))));
    expect(await store.list()).toHaveLength(15);
  });

  it("coerces malformed persisted state to empty", async () => {
    const backend = makeBackend();
    backend.map.set("bot:conversations", { junk: 1, x: { key: 5 } });
    const store = createConversationStore(backend);
    expect(await store.list()).toEqual([]);
  });
});
