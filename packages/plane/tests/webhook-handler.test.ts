import { describe, expect, it } from "vitest";
import { computePlaneSignature } from "../src/signature.js";
import {
  WebhookRejectedError,
  createSeenChecker,
  deliveryHash,
  handlePlaneWebhook,
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
  deliveries: Array<{ requestId: string; outcome: string; detail?: string }>;
  routed: ParsedPlaneEvent[];
  logs: string[];
}

function makeDeps(secret = SECRET): { deps: WebhookHandlerDeps; recorded: Recorded } {
  const recorded: Recorded = { deliveries: [], routed: [], logs: [] };
  const stateData = new Map<string, unknown>();
  const deps: WebhookHandlerDeps = {
    getSecret: async () => secret,
    checkAndMarkSeen: createSeenChecker({
      get: async (k) => stateData.get(k) ?? null,
      set: async (k, v) => void stateData.set(k, v),
    }),
    recordDelivery: async (entry) => void recorded.deliveries.push(entry),
    routeEvent: async (event) => void recorded.routed.push(event),
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

describe("handlePlaneWebhook (PCLIP-1)", () => {
  it("accepts a correctly signed payload and routes it", async () => {
    const { deps, recorded } = makeDeps();
    const body = makeBody();

    await handlePlaneWebhook(signedRequest(body), deps);

    expect(recorded.routed).toHaveLength(1);
    expect(recorded.routed[0]).toMatchObject({ event: "issue", action: "created", entityId: "issue-1", projectId: "proj-1" });
    expect(recorded.deliveries).toEqual([
      expect.objectContaining({ requestId: "req-1", outcome: "accepted", detail: "issue.created" }),
    ]);
  });

  it("rejects a missing signature with 401 and never routes", async () => {
    const { deps, recorded } = makeDeps();

    await expect(
      handlePlaneWebhook({ headers: {}, rawBody: makeBody(), requestId: "req-2" }, deps),
    ).rejects.toBeInstanceOf(WebhookRejectedError);

    expect(recorded.routed).toHaveLength(0);
    expect(recorded.deliveries).toEqual([
      expect.objectContaining({ outcome: "rejected", detail: "missing signature" }),
    ]);
  });

  it("rejects an invalid signature and logs the attempt", async () => {
    const { deps, recorded } = makeDeps();
    const body = makeBody();

    await expect(
      handlePlaneWebhook(
        { headers: { "X-Plane-Signature": computePlaneSignature(body, "wrong") }, rawBody: body, requestId: "req-3" },
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(recorded.deliveries[0]).toMatchObject({ outcome: "rejected", detail: "invalid signature" });
    expect(recorded.logs).toContain("plane webhook rejected");
  });

  it("is idempotent for duplicate deliveries (Plane CE #6848)", async () => {
    const { deps, recorded } = makeDeps();
    const body = makeBody();

    await handlePlaneWebhook(signedRequest(body, "req-4a"), deps);
    await handlePlaneWebhook(signedRequest(body, "req-4b"), deps);

    expect(recorded.routed).toHaveLength(1); // routed exactly once
    expect(recorded.deliveries.map((d) => d.outcome)).toEqual(["accepted", "duplicate"]);
  });

  it("records but ignores unparseable payloads (signed garbage)", async () => {
    const { deps, recorded } = makeDeps();
    const body = "not-json";

    await handlePlaneWebhook(signedRequest(body, "req-5"), deps);

    expect(recorded.routed).toHaveLength(0);
    expect(recorded.deliveries[0]).toMatchObject({ outcome: "ignored" });
  });

  it("records every delivery outcome (observability AC)", async () => {
    const { deps, recorded } = makeDeps();
    const body = makeBody();

    await handlePlaneWebhook(signedRequest(body, "a"), deps); // accepted
    await handlePlaneWebhook(signedRequest(body, "b"), deps); // duplicate
    await expect(handlePlaneWebhook({ headers: {}, rawBody: body, requestId: "c" }, deps)).rejects.toThrow(); // rejected

    expect(recorded.deliveries).toHaveLength(3);
  });
});

describe("createSeenChecker", () => {
  it("evicts oldest entries beyond capacity (bounded memory)", async () => {
    const stateData = new Map<string, unknown>();
    const check = createSeenChecker(
      { get: async (k) => stateData.get(k) ?? null, set: async (k, v) => void stateData.set(k, v) },
      "seen",
      2,
    );

    expect(await check("h1")).toBe(false);
    expect(await check("h2")).toBe(false);
    expect(await check("h3")).toBe(false); // evicts h1
    expect(await check("h1")).toBe(false); // h1 forgotten -> treated as new
    expect(await check("h3")).toBe(true); // h3 still remembered
  });
});

describe("deliveryHash", () => {
  it("is stable for identical bodies and distinct for different bodies", () => {
    expect(deliveryHash("abc")).toBe(deliveryHash("abc"));
    expect(deliveryHash("abc")).not.toBe(deliveryHash("abd"));
  });
});
