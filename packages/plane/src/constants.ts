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
  /** PCLIP-1 event allowlist default: the issue + issue_comment sync surface. */
  enabledEvents: ["issue", "issue_comment"] as readonly string[],
} as const;
