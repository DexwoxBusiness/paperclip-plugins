<!--
Branch name should embed the work-item id: pclip-<id>-<slug>
Keep the diff scoped to a single PCLIP work item.
-->

## What & why

<!-- What does this change do, and which PCLIP work item does it close? -->

Closes: PCLIP-<id>

## How it works

<!-- Brief design notes. For SDK/platform behavior, cite the contract/doc you verified against. -->

## Engineering-standard checklist

- [ ] **Failure paths designed in** — each state mutation's partial-failure / re-entry behavior is handled (idempotency over retries).
- [ ] **Config zero-states** — unset/empty/whitespace inputs are required by schema or fail loudly (no silent no-op).
- [ ] **No silent drops** — deliberate no-ops are observable; anything else that drops work throws.
- [ ] **Impact verified against source** — contracts I rely on were checked in the actual host/SDK source or official docs (cited), and call sites of anything I changed were grepped.
- [ ] **Adversarial self-review of the full diff** done (partial failure, concurrency/reentrancy, silent drops, data/timestamp consistency, AC→code traceability).
- [ ] **Bug-class swept** — if this fixes a defect, the same pattern was searched for elsewhere.
- [ ] **Tests ship with the change** — failure-path + regression tests included; `pnpm -r typecheck && pnpm -r test` clean.
- [ ] **Changeset added** (`pnpm changeset`) for any user-facing change, or N/A with a reason.

## Acceptance criteria

<!-- Map each Given/When/Then AC to where it's implemented + tested. -->

## Notes for reviewers

<!-- Anything Kody/Codex/humans should look at closely; known false-positive rebuttals. -->
