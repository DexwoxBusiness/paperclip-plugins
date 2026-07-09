import { describe, expect, it, vi } from "vitest";
import { isSecretRefShaped, resolveApiKey } from "../src/secret-resolve.js";

// A host secret-ref is an opaque UUID; a Plane API key never is.
const REF = "3f6acd0e-be3d-4e44-a643-c0817fb36c9f";
const RAW_KEY = "plane_api_9f3aQ8xK2mZ7bV1nR4tL6wY0cD5eH8jP";

describe("isSecretRefShaped", () => {
  it("true only for a UUID-shaped secret-ref", () => {
    expect(isSecretRefShaped(REF)).toBe(true);
    expect(isSecretRefShaped("  3F6ACD0E-BE3D-4E44-A643-C0817FB36C9F  ")).toBe(true);
  });
  it("false for raw keys and non-UUID strings", () => {
    expect(isSecretRefShaped(RAW_KEY)).toBe(false);
    expect(isSecretRefShaped("")).toBe(false);
    expect(isSecretRefShaped("3f6acd0e-be3d-4e44-a643-c0817fb36c9")).toBe(false); // one hex short
  });
});

describe("resolveApiKey", () => {
  it("unset/empty/whitespace → '' and never calls the provider", async () => {
    const resolve = vi.fn<(r: string) => Promise<string>>();
    for (const v of [undefined, null, "", "   "]) {
      expect(await resolveApiKey(resolve, v as string | undefined)).toBe("");
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("RAW key (non-UUID) → used as-is, NEVER calls the kill-switched provider", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("PLUGIN_SECRET_REFS_DISABLED");
    });
    expect(await resolveApiKey(resolve, RAW_KEY)).toBe(RAW_KEY);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("RAW key is trimmed", async () => {
    const resolve = vi.fn<(r: string) => Promise<string>>();
    expect(await resolveApiKey(resolve, `  ${RAW_KEY}\n`)).toBe(RAW_KEY);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("UUID secret-ref → resolved via the provider", async () => {
    const resolve = vi.fn(async (r: string) => `resolved:${r}`);
    expect(await resolveApiKey(resolve, REF)).toBe(`resolved:${REF}`);
    expect(resolve).toHaveBeenCalledWith(REF);
  });

  it("UUID secret-ref that resolves empty → ''", async () => {
    expect(await resolveApiKey(async () => "", REF)).toBe("");
  });

  it("UUID secret-ref whose provider throws → propagates (PAP-2394 hint fires downstream)", async () => {
    const resolve = async () => {
      throw new Error("kill switch");
    };
    await expect(resolveApiKey(resolve, REF)).rejects.toThrow("kill switch");
  });
});
