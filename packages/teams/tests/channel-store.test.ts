import { beforeEach, describe, expect, it } from "vitest";
import { createChannelStore, type ChannelStoreBackend } from "../src/channel-store.js";
import type { ChannelPost, ChannelResponse } from "../src/channel.js";

/** In-memory backend mirroring the ask-store tests. */
function memBackend(): ChannelStoreBackend & { dump: Record<string, unknown> } {
  const dump: Record<string, unknown> = {};
  return {
    dump,
    async get(k) {
      return dump[k];
    },
    async set(k, v) {
      dump[k] = v;
    },
  };
}

function post(overrides: Partial<ChannelPost> = {}): ChannelPost {
  return {
    id: "chpost-1",
    channelRef: "19:abc@thread.tacv2",
    agentId: "agent-1",
    companyId: "co-1",
    prompt: "standup",
    collect: true,
    status: "open",
    createdAtMs: 1,
    responses: {},
    ...overrides,
  };
}

function resp(by: string, text: string, atMs = 100): ChannelResponse {
  return { by, byName: `name-${by}`, values: { answer: text }, atMs };
}

describe("channel-store", () => {
  let backend: ReturnType<typeof memBackend>;
  beforeEach(() => {
    backend = memBackend();
  });

  it("create + get + listOpen", async () => {
    const store = createChannelStore(backend, { now: () => 5 });
    await store.create(post(), { conversationReference: { c: 1 }, activityId: "act-1" });
    const e = await store.get("chpost-1");
    expect(e?.post.id).toBe("chpost-1");
    expect(e?.activityId).toBe("act-1");
    const open = await store.listOpen();
    expect(open.map((x) => x.post.id)).toEqual(["chpost-1"]);
  });

  it("recordResponse adds one entry per person and OVERWRITES a re-submit (last-write-wins)", async () => {
    const store = createChannelStore(backend);
    await store.create(post());
    await store.recordResponse("chpost-1", resp("teams:aad-1", "first"));
    await store.recordResponse("chpost-1", resp("teams:aad-2", "hello"));
    const again = await store.recordResponse("chpost-1", resp("teams:aad-1", "updated"));
    expect(Object.keys(again!.post.responses).sort()).toEqual(["teams:aad-1", "teams:aad-2"]);
    expect(again!.post.responses["teams:aad-1"].values.answer).toBe("updated");
  });

  it("recordResponse returns null on unknown or closed posts (submit to a closed round is a no-op)", async () => {
    const store = createChannelStore(backend);
    expect(await store.recordResponse("nope", resp("teams:x", "y"))).toBeNull();
    await store.create(post());
    await store.close("chpost-1", 200);
    expect(await store.recordResponse("chpost-1", resp("teams:x", "y"))).toBeNull();
  });

  it("close transitions open→closed, drops from the open index, and is single-shot", async () => {
    const store = createChannelStore(backend);
    await store.create(post());
    const done = await store.close("chpost-1", 200);
    expect(done?.post.status).toBe("closed");
    expect(await store.listOpen()).toHaveLength(0);
    expect(await store.close("chpost-1", 300)).toBeNull(); // already closed
  });

  it("close returns the post-close snapshot INCLUDING responses (what get_channel_responses reports — Codex P2)", async () => {
    const store = createChannelStore(backend);
    await store.create(post());
    await store.recordResponse("chpost-1", resp("teams:a1", "morning"));
    const done = await store.close("chpost-1", 200);
    // The returned entry must carry the responses recorded up to close, so the tool can report the
    // final set rather than a stale pre-close read.
    expect(Object.keys(done!.post.responses)).toEqual(["teams:a1"]);
    expect(done!.post.responses["teams:a1"].values.answer).toBe("morning");
    expect(done!.post.status).toBe("closed");
  });

  it("close enforces ownership: a non-owner can't close another agent/company's post", async () => {
    const store = createChannelStore(backend);
    await store.create(post({ agentId: "owner", companyId: "co-1" }));
    expect(await store.close("chpost-1", 200, { agentId: "intruder", companyId: "co-1" })).toBeNull();
    expect(await store.close("chpost-1", 200, { agentId: "owner", companyId: "co-2" })).toBeNull();
    expect((await store.get("chpost-1"))?.post.status).toBe("open"); // untouched
    expect(await store.close("chpost-1", 200, { agentId: "owner", companyId: "co-1" })).not.toBeNull();
  });

  it("coerces a legacy record missing `responses` into an empty map (no crash)", async () => {
    const store = createChannelStore(backend);
    // Simulate an older persisted entry with no responses field.
    backend.dump["chpost:legacy"] = { post: { ...post({ id: "legacy" }), responses: undefined }, updatedAtMs: 0 };
    const e = await store.get("legacy");
    expect(e?.post.responses).toEqual({});
  });
});
