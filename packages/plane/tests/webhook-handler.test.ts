import { describe, expect, it } from "vitest";
import { computePlaneSignature } from "../src/signature.js";
import {
  WebhookRejectedError,
  createDeliveryRecorder,
  createPlaneWebhookHandler,
  createSeenStore,
  deliveryHash,
  type DeliveryRecord,
  type ParsedPlaneEvent,
  type WebhookHandlerDeps,
} from "../src/webhook-handler.js";

const SECRET = "test-webhook-secret";

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "issue",
    action: "created",
    workspace_id: "ws-1",
    data: { id: "issue-1", project: "proj-1", name: "Sample" },
    ...overrides,
  });
}

interface Recorded {
  deliveries: DeliveryRecord[];
  routed: ParsedPlaneEvent[];
  logs: string[];
}

interface DepsOptions {
  secret?: string;
  routeEvent?: (event: ParsedPlaneEvent) => Promise<void>;
  recordDelivery?: (entry: DeliveryRecord) => Promise<void>;
}

function makeDeps(options: DepsOptions = {}): { deps: WebhookHandlerDeps; recorded: Recorded } {
  const recorded: Recorded = { deliveries: [], routed: [], logs: [] };
  const stateData = new Map<string, unknown>();
  const seenStore = createSeenStore({
    get: async (k) => stateData.get(k) ?? null,
    set: async (k, v) => void stateData.set(k, v),
  });
  const deps: WebhookHandlerDeps = {
    getSecret: async () => options.secret ?? SECRET,
    isSeen: seenStore.isSeen,
    markSeen: seenStore.markSeen,
    recordDelivery:
      options.recordDelivery ?? (async (entry) => void recorded.deliveries.push(entry)),
    routeEvent:
      options.routeEvent ?? (async (event) => void recorded.routed.push(event)),
    log: (message) => void recorded.logs.push(message),
  };
  return { deps, recorded };
}

function signedRequest(rawBody: string, requestId = "req-1") {
  return {
    headers: { "X-Plane-Signature": computePlaneSignature(rawBody, SECRET) },
    rawBody,
    requestId,
  };
}

