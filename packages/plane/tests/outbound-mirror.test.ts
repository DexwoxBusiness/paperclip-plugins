import { describe, expect, it } from "vitest";
import {
  attributeComment,
  createOutboundMirrorHandler,
  createOutboundQueue,
  evaluateMirror,
  isTransient,
  type OutboundConfig,
  type OutboundEvent,
} from "../src/outbound-mirror.js";
import { PlaneApiError } from "../src/plane-client.js";

const CONFIG: OutboundConfig = {
  stateMap: { in_progress: "In Progress", done: "Done" },
  pluginId: "dexwox.plane-sync",
};

function statusEvent(overrides: Partial<OutboundEvent> = {}): OutboundEvent {
  return { kind: "status", paperclipIssueId: "pc-1", actorType: "agent", actorId: "agent-1", newStatus: "in_progress", ...overrides };
}
function commentEvent(overrides: Partial<OutboundEvent> = {}): OutboundEvent {
  return { kind: "comment", paperclipIssueId: "pc-1", actorType: "agent", actorId: "agent-1", commentBody: "Working on it", commentAuthor: "Ada", ...overrides };
}

describe("evaluateMirror (PCLIP-4)", () => {
  it("skips a change this plugin authored — echo-loop guard (AC #3)", () => {
    expect(evaluateMirror(statusEvent({ actorType: "plugin", actorId: "dexwox.plane-sync" }), CONFIG)).toMatchObject({ kind: "skip", reason: "echo" });
    // a plugin change from a DIFFERENT plugin is not our echo
    expect(evaluateMirror(statusEvent({ actorType: "plugin", actorId: "other" }), CONFIG)).toMatchObject({ kind: "state" });
  });

  it("maps a Paperclip status to the configured Plane state (AC #1)", () => {
    expect(evaluateMirror(statusEvent({ newStatus: "done" }), CONFIG)).toEqual({ kind: "state", planeState: "Done" });
  });

  it("skips a status with no configured mapping", () => {
    expect(evaluateMirror(statusEvent({ newStatus: "archived" }), CONFIG)).toMatchObject({ kind: "skip", reason: "no-state-mapping" });
  });

  it("attributes a mirrored comment (AC #2)", () => {
    const d = evaluateMirror(commentEvent(), CONFIG);
    expect(d.kind).toBe("comment");
    if (d.kind === "comment") {
      expect(d.commentHtml).toContain("Working on it");
      expect(d.commentHtml).toContain("Ada via Paperclip");
    }
  });

  it("falls back to a generic attribution when the author is missing", () => {
    expect(attributeComment("hi")).toContain("Paperclip agent via Paperclip");
  });

  it("skips an empty comment", () => {
    expect(evaluateMirror(commentEvent({ commentBody: "  " }), CONFIG)).toMatchObject({ kind: "skip", reason: "empty-comment" });
  });
});

