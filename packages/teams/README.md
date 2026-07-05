# @dexwox/paperclip-plugin-teams

Microsoft Teams Chat OS for [Paperclip](https://github.com/paperclipai/paperclip).

**v1 (no bot):** Adaptive Card (v1.5) notifications via Power Automate Workflows webhook URLs — issue created/done, approvals, agent errors, budget thresholds — with per-type channel routing, deep links, daily digest, retries. Legacy O365 connector webhooks are retired (May 2026); Workflows-only.

**v2 (interactive):** Azure Bot on the **Microsoft 365 Agents SDK** (Bot Framework SDK is retired) — Universal Action approvals (`Action.Execute`, card updates in place, actor = `teams:{aadObjectId}`), `@Paperclip status|agents|issues|approve` commands, HITL escalation.

## Security — Workflows capability URLs (rotation on leak)

A Power Automate Workflows webhook URL is a **capability URL**: the bearer secret is in the URL itself, so anyone who obtains it can post to your channel. The four URL fields (`defaultWorkflowUrl`, `approvalsWorkflowUrl`, `errorsWorkflowUrl`, `pipelineWorkflowUrl`) are therefore stored as **secret-refs** (`format: "secret-ref"`), which the Paperclip settings UI renders **masked** and stores in the secret provider (PCLIP-19, AC #3).

**Rotate on leak.** If a URL is exposed, rotate it:

1. In Power Automate, regenerate the flow's trigger URL (or rebuild the "When a Teams webhook request is received" trigger).
2. Update the secret behind the ref via the Paperclip secret provider's rotate operation (`secrets.rotate`).

The plugin resolves the secret-ref **at call time and never caches or logs it**, so a rotated URL takes effect on the **next event with no plugin restart**. Rotation is an operator action — the platform has no automated leak detection for outbound capability URLs, and there is no separate "needs-rotation" flag; the field descriptions surface this guidance in the settings UI.

**Plaintext escape hatch.** `allowPlaintextWorkflowUrl` is **off by default**: only secret-refs are honored. Enable it only as a temporary bridge for an instance that still stores a raw URL, then move the URL into a secret-ref and turn it back off. Legacy O365 connector URLs (`*.webhook.office.com`, retired May 2026) are rejected outright.

## v2 bot provisioning (Microsoft 365 Agents SDK) — PCLIP-23

The interactive bot is built on the **Microsoft 365 Agents SDK** (`@microsoft/agents-hosting` + `@microsoft/agents-hosting-extensions-teams`). The Bot Framework SDK (`botbuilder`) is **retired** (support ended Dec 2025) and MUST NOT be used — a CI test (`tests/no-botbuilder.test.ts`) fails the build if a `botbuilder`/`botframework-*` dependency is ever introduced (AC #2).

Provisioning is a one-time operator task. **The plugin never creates Azure resources or handles credentials in plaintext — do these steps in the Azure/Entra portals yourself.**

### 1. Register the Entra application

1. Entra admin center → **App registrations → New registration**. Name it (e.g. "Paperclip Teams Bot"). Choose single- or multi-tenant.
2. Copy the **Application (client) ID** → plugin config **`botAppId`**. Copy the **Directory (tenant) ID** → **`botTenantId`** (single-tenant only).
3. **Certificates & secrets → New client secret.** Store the secret value in your Paperclip secret provider and put the **secret-ref** in **`botAppCredentialsRef`** (used only for OUTBOUND/proactive calls; never entered in plaintext).

### 2. Create the Azure Bot resource

1. Azure Portal → **Create a resource → Azure Bot.** Use the Entra app above as the bot's **Microsoft App ID** (type: single/multi-tenant to match step 1).
2. **Configuration → Messaging endpoint:** set it to the plugin's webhook URL
   `https://<your-paperclip-host>/api/plugins/dexwox.teams-chatos/webhooks/bot-messages`.
3. **Channels → Microsoft Teams:** enable the Teams channel.

### 3. Upload the Teams app manifest

Package a Teams app manifest whose `bot.botId` is the `botAppId`, with the `team`/`groupChat` scopes, and side-load or publish it to your tenant (Teams admin center → Manage apps, or "Upload a custom app"). Installing it in a team lets the bot receive messages and post proactively to that team's channels (AC #1).

### 4. Configure the plugin

Set `botAppId`, `botTenantId` (if single-tenant), `botAppCredentialsRef`, and optionally `botAllowedIssuers` (comma-separated extra issuers beyond the Bot Framework default `https://api.botframework.com`, e.g. an Entra tenant issuer or a sovereign-cloud issuer).

### Inbound authentication (AC #3)

Every inbound Teams request carries an Entra/Bot-Framework bearer token. The plugin validates it **before** dispatching to the SDK adapter — signature/JWKS/issuer/audience via the Agents SDK, plus a defense-in-depth claims policy (`bot-auth.ts`: audience must equal `botAppId`, issuer must be allowed, token unexpired within a 5-min skew). Unauthenticated or invalid calls are **rejected** (the request is not processed).

> **Host limitation.** The Paperclip plugin `onWebhook` returns `void` and cannot set the HTTP status or response body (the host returns 200 on success, 502 on a thrown error). Consequences: (a) auth rejection surfaces as **HTTP 502, not 401** — functionally still a rejection; (b) message replies are sent via the **Bot Connector** (proactive), not the inline HTTP response; (c) `invoke` activities that require an **inline** response body — notably `Action.Execute` Universal Actions for in-place card updates (T7/PCLIP-24) — are **blocked** until the host exposes an HTTP-response-capable webhook. This is tracked as a host dependency on PCLIP-23/24.

## Backlog

PCLIP-18 … PCLIP-28. Pattern credit: [paperclip-plugin-slack](https://github.com/mvanhorn/paperclip-plugin-slack).
