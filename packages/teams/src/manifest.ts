import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Microsoft Teams",
  description:
    "Teams Chat OS for Paperclip. v1: Adaptive Card notifications (issue created/done, approvals, agent errors, budget thresholds) via Power Automate Workflows webhooks, per-type channel routing, daily digest. v2: interactive bot on the Microsoft 365 Agents SDK with Universal Action approvals and @Paperclip commands.",
  author: "Dexwox Innovations",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.update",
    "agents.read",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
    "events.emit",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.botMessages,
      displayName: "Teams bot messaging endpoint",
      description:
        "v2: receives Teams activities (messages, Action.Execute invokes) via the reverse-proxied public HTTPS endpoint. PCLIP-25",
    },
  ],
  jobs: [
    {
      jobKey: JOB_KEYS.dailyDigest,
      displayName: "Daily digest",
      description: "Posts daily agent-activity stats (done/created/active/cost/top performer). PCLIP-21",
      schedule: `0 ${DEFAULT_CONFIG.digestHour} * * *`,
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      defaultWorkflowUrl: {
        type: "string",
        title: "Default Workflows webhook URL",
        description:
          "Power Automate Workflows webhook URL for the default channel (legacy O365 connector webhooks were retired May 2026). Capability URL — treat as sensitive, rotate on leak. PCLIP-18/19",
        default: DEFAULT_CONFIG.defaultWorkflowUrl,
      },
      approvalsWorkflowUrl: {
        type: "string",
        title: "Approvals channel Workflows URL (optional)",
        default: DEFAULT_CONFIG.approvalsWorkflowUrl,
      },
      errorsWorkflowUrl: {
        type: "string",
        title: "Errors channel Workflows URL (optional)",
        default: DEFAULT_CONFIG.errorsWorkflowUrl,
      },
      pipelineWorkflowUrl: {
        type: "string",
        title: "Pipeline channel Workflows URL (optional)",
        default: DEFAULT_CONFIG.pipelineWorkflowUrl,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip base URL",
        description: "Public base URL used for deep links on cards (not localhost). PCLIP-20",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      enableDailyDigest: {
        type: "boolean",
        title: "Enable daily digest",
        default: DEFAULT_CONFIG.enableDailyDigest,
      },
      botAppCredentialsRef: {
        type: "string",
        format: "secret-ref",
        title: "Bot credentials (secret reference) — v2",
        description:
          "Entra app credentials for the Microsoft 365 Agents SDK bot. Requires the paperclip pin while upstream secret-refs are kill-switched (PAP-2394). PCLIP-26",
        default: "",
      },
    },
    required: ["defaultWorkflowUrl", "paperclipBaseUrl"],
  },
};

export default manifest;