describe("createPlaneWebhookHandler (PCLIP-1)", () => {
  it("accepts a correctly signed payload and routes it", async () => {
    const { deps, recorded } = makeDeps();
    const handler = createPlaneWebhookHandler(deps);

    await handler.handle(signedRequest(makeBody()));

    expect(recorded.routed).toHaveLength(1);
    expect(recorded.routed[0]).toMatchObject({ event: "issue", action: "created", entityId: "issue-1", projectId: "proj-1" });
    expect(recorded.deliveries).toEqual([
      expect.objectContaining({ requestId: "req-1", outcome: "accepted", detail: "issue.created" }),
    ]);
  });

  it("rejects a missing signature with 401 and never routes", async () => {
    const { deps, recorded } = makeDeps();
    const handler = createPlaneWebhookHandler(deps);

    await expect(
      handler.handle({ headers: {}, rawBody: makeBody(), requestId: "req-2" }),
    ).rejects.toBeInstanceOf(WebhookRejectedError);

    expect(recorded.routed).toHaveLength(0);
    expect(recorded.deliveries).toEqual([
      expect.objectContaining({ outcome: "rejected", detail: "missing signature" }),
    ]);
  });

  it("rejects an invalid signature and logs the attempt", async () => {
    const { deps, recorded } = makeDeps();
    const handler = createPlaneWebhookHandler(deps);
    const body = makeBody();

    await expect(
      handler.handle({
        headers: { "X-Plane-Signature": computePlaneSignature(body, "wrong") },
        rawBody: body,
        requestId: "req-3",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(recorded.deliveries[0]).toMatchObject({ outcome: "rejected", detail: "invalid signature" });
    expect(recorded.logs).toContain("plane webhook rejected");
  });

  it("still throws the 401 when recordDelivery itself fails (Kody: observability never masks control flow)", async () => {
    const recorded: Recorded = { deliveries: [], routed: [], logs: [] };
    const { deps } = makeDeps({
      recordDelivery: async () => {
        throw new Error("state store down");
      },
    });
    const depsWithLogs: WebhookHandlerDeps = { ...deps, log: (m) => void recorded.logs.push(m) };
    const handler = createPlaneWebhookHandler(depsWithLogs);

    await expect(
      handler.handle({ headers: {}, rawBody: makeBody(), requestId: "req-k1" }),
    ).rejects.toBeInstanceOf(WebhookRejectedError); // NOT "state store down"

    expect(recorded.logs).toContain("failed to record delivery");
  });

  it("is idempotent for duplicate deliveries (Plane CE #6848)", async () => {
    const { deps, recorded } = makeDeps();
    const handler = createPlaneWebhookHandler(deps);
    const body = makeBody();

    await handler.handle(signedRequest(body, "req-4a"));
    await handler.handle(signedRequest(body, "req-4b"));

    expect(recorded.routed).toHaveLength(1); // routed exactly once
    expect(recorded.deliveries.map((d) => d.outcome)).toEqual(["accepted", "duplicate"]);
  });

  it("serializes concurrent identical deliveries — only one routes (Kody: atomic check-and-mark)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const shared: Recorded = { deliveries: [], routed: [], logs: [] };
    const stateData = new Map<string, unknown>();
    const seenStore = createSeenStore({
      get: async (k) => stateData.get(k) ?? null,
      set: async (k, v) => void stateData.set(k, v),
    });
    const handler = createPlaneWebhookHandler({
      getSecret: async () => SECRET,
      isSeen: seenStore.isSeen,
      markSeen: seenStore.markSeen,
      recordDelivery: async (entry) => void shared.deliveries.push(entry),
      routeEvent: async (event) => {
        shared.routed.push(event);
        await gate;
      },
      log: (m) => void shared.logs.push(m),
    });
    const body = makeBody();

    const first = handler.handle(signedRequest(body, "conc-1"));
    const second = handler.handle(signedRequest(body, "conc-2"));
    await second; // completes as in-flight duplicate without routing
    release();
    await first;

    expect(shared.routed).toHaveLength(1);
    expect(shared.deliveries.map((d) => d.outcome).sort()).toEqual(["accepted", "duplicate"]);
  });

  it("does NOT mark a delivery seen when routing fails — retry reprocesses it (Codex: mark-after-success)", async () => {
    let failFirst = true;
    const shared: Recorded = { deliveries: [], routed: [], logs: [] };
    const stateData = new Map<string, unknown>();
    const seenStore = createSeenStore({
      get: async (k) => stateData.get(k) ?? null,
      set: async (k, v) => void stateData.set(k, v),
    });
    const handler = createPlaneWebhookHandler({
      getSecret: async () => SECRET,
      isSeen: seenStore.isSeen,
      markSeen: seenStore.markSeen,
      recordDelivery: async (entry) => void shared.deliveries.push(entry),
      routeEvent: async (event) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("transient Paperclip API failure");
        }
        shared.routed.push(event);
      },
      log: (m) => void shared.logs.push(m),
    });
    const body = makeBody();

    await expect(handler.handle(signedRequest(body, "retry-1"))).rejects.toThrow("transient");
    await handler.handle(signedRequest(body, "retry-2")); // Plane retry

    expect(shared.routed).toHaveLength(1); // retry succeeded, not treated as duplicate
    expect(shared.deliveries.map((d) => d.outcome)).toEqual(["failed", "accepted"]);
  });

  it("records but ignores invalid JSON (signed garbage)", async () => {
    const { deps, recorded } = makeDeps();
    const handler = createPlaneWebhookHandler(deps);

    await handler.handle(signedRequest("not-json", "req-5"));

    expect(recorded.routed).toHaveLength(0);
    expect(recorded.deliveries[0]).toMatchObject({ outcome: "ignored", detail: "invalid JSON" });
  });

  it("records but ignores valid JSON that is not a Plane event (distinct detail)", async () => {
    const { deps, recorded } = makeDeps();
    const handler = createPlaneWebhookHandler(deps);

    await handler.handle(signedRequest(JSON.stringify({ hello: "world" }), "req-6"));

    expect(recorded.routed).toHaveLength(0);
    expect(recorded.deliveries[0]).toMatchObject({ outcome: "ignored", detail: "not a Plane event" });
  });
});

describe("createSeenStore", () => {
  it("evicts oldest entries beyond capacity (bounded memory)", async () => {
    const stateData = new Map<string, unknown>();
    const store = createSeenStore(
      { get: async (k) => stateData.get(k) ?? null, set: async (k, v) => void stateData.set(k, v) },
      "seen",
      2,
    );

    await store.markSeen("h1");
    await store.markSeen("h2");
    await store.markSeen("h3"); // evicts h1
    expect(await store.isSeen("h1")).toBe(false);
    expect(await store.isSeen("h2")).toBe(true);
    expect(await store.isSeen("h3")).toBe(true);
  });
});

describe("createDeliveryRecorder (Codex: history, not just last)", () => {
  it("appends every delivery to a bounded history and mirrors last-delivery", async () => {
    const stateData = new Map<string, unknown>();
    const record = createDeliveryRecorder(
      { get: async (k) => stateData.get(k) ?? null, set: async (k, v) => void stateData.set(k, v) },
      "history",
      2,
    );

    await record({ requestId: "a", outcome: "accepted" });
    await record({ requestId: "b", outcome: "rejected" });
    await record({ requestId: "c", outcome: "duplicate" }); // evicts "a"

    const history = stateData.get("history") as Array<{ requestId: string }>;
    expect(history.map((h) => h.requestId)).toEqual(["b", "c"]);
    expect(stateData.get("last-delivery")).toMatchObject({ requestId: "c", outcome: "duplicate" });
    expect((stateData.get("last-delivery") as { at: string }).at).toBeTruthy();
  });
});

describe("deliveryHash", () => {
  it("is stable for identical bodies and distinct for different bodies", () => {
    expect(deliveryHash("abc")).toBe(deliveryHash("abc"));
    expect(deliveryHash("abc")).not.toBe(deliveryHash("abd"));
  });
});
