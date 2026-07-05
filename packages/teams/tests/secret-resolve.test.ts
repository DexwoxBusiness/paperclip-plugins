import { describe, expect, it, vi } from "vitest";
import { resolveSecretRef, safeErrorClass } from "../src/secret-resolve.js";

const SECRET = "super-secret-client-secret-value-9f3a";
const REF = "ref-uuid-1234";

/** A logger spy that records every (message, fields) call for leak assertions. */
function spyLog() {
  const calls: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const log = (message: string, fields?: Record<string, unknown>) => calls.push({ message, fields });
  const dump = () => JSON.stringify(calls);
  return { log, calls, dump };
}

describe("resolveSecretRef", () => {
  it("unset ref (undefined/empty/whitespace) → status unset, never resolves or logs", async () => {
    const resolve = vi.fn<(ref: string) => Promise<string>>();
    const { log, calls } = spyLog();
    for (const ref of [undefined, null, "", "   "]) {
      expect(await resolveSecretRef(resolve, ref as string | undefined, log, "err")).toEqual({ value: "", status: "unset" });
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("resolves a non-empty secret; NEVER logs on success", async () => {
    const resolve = vi.fn(async () => SECRET);
    const { log, dump } = spyLog();
    const r = await resolveSecretRef(resolve, REF, log, "err");
    expect(r).toEqual({ value: SECRET, status: "resolved" });
    expect(resolve).toHaveBeenCalledWith(REF);
    // No log call at all on success → the value cannot have leaked to logs.
    expect(dump()).not.toContain(SECRET);
    expect(dump()).toBe("[]");
  });

  it("empty resolved value → status unset (no usable secret)", async () => {
    const { log } = spyLog();
    expect(await resolveSecretRef(async () => "", REF, log, "err")).toEqual({ value: "", status: "unset" });
  });

  it("on error → status error, logs ONLY a generic message + error class (no ref, no value)", async () => {
    const resolve = async () => { throw new Error("boom from secret provider"); };
    const { log, calls, dump } = spyLog();
    const r = await resolveSecretRef(resolve, REF, log, "could not resolve botAppCredentialsRef");
    expect(r).toEqual({ value: "", status: "error" });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe("could not resolve botAppCredentialsRef");
    expect(calls[0].fields).toEqual({ errorClass: "Error" });
    // The ref id itself must not be logged either.
    expect(dump()).not.toContain(REF);
  });

  it("NO-LEAK: even if the provider error message embeds the secret, it never reaches the log", async () => {
    // Pathological provider that echoes the secret in its error message.
    const resolve = async () => { throw new Error(`provider failed for value=${SECRET}`); };
    const { log, dump } = spyLog();
    const r = await resolveSecretRef(resolve, REF, log, "could not resolve secret");
    expect(r.status).toBe("error");
    // The helper logs only the error CLASS, so the secret cannot appear anywhere in the logs.
    expect(dump()).not.toContain(SECRET);
  });

  it("NO-LEAK: a non-Error throw is classified as 'unknown', still no leak", async () => {
    const resolve = async () => { throw SECRET; }; // throwing the raw secret string itself
    const { log, calls, dump } = spyLog();
    const r = await resolveSecretRef(resolve, REF, log, "could not resolve secret");
    expect(r.status).toBe("error");
    expect(calls[0].fields).toEqual({ errorClass: "unknown" });
    expect(dump()).not.toContain(SECRET);
  });

  it("NO-LEAK: an Error whose NAME is the secret is bucketed to 'unknown' (Codex P2)", async () => {
    // A hostile/pathological provider that puts secret material in Error.name.
    const resolve = async () => { throw Object.assign(new Error("boom"), { name: SECRET }); };
    const { log, calls, dump } = spyLog();
    const r = await resolveSecretRef(resolve, REF, log, "could not resolve secret");
    expect(r.status).toBe("error");
    expect(calls[0].fields).toEqual({ errorClass: "unknown" }); // NOT the secret name
    expect(dump()).not.toContain(SECRET);
  });
});

describe("safeErrorClass", () => {
  it("passes allowlisted standard classes, buckets everything else to 'unknown'", () => {
    expect(safeErrorClass(new TypeError("x"))).toBe("TypeError");
    expect(safeErrorClass(new Error("x"))).toBe("Error");
    expect(safeErrorClass(new RangeError("x"))).toBe("RangeError");
    // Anything not on the allowlist — including a crafted secret name — is bucketed.
    expect(safeErrorClass(Object.assign(new Error(), { name: "sk-live-secret-123" }))).toBe("unknown");
    expect(safeErrorClass("a raw string")).toBe("unknown");
    expect(safeErrorClass(null)).toBe("unknown");
    expect(safeErrorClass(undefined)).toBe("unknown");
  });
});
