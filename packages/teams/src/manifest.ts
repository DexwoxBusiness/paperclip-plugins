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
        "v2: receives Teams activities (message activities incl. Action.Submit card posts) via the reverse-proxied public HTTPS endpoint. The host returns a fixed 200/502 envelope and discards any worker return value, so this endpoint CANNOT emit an inline InvokeResponse body — Action.Execute/invoke flows are out of scope (T7 uses Action.Submit for this reason); replies go via the Bot Connector. PCLIP-25",
    },
  ],
  jobs: [
    {
      jobKey: JOB_KEYS.dailyDigest,
      displayName: "Daily digest",
      description: "Posts daily agent-activity stats (done/created/active/cost/top performer). PCLIP-21",
      // Ticks hourly; the worker self-throttles to the configured digestHour and
      // posts once per day, so the time is adjustable at runtime (a static cron
      // can't read config).
      schedule: "0 * * * *",
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
      digestWorkflowUrl: {
        type: "string",
        format: "secret-ref",
        title: "Digest channel Workflows URL (secret reference, optional)",
        description: "If set, the daily digest posts here instead of the default channel. Capability URL — stored masked, rotate on leak. PCLIP-21",
        default: DEFAULT_CONFIG.digestWorkflowUrl,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip base URL",
        description:
          "PUBLIC base URL of your Paperclip instance, used for the 'View in Paperclip' deep link on every card (e.g. https://paperclip.example.com — the reverse-proxied hostname, not localhost, so links work from Teams). PCLIP-20",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      paperclipCompanyPrefix: {
        type: "string",
        title: "Company URL prefix (optional)",
        description:
          "Your company's issue prefix (e.g. PCLIP) — the segment Paperclip uses in URLs like /PCLIP/issues/…. Optional: it is derived from a card's issue id (PCLIP-123) when available, but is REQUIRED for approval deep links that have no linked issue. PCLIP-20",
        default: DEFAULT_CONFIG.paperclipCompanyPrefix,
      },
      enableDailyDigest: {
        type: "boolean",
        title: "Enable daily digest",
        default: DEFAULT_CONFIG.enableDailyDigest,
      },
      digestHour: {
        type: "number",
        title: "Digest hour (0–23)",
        description: "Hour of day the daily digest posts. Interpreted in Digest time zone if set, else server-local. PCLIP-21",
        default: DEFAULT_CONFIG.digestHour,
      },
      digestTimezone: {
        type: "string",
        title: "Digest time zone (IANA, optional)",
        description: "IANA time zone for the digest hour, e.g. Asia/Kolkata for 09:00 IST. Empty = server-local time. PCLIP-21",
        default: DEFAULT_CONFIG.digestTimezone,
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
      degradedDeliveryThreshold: {
        type: "number",
        title: "Degraded-delivery threshold",
        description:
          "Consecutive failed deliveries (after retries) to a single Workflows URL before it is flagged as degraded in settings. A successful delivery clears it. Applied at plugin startup. PCLIP-22",
        default: DEFAULT_CONFIG.degradedDeliveryThreshold,
      },
      botAppId: {
        type: "string",
        title: "Bot Microsoft App Id (v2)",
        description:
          "The Entra app (client) id of the Azure Bot. Used as the REQUIRED token audience when validating inbound Teams requests, and as the bot identity for proactive messages. PCLIP-23",
        default: "",
      },
      botTenantId: {
        type: "string",
        title: "Bot Entra tenant id (v2, optional)",
        description: "Entra tenant id for a single-tenant bot. Leave empty for multi-tenant. PCLIP-23",
        default: "",
      },
      botAllowedIssuers: {
        type: "string",
        title: "Additional allowed token issuers (v2, optional)",
        description:
          "Comma-separated extra issuers to accept beyond the Bot Framework default (https://api.botframework.com), e.g. an Entra tenant issuer or a sovereign-cloud issuer. PCLIP-23",
        default: "",
      },
      botAppCredentialsRef: {
        type: "string",
        format: "secret-ref",
        title: "Bot credentials (secret reference) — v2",
        description:
          "Entra app client secret (or cert) for the Microsoft 365 Agents SDK bot, used to authenticate OUTBOUND (proactive) calls to Azure Bot Service. Requires the paperclip pin while upstream secret-refs are kill-switched (PAP-2394). PCLIP-23/26",
        default: "",
      },
      paperclipBoardApiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "Paperclip board API key (secret reference) — v2 approvals",
        description:
          "Board API key used to authenticate interactive Approve/Reject calls to the Paperclip approval REST API (POST /api/approvals/{id}/approve|reject). Optional in local_trusted deployments. PCLIP-24",
        default: DEFAULT_CONFIG.paperclipBoardApiKeyRef,
      },
      botApprovalsConversationId: {
        type: "string",
        title: "Interactive approvals conversation (v2, optional)",
        description:
          "Teams conversation id the bot posts interactive Approve/Reject approval cards to (the bot must already be installed in that conversation). Posted IN ADDITION to the Workflows approval notification. Empty = interactive approvals off. PCLIP-24",
        default: DEFAULT_CONFIG.botApprovalsConversationId,
      },
    },
    required: ["defaultWorkflowUrl", "paperclipBaseUrl"],
  },
};

export default manifest;
