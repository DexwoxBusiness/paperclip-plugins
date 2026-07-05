import { describe, expect, it, vi } from "vitest";
import { resolveSecretRef } from "../src/secret-resolve.js";

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
});
