export const PLUGIN_ID = "dexwox.test-context";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  /** CI registers/deregisters ephemeral preview envs per PR. PCLIP-13 */
  ephemeralEnvs: "ephemeral-envs",
} as const;

export const JOB_KEYS = {
  /** Env health pings, cred login probes, seed staleness flags. PCLIP-14 */
  freshness: "freshness",
} as const;

export const TOOL_NAMES = {
  getTestContext: "get_test_context",
} as const;

export const DEFAULT_CONFIG = {
  ciWebhookTokenRef: "",
  seedStalenessDays: 14,
  freshnessIntervalMinutes: 30,
} as const;
