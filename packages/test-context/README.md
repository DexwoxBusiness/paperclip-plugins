# @dexwox-labs/paperclip-plugin-test-context

Test Context Registry for [Paperclip](https://github.com/paperclipai/paperclip) — the structured, queryable home for everything an agent needs *before* generating tests.

- Per-project registry: environments (base URLs, health endpoints), seed-data manifest (typed facts, not dumps), external-service stub map, conventions **pointer** (docs stay in the repo), credential env-var names
- `get_test_context(projectId, env|prNumber)` agent tool — **secret values never enter prompts**; they resolve into the sandbox env at run time via secret-refs
- Ephemeral per-PR preview env registration webhook for CI
- Freshness job: env health, credential probes, seed staleness — the tautological-test defense

Backlog: PCLIP-10 … PCLIP-17.