describe("createOutboundQueue (AC #4 durable retry)", () => {
  function makeQueue(now: () => number) {
    const store = new Map<string, unknown>();
    return createOutboundQueue(
      { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      { now, baseBackoffMs: 100, maxBackoffMs: 1000, maxAttempts: 3 },
    );
  }

  it("removes an item on successful delivery", async () => {
    let clock = 1000;
    const q = makeQueue(() => clock);
    await q.enqueue({ planeRef: "p1", kind: "state", planeState: "Done" });
    const res = await q.drain(async () => {}, clock);
    expect(res.delivered).toBe(1);
    expect(await q.list()).toHaveLength(0);
  });

  it("retries a transient failure with backoff, then delivers (no data loss)", async () => {
    let clock = 1000;
    const q = makeQueue(() => clock);
    await q.enqueue({ planeRef: "p1", kind: "state", planeState: "Done" });
    let fail = true;
    const deliver = async () => {
      if (fail) {
        fail = false;
        throw new PlaneApiError("unavailable", undefined, "down");
      }
    };
    let res = await q.drain(deliver, clock);
    expect(res).toMatchObject({ delivered: 0, retried: 1 });
    expect(await q.list()).toHaveLength(1); // persisted, not lost
    // not due yet
    res = await q.drain(deliver, clock + 50);
    expect(res.delivered).toBe(0);
    // after backoff -> delivered
    clock += 200;
    res = await q.drain(deliver, clock);
    expect(res.delivered).toBe(1);
    expect(await q.list()).toHaveLength(0);
  });

  it("dead-letters a permanent failure (dropped, not retried forever)", async () => {
    let clock = 1000;
    const q = makeQueue(() => clock);
    await q.enqueue({ planeRef: "p1", kind: "comment", commentHtml: "x" });
    const res = await q.drain(async () => { throw new PlaneApiError("bad_request", 400, "nope"); }, clock);
    expect(res).toMatchObject({ delivered: 0, deadLettered: 1 });
    expect(await q.list()).toHaveLength(0);
  });

  it("classifies transient vs permanent kinds", () => {
    expect(isTransient("unavailable")).toBe(true);
    expect(isTransient("rate_limited")).toBe(true);
    expect(isTransient("not_found")).toBe(false);
    expect(isTransient("unauthorized")).toBe(false);
  });
});

describe("createOutboundMirrorHandler (PCLIP-4)", () => {
  function makeHarness(opts: { unmapped?: boolean; failStateKind?: string; failTimes?: number } = {}) {
    const store = new Map<string, unknown>();
    let clock = 1000;
    const queue = createOutboundQueue(
      { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      { now: () => clock, baseBackoffMs: 100, maxBackoffMs: 1000, maxAttempts: 3 },
    );
    const calls: Array<{ op: string; ref: string; arg: string }> = [];
    let failTimes = opts.failTimes ?? 0;
    const plane = {
      updateState: async (ref: string, state: string) => {
        calls.push({ op: "state", ref, arg: state });
        if (failTimes-- > 0) throw new PlaneApiError((opts.failStateKind ?? "unavailable") as never, 503, "down");
        return { id: ref, identifier: ref, state, url: "" };
      },
      addComment: async (ref: string, html: string) => {
        calls.push({ op: "comment", ref, arg: html });
        return { id: "c1", url: "" };
      },
    };
    const idMapping = {
      resolveByPaperclipId: async (id: string) =>
        opts.unmapped ? null : { planeId: `plane-${id}`, paperclipIssueId: id, planeType: "issue", stale: false },
    };
    const logs: string[] = [];
    const handler = createOutboundMirrorHandler({
      idMapping,
      plane,
      queue,
      getConfig: async () => CONFIG,
      log: (m) => logs.push(m),
    });
    return { handler, queue, calls, logs, setClock: (n: number) => (clock = n), clock: () => clock };
  }

  it("mirrors a status change to the mapped Plane item (AC #1)", async () => {
    const h = makeHarness();
    const out = await h.handler.handle(statusEvent({ newStatus: "done" }));
    expect(out).toMatchObject({ kind: "queued", delivered: true });
    expect(h.calls).toEqual([{ op: "state", ref: "plane-pc-1", arg: "Done" }]);
    expect(await h.queue.list()).toHaveLength(0);
  });

  it("mirrors a comment with attribution (AC #2)", async () => {
    const h = makeHarness();
    await h.handler.handle(commentEvent());
    expect(h.calls[0].op).toBe("comment");
    expect(h.calls[0].arg).toContain("Ada via Paperclip");
  });

  it("does NOT mirror an inbound (plugin-authored) change (AC #3)", async () => {
    const h = makeHarness();
    const out = await h.handler.handle(statusEvent({ actorType: "plugin", actorId: "dexwox.plane-sync" }));
    expect(out).toMatchObject({ kind: "skipped", reason: "echo" });
    expect(h.calls).toHaveLength(0);
  });

  it("skips when the Paperclip issue has no live Plane mapping", async () => {
    const h = makeHarness({ unmapped: true });
    const out = await h.handler.handle(statusEvent());
    expect(out).toMatchObject({ kind: "skipped", reason: "no-mapping" });
    expect(h.calls).toHaveLength(0);
  });

  it("queues and retries on a transient Plane outage — no data loss (AC #4)", async () => {
    const h = makeHarness({ failTimes: 1, failStateKind: "unavailable" });
    const out = await h.handler.handle(statusEvent({ newStatus: "done" }));
    expect(out).toMatchObject({ kind: "queued", delivered: false }); // first attempt failed
    expect(await h.queue.list()).toHaveLength(1); // persisted, not lost
    // advance past backoff and drain (as the scheduled job would)
    h.setClock(h.clock() + 500);
    const res = await h.handler.drainDue(h.clock());
    expect(res.delivered).toBe(1);
    expect(await h.queue.list()).toHaveLength(0);
    expect(h.calls.filter((c) => c.op === "state")).toHaveLength(2); // failed once, then succeeded
  });
});
