# Releasing

We publish the `@dexwox-labs/paperclip-plugin-*` packages to npm with [Changesets](https://github.com/changesets/changesets). Each package versions **independently**, and releases are automated through GitHub Actions — you never run `npm publish` by hand.

## The flow at a glance

```
open PR ──> add a changeset ──> merge to main
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                    ▼
        Changesets opens a                  (when that PR is merged)
        "Version Packages" PR   ──merge──>  CI publishes to npm,
        (bumps versions +                    tags, and creates
         writes CHANGELOGs)                  GitHub releases
```

1. **In a feature PR**, run `pnpm changeset`, pick the affected package(s) + bump type, write a user-facing summary, and commit the generated file.
2. **On merge to `main`**, the [`Release` workflow](.github/workflows/release.yml) runs. If unreleased changesets exist, it opens/updates a **"Version Packages"** PR that applies the bumps and updates each package's `CHANGELOG.md`.
3. **Merge the "Version Packages" PR.** The workflow runs again and this time **publishes** the changed packages to npm (with provenance), creates git tags, and cuts GitHub releases.

Nothing publishes until the Version Packages PR is merged — you always get a reviewable diff of exactly what will ship and at what version.

## Which packages publish

- **Published:** `@dexwox-labs/paperclip-plugin-teams`, `@dexwox-labs/paperclip-plugin-plane` — public, scoped, MIT, tagged with the `paperclip-plugin` keyword for cliphub.fyi indexing.
- **Ignored (scaffold):** `@dexwox-labs/paperclip-plugin-kiwi-tcms`, `@dexwox-labs/paperclip-plugin-test-context` are in the `ignore` list in `.changeset/config.json`. Remove them from that list when they're ready to publish.

## One-time setup: npm authentication

Pick **one** of these; OIDC is recommended.

### Option A — Trusted publishing via OIDC (recommended, no token)

On npmjs.com, for **each** published package, configure a *trusted publisher* pointing at this repo's `Release` workflow (`.github/workflows/release.yml`). The workflow already requests `id-token: write`, so npm mints a short-lived credential per publish — no secret to rotate, and provenance is attached automatically. (For the very first publish a package must already exist on npm, so you may need to do the initial publish with Option B, then switch to OIDC.)

### Option B — npm automation token

1. Create an **automation** token on npmjs.com (Access Tokens → Generate → Automation).
2. Add it as a repository secret named **`NPM_TOKEN`** (Settings → Secrets and variables → Actions).

The workflow reads it as `NODE_AUTH_TOKEN`. `NPM_CONFIG_PROVENANCE: true` still attaches build provenance (the workflow has `id-token: write`).

> The `@dexwox` scope must exist on npm and your account/org must be allowed to publish to it. `publishConfig.access = "public"` in each package makes the scoped package public.

## Cutting the first release

The packages are currently at `0.1.0` and unpublished. To ship the first versions:

```bash
# on a feature branch
pnpm changeset          # select teams and/or plane, choose the bump, write a summary
git add .changeset && git commit -m "chore: changeset for first release"
# open the PR, merge it, then merge the "Version Packages" PR the bot opens
```

Choose the bump deliberately: **minor** (`0.1.0 → 0.2.0`) if you want to signal the accumulated work, or keep the initial `0.1.0` by publishing without a version changeset. Because npm's trusted publishing can't create a brand-new package, the *first* publish of each package may need Option B (token); subsequent releases can use OIDC.

## Local commands

```bash
pnpm changeset            # add a changeset (interactive)
pnpm version-packages     # apply changesets locally (usually the CI does this)
pnpm release              # build all packages + publish (CI runs this after the Version PR merges)
```

## Notes

- **Prereleases** (e.g. `next`/`canary`): use `pnpm changeset pre enter next` … `pnpm changeset pre exit`. See the Changesets docs.
- **Never** hand-edit a package `version` or run `npm publish` directly — let the changeset flow own versions and tags so the changelog, git tag, and npm version stay in sync.
- CI gates every release on `pnpm -r typecheck && pnpm -r test`; keep `main` green.
