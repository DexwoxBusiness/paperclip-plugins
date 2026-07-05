import { describe, expect, it } from "vitest";
import {
  conversationKey,
  createConversationStore,
  type ConversationRef,
  type ConversationStoreBackend,
} from "../src/bot-conversations.js";

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
