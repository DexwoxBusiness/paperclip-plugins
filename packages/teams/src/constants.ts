export const PLUGIN_ID = "dexwox.teams-chatos";
export const PLUGIN_VERSION = "0.5.0";

export const WEBHOOK_KEYS = {
  /** v2 bot messaging endpoint (Teams activities). PCLIP-25 */
  botMessages: "bot-messages",
} as const;

export const JOB_KEYS = {
  /** Daily digest of agent activity. PCLIP-21 */
  dailyDigest: "daily-digest",
  /** HITL escalation timeout sweep (applies the default action to expired escalations). PCLIP-28 */
  checkEscalationTimeouts: "check-escalation-timeouts",
} as const;

export const BUDGET_THRESHOLDS = [80, 90, 100] as const;

export const DEFAULT_CONFIG = {
  defaultWorkflowUrl: "",
  approvalsWorkflowUrl: "",
  errorsWorkflowUrl: "",
  pipelineWorkflowUrl: "",
  /** Empty by default (Codex): a localhost default would render broken card links; operators set the PUBLIC URL. PCLIP-20 */
  paperclipBaseUrl: "",
  /** Company URL prefix (issuePrefix, e.g. "PCLIP") for deep links; else derived from the readable issue id. PCLIP-20 */
  paperclipCompanyPrefix: "",
  /** Dedicated digest channel (secret-ref); falls back to the default channel. PCLIP-21 */
  digestWorkflowUrl: "",
  enableDailyDigest: false,
  digestHour: 9,
  /** IANA time zone for digestHour (e.g. "Asia/Kolkata"); empty = server-local. PCLIP-21 */
  digestTimezone: "",
  /** Security default: only secret-refs are honored; raw plaintext URLs are a deliberate legacy opt-in. PCLIP-19 */
  allowPlaintextWorkflowUrl: false,
  /** Consecutive delivery failures on one URL before it is marked degraded. PCLIP-22 (T5). */
  degradedDeliveryThreshold: 5,
  /** Board API key (secret-ref) for the interactive approval REST calls. Optional in local_trusted. PCLIP-24 (T7). */
  paperclipBoardApiKeyRef: "",
  /** Teams conversation id the bot posts INTERACTIVE approval cards to (the bot must be installed there). Empty = interactive approvals off (Workflows-only). PCLIP-24 (T7). */
  botApprovalsConversationId: "",
  /** Teams conversation id the bot posts HITL escalation cards to (bot must be installed there). Empty = escalation disabled. PCLIP-28 (T11). */
  escalationConversationId: "",
  /** Minutes an escalation waits for a human before the default action fires (default 15). PCLIP-28 */
  escalationTimeoutMinutes: 15,
  /** Default action when an escalation times out: "defer" (leave for later) or "dismiss". PCLIP-28 */
  escalationDefaultAction: "defer",
} as const;

/** Teams supports Adaptive Cards ~v1.5 for bot/webhook cards. Do not use newer schema features. (T1) */
export const ADAPTIVE_CARD_VERSION = "1.5";
