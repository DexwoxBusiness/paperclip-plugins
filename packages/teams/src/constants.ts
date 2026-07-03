export const PLUGIN_ID = "dexwox.teams-chatos";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  /** v2 bot messaging endpoint (Teams activities). PCLIP-25 */
  botMessages: "bot-messages",
} as const;

export const JOB_KEYS = {
  /** Daily digest of agent activity. PCLIP-21 */
  dailyDigest: "daily-digest",
} as const;

export const BUDGET_THRESHOLDS = [80, 90, 100] as const;

export const DEFAULT_CONFIG = {
  defaultWorkflowUrl: "",
  approvalsWorkflowUrl: "",
  errorsWorkflowUrl: "",
  pipelineWorkflowUrl: "",
  paperclipBaseUrl: "http://localhost:3100",
  enableDailyDigest: false,
  digestHour: 9,
} as const;

/** Teams supports Adaptive Cards ~v1.5 for bot/webhook cards. Do not use newer schema features. (T1) */
export const ADAPTIVE_CARD_VERSION = "1.5";
