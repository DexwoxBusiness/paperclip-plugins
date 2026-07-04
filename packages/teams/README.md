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

## Backlog

PCLIP-18 … PCLIP-28. Pattern credit: [paperclip-plugin-slack](https://github.com/mvanhorn/paperclip-plugin-slack).
