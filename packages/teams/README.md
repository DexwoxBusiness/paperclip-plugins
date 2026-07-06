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

### Bot credentials & secrets (T9 / PCLIP-26)

All credentials are **secret-refs only** — there is no field or flag that accepts a raw token/secret (unlike the Workflows URL, which has a deliberate opt-in plaintext escape hatch for migration). The secret fields are `botAppCredentialsRef` (the Entra client secret used for **outbound/proactive** bot auth) and `paperclipBoardApiKeyRef` (the board key for approve/reject REST calls). `botAppId` and `botTenantId` are non-secret identifiers and are entered in plaintext. Resolving a secret-ref requires the `secrets.read-ref` capability (declared in the manifest).

**How the value is handled.** Secret-refs are resolved via `ctx.secrets.resolve()` when the bot is built and the resolved value is held **in memory only** (in the Agents SDK adapter / a closure), exactly as the peer Slack plugin does. It is **never** written to logs, plugin state, `ctx.data` settings surfaces, metrics, or agent transcripts — a failed resolve logs only a generic message plus the error *class* (`resolveSecretRef` in `secret-resolve.ts`, unit-tested to prove no-leak even if a provider error embeds the secret).

**Rotation.** A rotated secret is picked up when the bot is next built — i.e. on plugin **re-init/restart**. Rotating a credential in your secret provider therefore needs a plugin restart to take effect (same behavior as the Slack plugin).

**Pin / migration (PAP-2394).** Plugin secret-refs are kill-switched upstream **after** the pinned build, so the plugin is pinned to `canary/v2026.509.0-canary.1` where `ctx.secrets.resolve()` still works. When company-scoped `plugin_config` lands upstream and we unpin:
1. Re-create each credential in the (new) company-scoped secret store and update `botAppCredentialsRef` / `paperclipBoardApiKeyRef` to the new reference ids.
2. Restart the plugin so the new refs are resolved.
3. Re-verify: send a proactive message / interactive approval and confirm outbound auth succeeds, and confirm no secret appears in logs (`resolveSecretRef` keeps this true, but re-check after any host secret-API change).

### Inbound authentication (AC #3)

