import { describe, expect, it } from "vitest";
import {
  computePlaneSignature,
  extractPlaneSignature,
  verifyPlaneSignature,
} from "../src/signature.js";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ event: "issue", action: "created", data: { id: "abc" } });

describe("verifyPlaneSignature (PCLIP-1)", () => {
  it("accepts a payload signed with the correct secret", () => {
    const sig = computePlaneSignature(BODY, SECRET);
    expect(verifyPlaneSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("accepts an uppercase hex signature (normalizes case)", () => {
    const sig = computePlaneSignature(BODY, SECRET).toUpperCase();
    expect(verifyPlaneSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(verifyPlaneSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it("rejects an empty signature header", () => {
    expect(verifyPlaneSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a signature computed with a different secret", () => {
    const sig = computePlaneSignature(BODY, "wrong-secret");
    expect(verifyPlaneSignature(BODY, sig, SECRET)).toBe(false);
  });

  it("rejects a signature for a tampered body", () => {
    const sig = computePlaneSignature(BODY, SECRET);
    expect(verifyPlaneSignature(BODY + "x", sig, SECRET)).toBe(false);
  });

  it("rejects malformed (non-hex) signatures without throwing", () => {
    expect(verifyPlaneSignature(BODY, "not-hex!!", SECRET)).toBe(false);
    expect(verifyPlaneSignature(BODY, "deadbeef", SECRET)).toBe(false); // wrong length
  });

  it("rejects when no secret is configured", () => {
    const sig = computePlaneSignature(BODY, SECRET);
    expect(verifyPlaneSignature(BODY, sig, "")).toBe(false);
  });

  it("takes the first value of an array header", () => {
    const sig = computePlaneSignature(BODY, SECRET);
    expect(verifyPlaneSignature(BODY, [sig, "junk"], SECRET)).toBe(true);
  });
});

describe("extractPlaneSignature", () => {
  it("finds the header case-insensitively", () => {
    expect(extractPlaneSignature({ "X-Plane-Signature": "abc" })).toBe("abc");
    expect(extractPlaneSignature({ "x-plane-signature": "abc" })).toBe("abc");
    expect(extractPlaneSignature({ "X-PLANE-SIGNATURE": "abc" })).toBe("abc");
  });

  it("returns undefined when absent", () => {
    expect(extractPlaneSignature({ "content-type": "application/json" })).toBeUndefined();
  });
});
