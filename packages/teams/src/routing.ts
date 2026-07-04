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
}

/** Which config field backs each channel. */
export const CHANNEL_CONFIG_KEY: Record<ChannelKind, keyof TeamsUrlConfig> = {
  approvals: "approvalsWorkflowUrl",
  errors: "errorsWorkflowUrl",
  pipeline: "pipelineWorkflowUrl",
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
 * the URL in plain text; the worker delivers those directly for back-compat, while
 * new configs store a secret-ref (a UUID, never an http URL) resolved at call time.
 */
export function isRawWorkflowUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref.trim());
}
