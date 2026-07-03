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
      schedule: `*/${DEFAULT_CONFIG.reconcileIntervalMinutes} * * * *`,
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
      description: "Create a work item in a mapped Plane project.",
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
      description: "Add a comment to a Plane work item (attributed via Paperclip).",
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
      description: "Move a Plane work item to a new state (e.g. In Progress, Done).",
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
        format: "secret-ref",
        title: "Plane API Key (secret reference)",
        description:
          "Secret UUID for the Plane service-account API key. Requires Paperclip pinned to canary/v2026.509.0-canary.1 while upstream secret-refs are kill-switched (PAP-2394). PCLIP-7",
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
        description: "Shared secret used to verify X-Plane-Signature on inbound webhooks. PCLIP-1",
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
          "Allowlist of Plane event types to process. Defaults to issue + issue_comment (the PCLIP-1 sync surface); other types are recorded 'ignored'. Add project/cycle/module to opt in. An empty list falls back to the default rather than ignoring everything. PCLIP-1",
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
    },
    required: ["planeApiKeyRef", "planeBaseUrl", "planeWorkspaceSlug", "webhookSecret", "defaultCompanyId"],
  },
};

export default manifest;
