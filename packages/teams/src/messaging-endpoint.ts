/**
 * Public messaging endpoint URL for the v2 Teams bot (PCLIP-25 / T8).
 *
 * Teams' Bot Connector must reach the bot at a PUBLIC HTTPS URL. In Paperclip that URL is
 * the plugin webhook route — `POST /api/plugins/{pluginId}/webhooks/{botMessages}` — fronted
 * by the VPS reverse proxy (see docs/vps-messaging-endpoint.md). This module derives that
 * exact URL from the configured public Paperclip origin so:
 *   - operators can paste it into the Azure Bot "Messaging endpoint" field, and
 *   - the settings surface can display it (and flag a mis-set origin) via ctx.data.
 *
 * It is DISPLAY / VALIDATION only — the plugin never calls its own endpoint. The URL is a
 * pure function of the pluginId + endpointKey + public origin, which is exactly why the
 * endpoint is STABLE across restarts (AC #3/#5): nothing is provisioned per run.
 *
 * Grounded in the official Bot Connector auth spec: the endpoint must be HTTPS with a
 * publicly trusted certificate (no self-signed), and the Bot Connector must be able to
 * route to it. We therefore reject non-HTTPS and non-publicly-routable origins here to
 * catch misconfiguration early — parity with the PCLIP-20 loopback rejection for deep links.
 *
 * SDK-decoupled and pure over its inputs, so the accept/reject matrix is fully unit-tested.
 */

/** Fixed host route prefix for plugin webhooks (verified against server/src/routes/plugins.ts). */
export const PLUGIN_WEBHOOK_PATH_PREFIX = "/api/plugins";

export type MessagingEndpointResult =
  | { ok: true; url: string; path: string }
  | { ok: false; reason: string };

/**
 * The host-relative path the host routes to `onWebhook` for a given plugin + endpoint key:
 * `/api/plugins/{pluginId}/webhooks/{endpointKey}`. Segments are percent-encoded defensively;
 * for the constrained ids in use (`[a-z0-9._-]`) this is a no-op, and the host (Express)
 * decodes params back to the registered id, so an encoded URL still matches the route.
 */
export function messagingWebhookPath(pluginId: string, endpointKey: string): string {
  return `${PLUGIN_WEBHOOK_PATH_PREFIX}/${encodeURIComponent(pluginId)}/webhooks/${encodeURIComponent(endpointKey)}`;
}

/**
 * True when `hostname` is a loopback / private / link-local / non-routable name that the
 * Bot Connector cannot reach from the public internet. Accepts a URL hostname (IPv6 may
 * arrive bracketed, e.g. "[::1]"). Conservative: unknown/other hosts are treated as routable.
 */
export function isNonRoutableHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  // Loopback / mDNS / internal TLDs.
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  // Unspecified / loopback IPv6.
  if (h === "::" || h === "::1") return true;
  // IPv4 special ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if ([a, b, Number(m[3]), Number(m[4])].some((o) => o > 255)) return true; // malformed → non-routable
    if (a === 0 || a === 127) return true; // "this host" / loopback
    if (a === 10) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  // Unique-local IPv6 (fc00::/7).
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return false;
}

/**
 * Build + validate the public messaging endpoint URL from the public Paperclip origin.
 * Returns `{ ok:false, reason }` for an empty/invalid/non-HTTPS/non-routable base so callers
 * (settings surface, docs) can show a precise, actionable message. Never throws.
 */
export function buildMessagingEndpointUrl(
  publicBaseUrl: string,
  pluginId: string,
  endpointKey: string,
): MessagingEndpointResult {
  const path = messagingWebhookPath(pluginId, endpointKey);
  const trimmed = (publicBaseUrl ?? "").trim();
  if (!trimmed) {
    return { ok: false, reason: "no public Paperclip base URL configured (set paperclipBaseUrl to the public HTTPS origin)" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "paperclipBaseUrl is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "messaging endpoint must be HTTPS — Teams rejects non-TLS and self-signed endpoints" };
  }
  if (isNonRoutableHost(parsed.hostname)) {
    return { ok: false, reason: "paperclipBaseUrl host is not publicly routable; the Bot Connector cannot reach it" };
  }
  // Preserve any base-path prefix (Paperclip may be mounted under a sub-path) and the port,
  // then append the fixed webhook path. Trailing slashes on the base path are collapsed so we
  // never emit a double slash.
  const origin = parsed.origin; // scheme://host[:port]
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${origin}${basePath}${path}`, path };
}

/** Settings-surface view of the messaging endpoint (safe to serialize; no secrets). */
export interface MessagingEndpointInfo {
  pluginId: string;
  endpointKey: string;
  /** A public base URL is configured (non-empty), even if it later fails validation. */
  configured: boolean;
  /** The base URL is a valid, public HTTPS origin and `url` is set. */
  ok: boolean;
  /** The full public messaging endpoint URL to paste into Azure, when `ok`. */
  url?: string;
  /** The host-relative route, always available (independent of the configured origin). */
  path: string;
  /** Actionable reason when `ok` is false. */
  reason?: string;
}

/**
 * Describe the messaging endpoint for the settings UI: the exact URL when the public origin
 * is valid, or a precise reason when it is missing/invalid. The host-relative `path` is
 * always returned so operators see the route even before setting the origin.
 */
export function describeMessagingEndpoint(
  publicBaseUrl: string,
  pluginId: string,
  endpointKey: string,
): MessagingEndpointInfo {
  const path = messagingWebhookPath(pluginId, endpointKey);
  const trimmed = (publicBaseUrl ?? "").trim();
  const built = buildMessagingEndpointUrl(trimmed, pluginId, endpointKey);
  if (built.ok) {
    return { pluginId, endpointKey, configured: true, ok: true, url: built.url, path };
  }
  return { pluginId, endpointKey, configured: trimmed.length > 0, ok: false, path, reason: built.reason };
}
