/**
 * Plane API-key resolution that tolerates BOTH a host secret-ref and a raw pasted key.
 *
 * The `planeApiKeyRef` config field is declared `format: "secret-ref"`, but plugin
 * secret-refs are kill-switched upstream (PAP-2394): `ctx.secrets.resolve` throws on
 * every current Paperclip build, so the operator must paste the raw Plane API key into
 * the field ("Or paste a raw value") until company-scoped plugin config lands. We tell
 * the two apart by shape — a host secret-ref is an opaque UUID; a Plane API key never
 * is — so a non-UUID value is used directly and a UUID goes through the provider.
 *
 * The resolved key is used ONLY as the `X-API-Key` request header (never cached or
 * logged), exactly as before; this helper just adds the raw-value branch.
 */

/** Shape of a Paperclip host secret-ref: an opaque UUID (8-4-4-4-12 hex). */
const SECRET_REF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a stored value is a host secret-REF (UUID) rather than a raw API key. */
export function isSecretRefShaped(value: string): boolean {
  return SECRET_REF_UUID.test(value.trim());
}

/**
 * Resolve the Plane API key from its configured value.
 *  - unset/empty      → "" (client stays unconfigured; callers surface "not configured")
 *  - raw key (non-UUID) → used as-is (PAP-2394 workaround)
 *  - secret-ref (UUID)  → resolved via the injected provider (throws propagate, so the
 *                         REST client's existing PAP-2394 hint still fires on the pinned path)
 */
export async function resolveApiKey(
  resolve: (ref: string) => Promise<string>,
  ref: string | undefined | null,
): Promise<string> {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return "";
  if (!isSecretRefShaped(trimmed)) return trimmed;
  return (await resolve(trimmed)) || "";
}
