# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It's how we version and release the `@dexwox-labs/paperclip-plugin-*` packages.

## Add a changeset with your change

```bash
pnpm changeset
```

Pick the affected package(s), the semver bump (patch / minor / major), and write a one-line summary aimed at users. This drops a markdown file in this folder; commit it with your PR.

- **One PR = one work item.** Add a changeset for any user-facing change (new tool, behavior change, bug fix). Internal-only refactors that don't affect published behavior don't need one.
- Each package versions **independently** — a changeset can bump `teams` without touching `plane`.
- `@dexwox-labs/paperclip-plugin-kiwi-tcms` and `-test-context` are currently in the `ignore` list (scaffold only); remove them from `.changeset/config.json` when they're ready to publish.

See [`RELEASING.md`](../RELEASING.md) for how a changeset becomes a published release.
