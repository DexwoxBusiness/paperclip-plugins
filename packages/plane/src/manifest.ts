import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Plane Sync",
  description:
    "Bidirectional Plane CE sync: webhook intake with HMAC verification, agent tools for work items (fetch ACs, create, comment, update state), status/comment mirroring, and a reconciliation backstop for unreliable self-hosted webhooks.",
  author: "Dexwox Innovations",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issue.comments.read",
    "issues.create",
    "issues.update",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "activity.log.write",
    "agent.tools.register",
    "jobs.schedule",
    "events.emit",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.plane,
      displayName: "Plane webhook intake",
      description:
        "Receives Plane CE webhook deliveries (Issue, Issue Comment). HMAC SHA-256 verified via X-Plane-Signature. PCLIP-1",
    },
  ],
  jobs: [
    {
      jobKey: JOB_KEYS.reconcile,
      displayName: "Plane reconciliation",
      description:
        "Diffs Plane state against the plugin ID-mapping and heals drift from missed/duplicated webhooks. PCLIP-5",
      // Base tick every minute; the worker self-throttles to the configured
      // reconcileIntervalMinutes (default 15), so the interval is adjustable at
      // runtime without a manifest change (a static cron can't read config).
      schedule: "* * * * *",
    },
    {
      jobKey: JOB_KEYS.outboundDrain,
      displayName: "Plane outbound retry drain",
      description:
        "Retries queued outbound mirror actions (status/comments) after a transient Plane outage, with backoff. PCLIP-4",
      schedule: "* * * * *",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.getWorkItem,
      displayName: "Get Plane work item",
      description:
        "Fetch a Plane work item (title, description incl. acceptance criteria, state, labels, comments) by readable identifier (e.g. PCLIP-12) or UUID.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Readable identifier (PROJ-123) or work item UUID" },
        },
        required: ["id"],
      },
    },
    {
      name: TOOL_NAMES.searchWorkItems,
      displayName: "Search Plane work items",
      description: "Search Plane work items by text, label, or state. Returns readable identifiers, paginated.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text query" },
          label: { type: "string", description: "Filter by label name" },
          state: { type: "string", description: "Filter by state name" },
          cursor: { type: "string", description: "Pagination cursor from a previous call" },
        },
      },
    },
    {
      name: TOOL_NAMES.createWorkItem,
      displayName: "Create Plane work item",
      description:
        "Create a work item in a mapped Plane project. Returns the new item's readable identifier and Plane URL. On failure returns a structured, actionable error (auth/not-found/rate-limit).",
      parametersSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Plane project UUID" },
          name: { type: "string", description: "Work item title" },
          descriptionHtml: { type: "string", description: "HTML description (may include acceptance criteria)" },
          priority: { type: "string", enum: ["urgent", "high", "medium", "low", "none"] },
        },
        required: ["projectId", "name"],
      },
    },
    {
      name: TOOL_NAMES.addComment,
      displayName: "Comment on Plane work item",
      description: "Add a comment to a Plane work item (attributed via Paperclip). Returns the comment's Plane URL.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Readable identifier or UUID" },
          commentHtml: { type: "string", description: "HTML comment body" },
        },
        required: ["id", "commentHtml"],
      },
    },
    {
      name: TOOL_NAMES.updateState,
      displayName: "Update Plane work item state",
      description: "Move a Plane work item to a new state (e.g. In Progress, Done). Returns the item's Plane URL.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Readable identifier or UUID" },
          state: { type: "string", description: "Target state name" },
        },
        required: ["id", "state"],
      },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      planeApiKeyRef: {
        type: "string",
        // AC #1: `format: "secret-ref"` renders the SecretBindingPicker in the
        // settings UI and stores only a reference — raw API tokens are never
        // accepted in config. Resolved to the real key at call time (PCLIP-7).
        format: "secret-ref",
        title: "Plane API Key (secret reference)",
        description:
          "Secret reference for the Plane service-account API key (X-API-Key). Never a raw token — the UI uses a secret picker. Requires Paperclip pinned to canary/v2026.509.0-canary.1 while upstream plugin secret-refs are kill-switched (PAP-2394). PCLIP-7",
        default: DEFAULT_CONFIG.planeApiKeyRef,
      },
      planeBaseUrl: {
        type: "string",
        title: "Plane Base URL",
        description: "Self-hosted Plane instance URL, no trailing slash (e.g. https://plane.example.com).",
        default: DEFAULT_CONFIG.planeBaseUrl,
      },
      planeWorkspaceSlug: {
        type: "string",
        title: "Workspace Slug",
        default: DEFAULT_CONFIG.planeWorkspaceSlug,
      },
      webhookSecret: {
        type: "string",
        title: "Webhook HMAC Secret",
        // Plaintext plugin config (not a secret-ref): the HMAC shared secret the
        // inbound webhook handler uses to verify X-Plane-Signature (constant-time)
        // in PCLIP-1. Required — an empty secret rejects every delivery.
        description: "Shared secret used to verify the X-Plane-Signature HMAC on inbound Plane webhooks (constant-time). PCLIP-1/PCLIP-7.",
        default: DEFAULT_CONFIG.webhookSecret,
      },
      defaultCompanyId: {
        type: "string",
        title: "Default Company ID",
        description:
          "REQUIRED. Paperclip company UUID that verified Plane events are emitted to (plugin event bus) until per-mapping company resolution lands with the sync rules (PCLIP-2). Missing config fails deliveries loudly (502, retryable) rather than dropping events.",
      },
      reconcileIntervalMinutes: {
        type: "number",
        title: "Reconciliation interval (minutes)",
        description: "Backstop sync frequency for Plane CE webhook reliability bugs (#4097, #6848). PCLIP-5",
        default: DEFAULT_CONFIG.reconcileIntervalMinutes,
      },
      enabledEvents: {
        type: "array",
        items: { type: "string", enum: ["issue", "issue_comment", "project", "cycle", "module"] },
        title: "Enabled webhook event types",
        description:
          "Allowlist of Plane event types to intake. Defaults to issue + issue_comment; other types are recorded 'ignored'. Note: PCLIP-2 sync rules act on ISSUE events only — issue_comment is intake-only until comment mirroring lands (a later item). Add project/cycle/module to opt in. An empty list falls back to the default rather than ignoring everything. PCLIP-1",
        default: [...DEFAULT_CONFIG.enabledEvents],
      },
      syncRules: {
        type: "array",
        title: "Sync rules (Plane project -> Paperclip project)",
        description:
          "Map each Plane project to a Paperclip company + project, with an optional label filter (a Plane label UUID; only issues carrying it sync). Editable here without a restart. Unmapped Plane projects are acknowledged and skipped. PCLIP-2",
        default: [...DEFAULT_CONFIG.syncRules],
        items: {
          type: "object",
          properties: {
            planeProjectId: { type: "string", title: "Plane project UUID" },
            companyId: { type: "string", title: "Paperclip company UUID" },
            paperclipProjectId: { type: "string", title: "Paperclip project UUID" },
            labelFilter: {
              type: "string",
              title: "Label filter (Plane label UUID, optional)",
              description: "Only issues carrying this Plane label sync. Name-based filtering arrives with the Plane client (PCLIP-3).",
            },
          },
          required: ["planeProjectId", "companyId", "paperclipProjectId"],
        },
      },
      outboundStateMap: {
        type: "object",
        title: "Outbound state map (Paperclip status -> Plane state)",
        description:
          "Mirror Paperclip issue status changes to the mapped Plane work item's state. Keys are Paperclip statuses, values are Plane state names (e.g. { \"in_progress\": \"In Progress\", \"done\": \"Done\" }). Statuses not listed are not mirrored. PCLIP-4",
        additionalProperties: { type: "string" },
        default: {},
      },
    },
    required: ["planeApiKeyRef", "planeBaseUrl", "planeWorkspaceSlug", "webhookSecret", "defaultCompanyId"],
  },
};

export default manifest;