Every inbound Teams request carries an Entra/Bot-Framework bearer token. The plugin validates it **before** dispatching to the SDK adapter — RS256 signature / JWKS / issuer / audience / 5-min skew via the Agents SDK's `authorizeJWT` (JWKS keys are cached and refreshed by the SDK's `jwks-rsa` client, well within the Bot Connector spec's 24h bound, plus a fresh fetch on key rotation — so we don't hand-roll a JWKS cache). On top of that the plugin adds a defense-in-depth layer in `bot-auth.ts`: a claims policy (audience must equal `botAppId`, issuer must be allowed, token unexpired within a 5-min skew) **and** a `serviceUrl` binding (`assertServiceUrl` — the token's `serviceurl` claim, when present, must match the activity's `serviceUrl`, per Bot Connector spec req #7, so a leaked token can't redirect the bot's replies). Unauthenticated or invalid calls are **rejected** (the request is not processed).

> **Host limitation.** The Paperclip plugin `onWebhook` returns `void` and cannot set the HTTP status or response body (the host returns 200 on success, 502 on a thrown error). Consequences: (a) auth rejection surfaces as **HTTP 502, not 403** — functionally still a rejection (correct status pending PCLIP-41); the rejection message is a **generic `"unauthorized"`** so no verification internals leak in the 502 body, while the detailed reason is logged internally; (b) message replies are sent via the **Bot Connector** (proactive/`updateActivity`), not the inline HTTP response. Because of (b), interactive approvals (T7) use `Action.Submit` (which posts a normal activity) rather than `Action.Execute` Universal Actions (which would need an inline invoke response the webhook can't return), and refresh the card via the Connector — see below. No host change is required.

## Public messaging endpoint (T8 / PCLIP-25)

The Bot Connector reaches the bot at a **public HTTPS URL**, which is the plugin webhook route:

```
https://<public-host>/api/plugins/dexwox.teams-chatos/webhooks/bot-messages
```

Front the Paperclip host with a reverse proxy (Caddy or nginx) that terminates public HTTPS
with a valid CA certificate (no self-signed) and forwards this one route to the Paperclip
process. Full VPS setup — Caddy/nginx blocks, DNS, certificate issuance, header/body
preservation, and verification via `paperclipai plugin target` + `curl` — is in
[`docs/vps-messaging-endpoint.md`](docs/vps-messaging-endpoint.md).

The exact URL is derived from `paperclipBaseUrl` + the static plugin id/endpoint key and is
shown on the plugin settings page (the `messaging-endpoint` data surface), which also flags a
missing / non-HTTPS / non-publicly-routable origin. Because the URL is static, it survives
Paperclip restarts with **no re-provisioning** — set it once in the Azure Bot **Messaging
endpoint** field.

## Interactive approvals (T7 / PCLIP-24)

When the bot is configured, approval cards can carry **Approve / Reject** buttons that act directly from Teams. This is **entirely plugin-side** (no Paperclip changes), mirroring `paperclip-plugin-discord`.

**How it works.** The buttons are `Action.Submit` (a click posts a bot activity, no invoke-response contract). On click the plugin calls the Paperclip approval REST API (`POST /api/approvals/{id}/approve|reject`) and refreshes the card in place to "Approved/Rejected by {name}" via the Bot Connector (`updateActivity`). A decision made elsewhere (Paperclip UI, another channel) arrives as the `approval.decided` event; since that event doesn't carry the outcome, the plugin reads it with `GET /api/approvals/{id}`. Idempotency/governance stay in Paperclip (a second click can't double-approve).

**Delivery is additive ("both").** The existing Workflows approval notification is unchanged; the interactive bot card is posted **in addition**, only when both `botAppId` and `botApprovalsConversationId` are set.

**To enable:**

1. Store your Paperclip **board API key** in the secret provider and put the secret-ref in **`paperclipBoardApiKeyRef`** (optional in `local_trusted` deployments where board access is implicit).
2. Set **`botApprovalsConversationId`** to the Teams conversation id where interactive approvals should be posted. **The bot must already be installed in that conversation** (it needs a stored conversation reference to post and update). Leave empty to keep approvals Workflows-only.
3. Ensure `paperclipBaseUrl` is set (the REST calls and the card's "View" link use it).

**Actor attribution.** The acting Teams user (`teams:{aadObjectId}`) is sent to the approval API and recorded in the decision note. The approval route currently attributes the formal audit actor to the board key; recording the Teams user as the *audit actor* would require a Paperclip route change and is tracked separately.

## @Paperclip commands (T10 / PCLIP-27)

Once the bot is installed in a channel or chat, **@mention it with a command** and it replies with an Adaptive Card. Parity with the Slack plugin's `/clip` commands:

- **`@Paperclip status`** — active agents + recent completions.
- **`@Paperclip agents`** — all agents with status badges.
- **`@Paperclip issues [open|done]`** — issues (default all) with `Action.OpenUrl` deep links.
- **`@Paperclip approve <id>`** — approve a pending approval via the board key.
- **`@Paperclip help`** — the command list. **Any unknown or empty command also shows help — the bot never stays silent.**

**How it works.** Commands arrive as message activities; the plugin strips the `<at>…</at>` mention, parses the first word, and reads data via `ctx.agents.list` / `ctx.issues.list` (company resolved via `ctx.companies.list`). Replies go back as cards through the Bot Connector. A `teams.commands.handled` metric (with the command name as a `command` **tag/dimension**, not a name suffix) is emitted per command — same shape as the Slack plugin's `slack.commands.handled` + `command_name` tag. Entirely plugin-side — no Paperclip changes.

**`approve` authorization (board-key parity).** There is **no per-sender allowlist** — any member of a channel where the bot is installed can approve, exactly like the Slack/Discord plugins; the board API key (`paperclipBoardApiKeyRef`) plus Paperclip's own governance is the security boundary. If approvals aren't reachable (no `paperclipBaseUrl`) the bot replies with a polite "approvals aren't enabled here" card; if the API rejects the id, a polite failure card. To restrict approvals to specific people, a per-user allowlist can be added later (tracked follow-up).

## HITL escalation with suggested replies (T11 / PCLIP-28)

A stuck agent calls the **`escalate_to_human`** agent tool (registered via the `agent.tools.register` capability) with a reason, its reasoning, confidence, conversation history, and a suggested reply. The plugin posts an interactive Adaptive Card to a configured Teams conversation with that context and two buttons: **Use suggested reply** and **Dismiss**. Modeled on the Slack plugin's escalation flow, adapted to Teams-accessible APIs.

**Reply-back is via `ctx.agents.invoke`.** Slack routes the reply into a live ACP agent *session* (`sessions.sendMessage`); Teams has no ACP session bridge, so clicking **Use suggested reply** wakes the escalating agent (its `agentId`, captured from the tool run context) with a new prompt `"Human reply to escalation: …"` via the `agents.invoke` capability. The card is then updated in place to its resolved state.

**Timeout.** A `check-escalation-timeouts` job (every minute) applies the configured default action to escalations older than `escalationTimeoutMinutes` (default 15): `escalationDefaultAction` is `defer` (leave it) or `dismiss`. The card updates to "Timed out"; `teams.escalations.timed_out{action}` is emitted.

**Config:** `escalationConversationId` (the bot must be installed there; empty = the tool no-ops with a clear result, never throws), `escalationTimeoutMinutes`, `escalationDefaultAction`.

**Grounded in the Microsoft docs:** the card is updated in place with `updateActivity` + the message id, and proactive posts/updates use `CloudAdapter.continueConversation` with a persisted conversation reference. Because Teams may omit `replyToId` when multiple cards share a channel, the resolve path falls back to the **stored** card activity id (captured at post time) rather than relying on `replyToId` alone. Metrics: `teams.escalations.created` / `.resolved{action}` / `.timed_out{action}`. Entirely plugin-side; the pure card/parse/timeout/store logic is unit-tested (SDK-decoupled).

## Backlog

PCLIP-18 … PCLIP-28. Pattern credit: [paperclip-plugin-slack](https://github.com/mvanhorn/paperclip-plugin-slack).
