import { describe, expect, it } from "vitest";
import { channelFor, type ChannelKind, type TeamsNotification } from "../src/notifications.js";
import { CHANNEL_CONFIG_KEY, classifyWorkflowRef, isRawWorkflowUrl, resolveWorkflowRef, type TeamsUrlConfig } from "../src/routing.js";

const approval: TeamsNotification = { kind: "approval", approvalId: "a1", title: "t", requester: "r" };
const error: TeamsNotification = { kind: "agent-error", error: "e" };
const issueCreated: TeamsNotification = { kind: "issue-created", title: "t" };
const issueDone: TeamsNotification = { kind: "issue-done", title: "t" };
const budget: TeamsNotification = { kind: "budget-threshold", budgetId: "b1", threshold: 90 };

describe("channel routing (PCLIP-19)", () => {
  it("maps each notification kind to its channel", () => {
    expect(channelFor(approval)).toBe("approvals");
    expect(channelFor(error)).toBe("errors");
    expect(channelFor(issueCreated)).toBe("pipeline");
    expect(channelFor(issueDone)).toBe("pipeline");
    expect(channelFor(budget)).toBe("default");
  });

  it("routes an event to its per-type ref, not the default (AC #1)", () => {
    const cfg: TeamsUrlConfig = {
      defaultWorkflowUrl: "ref-default",
      approvalsWorkflowUrl: "ref-approvals",
      errorsWorkflowUrl: "ref-errors",
      pipelineWorkflowUrl: "ref-pipeline",
    };
    expect(resolveWorkflowRef(channelFor(approval), cfg)).toBe("ref-approvals");
    expect(resolveWorkflowRef(channelFor(error), cfg)).toBe("ref-errors");
    expect(resolveWorkflowRef(channelFor(issueCreated), cfg)).toBe("ref-pipeline");
    expect(resolveWorkflowRef(channelFor(budget), cfg)).toBe("ref-default");
  });

  it("falls back to the default ref when no per-type ref is set (AC #2)", () => {
    const cfg: TeamsUrlConfig = { defaultWorkflowUrl: "ref-default" };
    expect(resolveWorkflowRef(channelFor(approval), cfg)).toBe("ref-default");
    expect(resolveWorkflowRef(channelFor(error), cfg)).toBe("ref-default");
    expect(resolveWorkflowRef(channelFor(issueCreated), cfg)).toBe("ref-default");
  });

  it("treats a whitespace-only per-type ref as unset and falls back", () => {
    const cfg: TeamsUrlConfig = { defaultWorkflowUrl: "ref-default", approvalsWorkflowUrl: "   " };
    expect(resolveWorkflowRef("approvals", cfg)).toBe("ref-default");
  });

  // Reviewer note (Kody SUGGESTION — "channel configurable"): this proves the digest
  // resolves to its OWN configured channel (digestWorkflowUrl) and falls back to the
  // default when unset. The worker's digest job calls the SAME resolveChannelUrl →
  // safeDeliver path as every notification (worker.ts), so once the ref resolves to
  // the right URL here, delivery-to-channel is correct by construction; a separate
  // worker-integration test would need the plugin SDK (not installed in this repo)
  // and would only re-exercise safeDeliver, already covered in delivery.test.ts.
  it("routes the digest to its own channel when set, else falls back to default (PCLIP-21 AC #4)", () => {
    expect(resolveWorkflowRef("digest", { defaultWorkflowUrl: "ref-default", digestWorkflowUrl: "ref-digest" })).toBe("ref-digest");
    expect(resolveWorkflowRef("digest", { defaultWorkflowUrl: "ref-default" })).toBe("ref-default");
  });

  it("returns '' when nothing is configured (caller skips)", () => {
    expect(resolveWorkflowRef("approvals", {})).toBe("");
    expect(resolveWorkflowRef("default", { defaultWorkflowUrl: "" })).toBe("");
  });

  it("maps every channel to a real config key", () => {
    expect(CHANNEL_CONFIG_KEY).toEqual({
      approvals: "approvalsWorkflowUrl",
      errors: "errorsWorkflowUrl",
      pipeline: "pipelineWorkflowUrl",
      digest: "digestWorkflowUrl",
      default: "defaultWorkflowUrl",
    });
  });

  it("falls back to the default ref for an off-union channel rather than misrouting (defensive)", () => {
    const cfg: TeamsUrlConfig = { defaultWorkflowUrl: "ref-default" };
    expect(resolveWorkflowRef("nonsense" as ChannelKind, cfg)).toBe("ref-default");
  });
});

describe("secret-ref migration (Codex — preserve raw URLs)", () => {
  it("recognizes a pre-migration raw https URL vs a secret-ref", () => {
    expect(isRawWorkflowUrl("https://prod-1.westus.logic.azure.com/workflows/abc")).toBe(true);
    expect(isRawWorkflowUrl("http://example.com/hook")).toBe(true);
    expect(isRawWorkflowUrl("  https://x/y  ")).toBe(true); // trimmed
    // secret-refs (UUIDs) are not raw URLs -> resolved via the secret provider
    expect(isRawWorkflowUrl("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isRawWorkflowUrl("")).toBe(false);
  });
});

describe("classifyWorkflowRef (Kody — secret-ref trust boundary)", () => {
  const RAW = "https://prod-1.westus.logic.azure.com/workflows/abc";
  const REF = "550e8400-e29b-41d4-a716-446655440000";

  it("always resolves a secret-ref via the provider, regardless of the flag", () => {
    expect(classifyWorkflowRef(REF, false)).toBe("secret-ref");
    expect(classifyWorkflowRef(REF, true)).toBe("secret-ref");
  });

  it("BLOCKS a raw plaintext URL by default (secure) — trust boundary holds", () => {
    expect(classifyWorkflowRef(RAW, false)).toBe("raw-blocked");
  });

  it("allows a raw plaintext URL only when the operator opts in (legacy bridge)", () => {
    expect(classifyWorkflowRef(RAW, true)).toBe("raw-allowed");
  });
});
