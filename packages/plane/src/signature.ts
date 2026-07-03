import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Plane webhook signature verification (PCLIP-1).
 *
 * Plane signs the raw request body with HMAC SHA-256 using the webhook's
 * secret and sends the hex digest in the `X-Plane-Signature` header.
 * Comparison MUST be constant-time (AC: timing-safe equality).
 */

export const PLANE_SIGNATURE_HEADER = "x-plane-signature";

export function computePlaneSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Constant-time verification of an inbound Plane webhook signature.
 *
 * Returns false for a missing/empty header or any digest mismatch — never
 * throws on attacker-controlled input, and (AC #5) the comparison path is
 * constant-time end to end: there is NO length short-circuit and no
 * variable-time hex validation that could leak the expected digest's shape.
 */
export function verifyPlaneSignature(
  rawBody: string,
  signatureHeader: string | string[] | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header || typeof header !== "string") return false;

  const expectedHex = computePlaneSignature(rawBody, secret);
  const providedHex = header.trim().toLowerCase();
  return constantTimeEqual(expectedHex, providedHex);
}

/**
 * Constant-time string equality with NO length short-circuit (AC #5).
 *
 * `timingSafeEqual` throws on unequal-length buffers, so comparing the raw hex
 * digests directly forces a length check that branches BEFORE the constant-time
 * compare — a (theoretical) timing side channel on the expected digest, and the
 * exact concern raised in review. Instead we use the double-HMAC construction:
 * both inputs are reduced to fixed 32-byte MACs under a fresh per-call random
 * key, then compared with `timingSafeEqual`. The MAC outputs are always
 * equal-length regardless of input length, so neither the length nor the
 * content of `expected` (the secret-derived signature) can leak through timing.
 * Correctness: a === b iff HMAC_k(a) === HMAC_k(b) by collision resistance.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const key = randomBytes(32);
  const macA = createHmac("sha256", key).update(a, "utf8").digest();
  const macB = createHmac("sha256", key).update(b, "utf8").digest();
  return timingSafeEqual(macA, macB);
}

/** Extract the Plane signature header from a headers record (case-insensitive). */
export function extractPlaneSignature(
  headers: Record<string, string | string[]>,
): string | string[] | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === PLANE_SIGNATURE_HEADER) return value;
  }
  return undefined;
}
