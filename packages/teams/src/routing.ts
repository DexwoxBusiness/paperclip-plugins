/**
 * Per-event-type channel routing (PCLIP-19, T2).
 *
 * Each notification maps to a channel ({@link channelFor}); this module resolves
 * that channel to the configured Workflows URL secret-ref, falling back to the
 * default when no per-type ref is set (AC #1, AC #2). Pure over a plain config
 * object so routing is unit-testable; the worker resolves the returned secret-ref
 * to the real URL at call time (fresh per event -> config changes need no restart,
 * AC #4). The URL is never logged (AC #3 capability-URL protection).
 */

import type { ChannelKind } from "./notifications.js";

/** The Workflows URL secret-refs, as stored in instance config. */
export interface TeamsUrlConfig {
  defaultWorkflowUrl?: string;
  approvalsWorkflowUrl?: string;
  errorsWorkflowUrl?: string;
  pipelineWorkflowUrl?: string;
  /** Dedicated channel for the daily digest (PCLIP-21); falls back to default. */
  digestWorkflowUrl?: string;
}

/**
 * The full instance config shape (manifest instanceConfigSchema), so the worker
 * reads `ctx.config.get()` with one typed cast instead of ad-hoc inline assertions
 * (Kody). Extends the URL config with the non-URL fields the worker needs.
 */
export interface TeamsInstanceConfig extends TeamsUrlConfig {
  /** Legacy escape hatch: honor raw plaintext Workflows URLs (default off). PCLIP-19 */
  allowPlaintextWorkflowUrl?: boolean;
  /** Public base URL for card deep links. PCLIP-20 */
  paperclipBaseUrl?: string;
  /** Company URL prefix override for deep links. PCLIP-20 */
  paperclipCompanyPrefix?: string;
  /** Daily digest on/off, hour (0–23), and IANA time zone for the hour. PCLIP-21 */
  enableDailyDigest?: boolean;
  digestHour?: number;
  digestTimezone?: string;
  /** Consecutive failures on one URL before it is flagged degraded (default 5). PCLIP-22 */
  degradedDeliveryThreshold?: number;
  /** v2 bot (Microsoft 365 Agents SDK). PCLIP-23 */
  botAppId?: string;
  botTenantId?: string;
  /** Extra allowed token issuers (comma-separated) beyond the Bot Framework default. PCLIP-23 */
  botAllowedIssuers?: string;
  /** Board API key secret-ref for interactive approval REST calls. PCLIP-24 */
  paperclipBoardApiKeyRef?: string;
  /** Conversation id the bot posts interactive approval cards to (empty = off). PCLIP-24 */
  botApprovalsConversationId?: string;
}

/** Which config field backs each channel. */
export const CHANNEL_CONFIG_KEY: Record<ChannelKind, keyof TeamsUrlConfig> = {
  approvals: "approvalsWorkflowUrl",
  errors: "errorsWorkflowUrl",
  pipeline: "pipelineWorkflowUrl",
  digest: "digestWorkflowUrl",
  default: "defaultWorkflowUrl",
};

/**
 * Resolve the Workflows secret-ref for a channel: the per-type ref when set
 * (non-empty after trim), otherwise the default ref (AC #1/#2). Returns "" when
 * nothing is configured, so the caller skips delivery rather than posting nowhere.
 */
export function resolveWorkflowRef(channel: ChannelKind, config: TeamsUrlConfig): string {
  // CHANNEL_CONFIG_KEY is Record<ChannelKind, ...> so every channel maps; the
  // `?? ""` is a belt-and-suspenders default should a caller pass an off-union
  // value (falls back to the default ref rather than misrouting or throwing).
  const perType = (config[CHANNEL_CONFIG_KEY[channel]] ?? "").trim();
  if (perType) return perType;
  return (config.defaultWorkflowUrl ?? "").trim();
}

/**
 * Whether a stored config value is already a raw http(s) Workflows URL rather than
 * a secret-ref. Instances configured before the secret-ref migration (T1) saved
 * the URL in plain text; a secret-ref is a UUID and never an http URL.
 */
export function isRawWorkflowUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref.trim());
}

/**
 * How the worker should treat a resolved config value (Kody, security):
 *  - "secret-ref": resolve via the secret provider (the default, secure path).
 *  - "raw-allowed": a plaintext URL AND the operator explicitly enabled the legacy
 *    escape hatch — deliver directly (T1 back-compat).
 *  - "raw-blocked": a plaintext URL WITHOUT the opt-in — do NOT deliver. Honoring a
 *    raw URL by default would defeat the `format: "secret-ref"` trust boundary and
 *    let a config-writer POST notification content to an arbitrary external host.
 *
 * Default is secure: raw URLs require `allowPlaintextWorkflowUrl`, so the trust
 * boundary holds unless an operator deliberately opts into legacy plaintext mode.
 */
export function classifyWorkflowRef(ref: string, allowPlaintext: boolean): "secret-ref" | "raw-allowed" | "raw-blocked" {
  if (!isRawWorkflowUrl(ref)) return "secret-ref";
  return allowPlaintext ? "raw-allowed" : "raw-blocked";
}
