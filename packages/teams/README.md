# @dexwox-labs/paperclip-plugin-teams

Microsoft Teams "Chat OS" for [Paperclip](https://github.com/paperclipai/paperclip) — bring your agents' notifications, approvals, commands, and human-in-the-loop into Teams.

## Features

- **Adaptive Card notifications** (v1.5) via Power Automate **Workflows** webhook URLs — issue created/done, approvals, agent errors, budget thresholds — with per-event-type channel routing, deep links, a daily digest, and durable retries.
- **Interactive bot** on the **Microsoft 365 Agents SDK** — approvals (Approve/Reject from the card), `@Paperclip` commands, HITL escalation, and a generic "ask a person" surface.
- **HITL escalation** — a stuck agent posts a card with context and an editable suggested reply; a human's reply is routed back to the agent.
- **Ask surface** — agents can ask a specific person a question in a 1:1 chat and get the answer routed back, with no scrum/product vocabulary baked into the plugin.

> The Bot Framework SDK (`botbuilder`) is **not** used — support ended December 2025. A CI test fails the build if a `botbuilder`/`botframework-*` dependency is ever introduced.

## Installation

```bash
curl -X POST http://<your-paperclip-host>/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@dexwox-labs/paperclip-plugin-teams"}'
```

## Notifications (no bot required)

Notifications are delivered to Power Automate **Workflows** webhook URLs. (Legacy O365 connector webhooks were retired in May 2026 and are rejected.)

### Security — Workflows URLs are capability URLs

A Workflows webhook URL is a **capability URL**: the bearer secret is in the URL itself, so anyone who has it can post to your channel. The URL config fields — `defaultWorkflowUrl`, `approvalsWorkflowUrl`, `errorsWorkflowUrl`, `pipelineWorkflowUrl` — are therefore stored as **secret-refs** (`format: "secret-ref"`), which the Paperclip settings UI renders masked and stores in your secret provider.

**Rotate on leak.** If a URL is exposed: regenerate the flow's trigger URL in Power Automate, then update the secret behind the ref (`secrets.rotate`). The plugin resolves the ref **at call time and never caches or logs it**, so a rotated URL takes effect on the next event with no restart.

`allowPlaintextWorkflowUrl` is **off by default** — only secret-refs are honored. Enable it only as a temporary migration bridge for a raw URL, then move it into a secret-ref and turn it back off.

## Interactive bot (Microsoft 365 Agents SDK)

The bot is built on `@microsoft/agents-hosting` + `@microsoft/agents-hosting-extensions-teams`.

### Provisioning (one-time, operator task)

The plugin never creates Azure resources or handles credentials in plaintext — do these steps in the Azure/Entra portals yourself.

1. **Register an Entra application** (Entra admin center → App registrations → New registration). Copy the **Application (client) ID** → config `botAppId`, and the **Directory (tenant) ID** → `botTenantId` (single-tenant only). Under **Certificates & secrets**, create a client secret, store it in your secret provider, and put the **secret-ref** in `botAppCredentialsRef`.
2. **Create an Azure Bot resource** using that Entra app as its Microsoft App ID. Set its **Messaging endpoint** to the plugin's public webhook URL (see below), and enable the **Microsoft Teams** channel.
3. **Upload a Teams app manifest** whose `bot.botId` is your `botAppId`, with the `team`/`groupChat` scopes, and install it in your tenant. Installing it in a team lets the bot receive messages and post proactively there.
4. **Configure the plugin:** set `botAppId`, `botTenantId` (if single-tenant), `botAppCredentialsRef`, and optionally `botAllowedIssuers` (extra token issuers beyond the Bot Framework default).

### Public messaging endpoint

The Bot Connector reaches the bot at a public HTTPS URL, which is the plugin's webhook route:

```
https://<public-host>/api/plugins/dexwox.teams-chatos/webhooks/bot-messages
```

Front your Paperclip host with a reverse proxy (Caddy or nginx) that terminates public HTTPS with a valid CA certificate and forwards this one route to the Paperclip process. Full setup — proxy config, DNS, certificates, and verification — is in [`docs/vps-messaging-endpoint.md`](docs/vps-messaging-endpoint.md). The URL is static, so it survives Paperclip restarts with no re-provisioning — set it once in the Azure Bot **Messaging endpoint** field.

### Credentials & inbound authentication

All bot credentials are **secret-refs only** (no field accepts a raw token): `botAppCredentialsRef` (Entra client secret for outbound/proactive auth) and `paperclipBoardApiKeyRef` (board key for approve/reject calls). `botAppId`/`botTenantId` are non-secret identifiers. Secret-refs are resolved via `ctx.secrets.resolve()`, held in memory only, and never written to logs, state, metrics, or transcripts. A rotated secret is picked up on the next plugin re-init/restart.

Every inbound Teams request is authenticated **before** dispatch — RS256 signature / JWKS / issuer / audience / clock-skew via the SDK's `authorizeJWT`, plus a defense-in-depth claims policy (audience must equal `botAppId`, issuer must be allowed) and a `serviceUrl` binding so a leaked token can't redirect replies. Invalid requests are rejected.

## Approvals

When the bot is configured, approval cards carry **Approve / Reject** buttons that act directly from Teams (entirely plugin-side). A click calls the Paperclip approval REST API and refreshes the card in place; a decision made elsewhere refreshes via the `approval.decided` event. Idempotency and governance stay in Paperclip.

Enable by setting `paperclipBoardApiKeyRef`, `botApprovalsConversationId` (the bot must already be installed there), and `paperclipBaseUrl`. Delivery is additive — the interactive card is posted in addition to the Workflows notification.

## `@Paperclip` commands

@mention the bot in a channel or chat:

- `@Paperclip status` — active agents + recent completions
- `@Paperclip agents` — all agents with status
- `@Paperclip issues [open|done]` — issues with deep links
- `@Paperclip approve <id>` — approve a pending approval
- `@Paperclip help` — the command list (unknown/empty input also shows help — the bot never stays silent)

Any member of a channel where the bot is installed can run these; the board API key plus Paperclip's own governance is the security boundary.

## HITL escalation

A stuck agent calls the `escalate_to_human` tool with a reason, its reasoning, confidence, conversation history, and a suggested reply. The plugin posts a card with that context, an **editable reply field prefilled with the suggestion**, and **Send reply** / **Dismiss** buttons. Clicking **Send reply** wakes the escalating agent via `ctx.agents.invoke` with the human's (possibly edited) text; the card updates in place.

A background job applies a default action (`defer` or `dismiss`) to escalations older than `escalationTimeoutMinutes`.

**Config:** `escalationConversationId` (the bot must be installed there; empty = the tool no-ops cleanly, never throws), `escalationTimeoutMinutes` (default 15), `escalationDefaultAction`.

## Ask a person

A generic connectivity primitive so an agent can ask a specific person a question and get the answer routed back. Tools (all via `agent.tools.register`):

- `ask_person(personRef, prompt, fields?, correlationId?)` — posts a card (with editable inputs) to the person's 1:1 chat and returns `{ requestId }`. No-ops cleanly (`person not reachable / needs install`) if the person can't be proactively reached.
- `list_open_asks(correlationPrefix?)` — the agent's own still-open asks, so it decides whether to re-ask (the plugin never nudges on its own).
- `cancel_ask(requestId)` — withdraw an ask.

The person's reply is routed back via `ctx.agents.invoke`; a double-submit routes exactly once. Grounded in Microsoft's proactive-messaging docs: 1:1 proactive messaging requires the app installed in personal scope (else a `403`), so `personRef` is a stored 1:1 conversation key (Teams doesn't support proactive messaging by email/UPN).

## Metrics

`teams.commands.handled{command}`, `teams.escalations.{created,resolved,timed_out,reopened,reopen_failed}`, `teams.asks.{created,answered,cancelled,route_failed}`.

## Compatibility

Built against [`@paperclipai/plugin-sdk`](https://www.npmjs.com/package/@paperclipai/plugin-sdk). Requires a Paperclip host with company-scoped plugin config and secret-ref support (Paperclip v2026.525.0 or later).

## Credits

Interaction patterns inspired by the community Slack plugin, [paperclip-plugin-slack](https://github.com/mvanhorn/paperclip-plugin-slack).

## License

MIT
