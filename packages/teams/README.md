# @dexwox/paperclip-plugin-teams

Microsoft Teams Chat OS for [Paperclip](https://github.com/paperclipai/paperclip).

**v1 (no bot):** Adaptive Card (v1.5) notifications via Power Automate Workflows webhook URLs — issue created/done, approvals, agent errors, budget thresholds — with per-type channel routing, deep links, daily digest, retries. Legacy O365 connector webhooks are retired (May 2026); Workflows-only.

**v2 (interactive):** Azure Bot on the **Microsoft 365 Agents SDK** (Bot Framework SDK is retired) — Universal Action approvals (`Action.Execute`, card updates in place, actor = `teams:{aadObjectId}`), `@Paperclip status|agents|issues|approve` commands, HITL escalation.

Backlog: PCLIP-18 … PCLIP-28. Pattern credit: [paperclip-plugin-slack](https://github.com/mvanhorn/paperclip-plugin-slack).
