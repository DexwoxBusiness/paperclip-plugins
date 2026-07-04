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
        // AC #3: a Workflows webhook URL is a CAPABILITY URL (bearer credential in
        // the URL itself). The settings UI masks only secret-ref fields, so it is
        // stored as a secret-ref — masked in the UI, resolved at call time, never
        // logged, and rotatable in the secret provider if leaked. Requires the
        // pinned Paperclip build while plugin secret-refs are kill-switched (PAP-2394).
        format: "secret-ref",
        title: "Default Workflows webhook URL (secret reference)",
        description:
          "Power Automate Workflows webhook URL for the default channel (legacy O365 connector webhooks were retired May 2026). Stored as a secret-ref (masked; rotate on leak). PCLIP-18/19",
        default: DEFAULT_CONFIG.defaultWorkflowUrl,
      },
      approvalsWorkflowUrl: {
        type: "string",
        format: "secret-ref",
        title: "Approvals channel Workflows URL (secret reference, optional)",
        description: "If set, approval cards post here instead of the default channel. Capability URL — stored masked, rotate on leak. PCLIP-19",
        default: DEFAULT_CONFIG.approvalsWorkflowUrl,
      },
      errorsWorkflowUrl: {
        type: "string",
        format: "secret-ref",
        title: "Errors channel Workflows URL (secret reference, optional)",
        description: "If set, agent-error cards post here instead of the default channel. Capability URL — stored masked, rotate on leak. PCLIP-19",
        default: DEFAULT_CONFIG.errorsWorkflowUrl,
      },
      pipelineWorkflowUrl: {
        type: "string",
        format: "secret-ref",
        title: "Pipeline channel Workflows URL (secret reference, optional)",
        description: "If set, issue created/done cards post here instead of the default channel. Capability URL — stored masked, rotate on leak. PCLIP-19",
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
      allowPlaintextWorkflowUrl: {
        type: "boolean",
        title: "Allow plaintext Workflows URLs (legacy)",
        // Security (Kody): OFF by default so only secret-refs are honored — a raw
        // plaintext URL would defeat the secret-ref trust boundary and could POST
        // notification content to an arbitrary host. Enable ONLY as a temporary
        // migration bridge for instances that still store a raw URL, then move the
        // URL into a secret-ref and turn this back off.
        description:
          "Legacy escape hatch. When OFF (recommended), Workflows URLs must be secret-refs. Enable only to keep an un-migrated plaintext URL working while you move it into a secret reference. PCLIP-19",
        default: DEFAULT_CONFIG.allowPlaintextWorkflowUrl,
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
