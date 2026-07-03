import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Test Context Registry",
  description:
    "Per-project test-generation context: environments, seed manifests, stub maps, conventions pointers, and secret-ref credentials. Agents get everything they need in one tool call; secret values never enter prompts — they resolve into the sandbox env at run time. Includes ephemeral per-PR preview env registration and freshness checks.",
  author: "Dexwox Innovations",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "projects.read",
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
      endpointKey: WEBHOOK_KEYS.ephemeralEnvs,
      displayName: "Ephemeral env registration",
      description:
        "CI registers/deregisters {prNumber, baseUrl, expiresAt} when preview environments spin up/tear down. Token-authenticated; idempotent per PR. PCLIP-13",
    },
  ],
  jobs: [
    {
      jobKey: JOB_KEYS.freshness,
      displayName: "Context freshness checks",
      description:
        "Pings env health endpoints, probes test credentials, flags stale seed manifests; emits plugin events on failures. PCLIP-14",
      schedule: `*/${DEFAULT_CONFIG.freshnessIntervalMinutes} * * * *`,
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.getTestContext,
      displayName: "Get test context",
      description:
        "Fetch the test-generation context for a project: environment base URLs, seed-data manifest, external-service stub map, conventions doc pointer, and credential env-var NAMES (values are injected into the sandbox at run time — never returned here). Pass prNumber to resolve an ephemeral preview environment.",
      parametersSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Paperclip project ID" },
          env: { type: "string", description: "Environment name (e.g. staging). Ignored when prNumber is set." },
          prNumber: { type: "number", description: "PR number to resolve a registered ephemeral preview env" },
        },
        required: ["projectId"],
      },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      ciWebhookTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "CI webhook token (secret reference)",
        description:
          "Shared token CI must present when registering ephemeral envs. Requires the paperclip pin while upstream secret-refs are kill-switched (PAP-2394). PCLIP-13",
        default: DEFAULT_CONFIG.ciWebhookTokenRef,
      },
      seedStalenessDays: {
        type: "number",
        title: "Seed manifest staleness threshold (days)",
        default: DEFAULT_CONFIG.seedStalenessDays,
      },
      freshnessIntervalMinutes: {
        type: "number",
        title: "Freshness check interval (minutes)",
        default: DEFAULT_CONFIG.freshnessIntervalMinutes,
      },
    },
    required: ["ciWebhookTokenRef"],
  },
};

export default manifest;
