export const PLUGIN_ID = "dexwox.plane-sync";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  /** Plane CE webhook deliveries (Issue, Issue Comment). PCLIP-1 */
  plane: "plane",
} as const;

export const JOB_KEYS = {
  /** Reconciliation backstop for missed/duplicated webhooks. PCLIP-5 */
  reconcile: "reconcile",
} as const;

export const TOOL_NAMES = {
  getWorkItem: "plane_get_work_item",
  searchWorkItems: "plane_search_work_items",
  createWorkItem: "plane_create_work_item",
  addComment: "plane_add_comment",
  updateState: "plane_update_state",
} as const;

export const DEFAULT_CONFIG = {
  planeApiKeyRef: "",
  planeBaseUrl: "",
  planeWorkspaceSlug: "",
  webhookSecret: "",
  reconcileIntervalMinutes: 15,
  /** PCLIP-1 intake allowlist default. PCLIP-2 sync rules act on issue events; issue_comment is intake-only (comment mirroring is a later item). */
  enabledEvents: ["issue", "issue_comment"] as readonly string[],
  /** PCLIP-2 sync rules (Plane project -> Paperclip project + optional label filter). Empty until configured. */
  syncRules: [] as ReadonlyArray<Record<string, unknown>>,
} as const;

/** originKind stamped on Paperclip issues created by this plugin (PCLIP-2 idempotency). */
export const ISSUE_ORIGIN_KIND = `plugin:${PLUGIN_ID}` as const;
