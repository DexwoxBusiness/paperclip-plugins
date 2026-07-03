import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES, WEBHOOK_KEYS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kiwi TCMS",
  description:
    "Kiwi TCMS integration: agent tools to author test cases over JSON-RPC, one-way CI results ingest (JUnit/Playwright → TestRun/TestExecutions), Plane-ID tagging for requirement traceability, nightly summary events.",
  author: "Dexwox Innovations",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "activity.log.write",
    "metrics.write",
    "agent.tools.register",
    "jobs.schedule",
    "events.emit",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.ciResults,
      displayName: "CI results ingest",
      description:
        "Accepts JUnit XML / Playwright JSON from CI; creates/updates TestRun + TestExecutions idempotently by build ID. PCLIP-31/33",
    },
  ],
  jobs: [
    {
      jobKey: JOB_KEYS.nightlySummary,
      displayName: "Nightly summary",
      description: "Emits cases created, runs executed, pass rate, plane:unlinked count. PCLIP-34",
      schedule: "0 1 * * *",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.createTestCase,
      displayName: "Create Kiwi test case",
      description:
        "Create a human-verification test case in Kiwi TCMS, tagged with the Plane work-item ID (plane:<id>).",
      parametersSchema: {
        type: "object",
        properties: {
          plan: { type: "string", description: "Kiwi test plan name or ID" },
          summary: { type: "string", description: "Case summary/title" },
          steps: { type: "string", description: "Steps for a human tester to verify" },
          planeId: { type: "string", description: "Plane readable identifier (e.g. PCLIP-12) for the join tag" },
        },
        required: ["plan", "summary", "steps", "planeId"],
      },
    },
    {
      name: TOOL_NAMES.updateTestCase,
      displayName: "Update Kiwi test case",
      description: "Update fields on an existing Kiwi test case. Only provided fields change.",
      parametersSchema: {
        type: "object",
        properties: {
          caseId: { type: "number", description: "Kiwi case ID" },
          summary: { type: "string" },
          steps: { type: "string" },
        },
        required: ["caseId"],
      },
    },
    {
      name: TOOL_NAMES.addCaseToPlan,
      displayName: "Add case to plan",
      description: "Attach an existing Kiwi test case to a test plan.",
      parametersSchema: {
        type: "object",
        properties: {
          caseId: { type: "number" },
          planId: { type: "number" },
        },
        required: ["caseId", "planId"],
      },
    },
    {
      name: TOOL_NAMES.searchCases,
      displayName: "Search Kiwi cases",
      description: "Search Kiwi test cases by tag (e.g. plane:<id>), plan, or text.",
      parametersSchema: {
        type: "object",
        properties: {
          tag: { type: "string" },
          plan: { type: "string" },
          query: { type: "string" },
        },
      },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      kiwiBaseUrl: {
        type: "string",
        title: "Kiwi TCMS base URL",
        description: "e.g. https://kiwi.example.com — JSON-RPC endpoint is <base>/json-rpc/. PCLIP-29",
        default: DEFAULT_CONFIG.kiwiBaseUrl,
      },
      kiwiCredentialsRef: {
        type: "string",
        format: "secret-ref",
        title: "Kiwi credentials (secret reference)",
        description:
          "Secret UUID for the Kiwi service account (username:password). Requires the paperclip pin while upstream secret-refs are kill-switched (PAP-2394). PCLIP-35",
        default: DEFAULT_CONFIG.kiwiCredentialsRef,
      },
      productMappings: {
        type: "string",
        title: "Repo → product/plan mappings (JSON)",
        description:
          'JSON object mapping repo slugs to Kiwi products/plans, e.g. {"dexwox/frontend": {"product": "FE", "plan": "Regression"}}. Unmapped repos are rejected. PCLIP-35',
        default: DEFAULT_CONFIG.productMappings,
      },
    },
    required: ["kiwiBaseUrl", "kiwiCredentialsRef"],
  },
};

export default manifest;
