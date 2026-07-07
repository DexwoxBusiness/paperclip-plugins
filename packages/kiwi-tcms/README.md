# @dexwox-labs/paperclip-plugin-kiwi-tcms

[Kiwi TCMS](https://kiwitcms.org) integration for [Paperclip](https://github.com/paperclipai/paperclip).

- Agent tools over Kiwi's JSON-RPC API: `kiwi_create_test_case`, `kiwi_update_test_case`, `kiwi_add_case_to_plan`, `kiwi_search_cases`
- One-way CI ingest: JUnit XML / Playwright JSON → `TestRun.create` + `TestExecution.update`, idempotent by build ID
- Traceability model: **Plane item = requirement, repo test = automated verification, Kiwi case = human verification** — joined by the `plane:<id>` tag (`plane:unlinked` makes leakage visible)
- Nightly summary event for chat plugins

Kiwi has no dependable outbound webhooks — the integration surface is the RPC API, and the flow is inverted by design.

> **Status:** in development.
