export const PLUGIN_ID = "dexwox.kiwi-tcms";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  /** CI results ingest (JUnit XML / Playwright JSON). PCLIP-31 */
  ciResults: "ci-results",
} as const;

export const JOB_KEYS = {
  /** Nightly summary: cases created, runs executed, pass rate, unlinked count. PCLIP-34 */
  nightlySummary: "nightly-summary",
} as const;

export const TOOL_NAMES = {
  createTestCase: "kiwi_create_test_case",
  updateTestCase: "kiwi_update_test_case",
  addCaseToPlan: "kiwi_add_case_to_plan",
  searchCases: "kiwi_search_cases",
} as const;

/** Join-key tag: plane:<id>. Unlinked artifacts get plane:unlinked (PCLIP-32). */
export const PLANE_TAG_PREFIX = "plane:";
export const PLANE_TAG_UNLINKED = "plane:unlinked";

export const DEFAULT_CONFIG = {
  kiwiBaseUrl: "",
  kiwiCredentialsRef: "",
  /** repo slug -> { product, plan } mapping. PCLIP-35 */
  productMappings: "{}",
} as const;
