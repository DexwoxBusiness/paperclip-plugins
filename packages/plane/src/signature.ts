import { createHmac, timingSafeEqual } from "node:crypto";

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
 * Returns false for a missing/empty/malformed header, a wrong-length digest,
 * or a digest mismatch — never throws on attacker-controlled input.
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
  if (!/^[0-9a-f]+$/.test(providedHex)) return false;

  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
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
