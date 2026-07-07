# Contributing to dexwox-paperclip-plugins

Thanks for contributing. This repo is Dexwox Innovations' suite of [Paperclip](https://github.com/paperclipai/paperclip) plugins — a pnpm workspace publishing `@dexwox-labs/paperclip-plugin-*` packages to npm. This guide covers how we build here; the bar is **review-ready code on the first pass**.

## Prerequisites

- **Node.js** 20+ (LTS).
- **pnpm** `9.15.0` (pinned via `packageManager`; run `corepack enable` to get the right version automatically).
- A local [Paperclip](https://github.com/paperclipai/paperclip) runtime if you want to exercise the SDK-coupled wiring end to end. The pure, SDK-decoupled core is testable without it.

## Getting started

```bash
corepack enable
pnpm install            # install the whole workspace
pnpm -r typecheck       # type-check every package
pnpm -r test            # run all unit tests
```

## Repository layout

One package per plugin, under `packages/`:

| Package | Purpose |
|---|---|
| `packages/plane` | Bidirectional Plane CE sync (webhook intake, agent tools, mirror, reconciliation) |
| `packages/teams` | Teams Chat OS (Adaptive Card notifications, v2 bot, HITL escalation, ask surface) |
| `packages/kiwi-tcms` | Kiwi TCMS case authoring + CI results ingest |
| `packages/test-context` | Test Context Registry (envs, seeds, stubs, secret-ref creds) |

The backlog lives in the Plane project **PCLIP**; each work item carries Given/When/Then acceptance criteria.

## Branching & work items

- Branch names **embed the work-item id**: `pclip-<id>-<slug>` (e.g. `pclip-43-standup-ask-surface`). This is the PR ⇄ Plane traceability link and will be enforced by rulesets.
- One work item = one focused, reviewable PR. Split large stories into separate PRs (pure core, then wiring, is a good seam).

## The engineering standard (non-negotiable)

These rules exist because our reviewers (Kody/Kodus, Codex, and humans) are adversarial. The goal is code that survives review on the **first** pass. Before every commit:

1. **Failure-path analysis is part of writing the code, not a review response.** For every state mutation, enumerate each write, assume a crash between any two, and design re-entry explicitly. Prefer idempotency keys over retries. A retry around a non-idempotent multi-write is a bug.
2. **Design every config field's zero-state.** What happens when it's unset/empty/whitespace? Either the schema makes it required, or the code fails loudly with a clear message. Silently skipping work behind an HTTP 200 is data loss.
3. **No silent failure modes.** Deliberate no-ops (dedupe, ignore) must be observable. Anything else that drops work must throw so the host can retry.
4. **Verify impact against source — never assume.** Don't claim "no impact" without reading the actual host/platform contract you rely on, and grep the call sites of anything you change. State impacts as findings with file references.
5. **Adversarial self-review of the full diff before declaring done.** Apply the reviewer lenses: partial failure, concurrency/reentrancy, silent drops, timestamp/data consistency, AC-to-code traceability. If a reviewer could ask "what if this fails here?", answer it in code or a comment first.
6. **Fix the bug class, not the instance.** When any defect is found, sweep the codebase for the same pattern before committing the fix.
7. **Tests ship with the code.** Failure-path and regression tests go in the same commit as the change they cover. Happy-path-only suites don't meet the bar.

## Architecture conventions

- **Keep core logic SDK-decoupled behind dependency interfaces** so every acceptance criterion is unit-testable without the plugin runtime (see `packages/plane/src/webhook-handler.ts`, `packages/teams/src/ask.ts`). Tool/bot/job/state wiring is SDK-coupled and is verified by `tsc --noEmit` in CI.
- **Ground SDK usage in documentation.** For platform/SDK behavior (Paperclip host contracts, Microsoft Teams / Adaptive Cards), verify against the actual source or official docs and cite it in a comment — don't code from memory.
- **Design around known upstream quirks** rather than trusting a single delivery (e.g. Plane CE duplicate/missed webhooks → dedupe + reconciliation).

## Testing

```bash
pnpm -r typecheck       # must be clean
pnpm -r test            # must be clean
# or per package:
pnpm -F @dexwox-labs/paperclip-plugin-teams test
```

Both `typecheck` and `test` must pass before every commit. Cover the failure paths, not just the happy path.

## Changesets & releasing

Every user-facing change needs a changeset describing the intent and semver bump:

```bash
pnpm changeset          # pick the affected package(s) + bump type + summary
```

This replaces hand-written release notes and drives independent per-package versioning. See [`RELEASING.md`](./RELEASING.md) for the full release flow. (If `pnpm changeset` isn't wired yet, note the change in your PR description and a maintainer will add the changeset.)

## Pull requests

- Keep the diff scoped to one work item; reference the PCLIP id.
- Include tests and (once wired) a changeset.
- PRs are reviewed by **Kody (Kodus)** and **Codex** as well as humans. Expect adversarial review; address findings by first validating whether each is real, fixing the real ones, and answering false positives in code comments so they aren't re-raised.
- CI runs `typecheck` + `test` for the workspace; keep it green.

## Reporting bugs & security issues

- Functional bugs / feature requests: open an issue using the templates in `.github/ISSUE_TEMPLATE/`.
- **Security vulnerabilities: do NOT open a public issue.** See [`SECURITY.md`](./SECURITY.md).

By contributing you agree your contributions are licensed under the repository's [MIT license](./LICENSE) and that you follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
