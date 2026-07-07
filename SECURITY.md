# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, report them privately using **GitHub's private vulnerability reporting**: go to the repository's **Security** tab → **Report a vulnerability**. This opens a private advisory visible only to the maintainers.

Please include:

- A description of the vulnerability and its impact
- The affected package(s) and version(s) (e.g. `@dexwox-labs/paperclip-plugin-teams@x.y.z`)
- Steps to reproduce, or a proof of concept
- Any suggested remediation

We aim to acknowledge reports within a few business days and to keep you informed as we investigate and ship a fix. Please give us a reasonable window to remediate before any public disclosure.

## Why this matters for these plugins

These plugins run inside the Paperclip host and handle sensitive material, so please be especially mindful when reporting issues involving:

- **Secret-ref credentials** — plugins resolve stored secrets (bot credentials, API keys) via the host's secret-ref mechanism; secrets must never be logged or returned in tool results.
- **Inbound webhooks & bot endpoints** — HMAC/JWT verification, replay/dedupe handling, and multi-tenant (per-company) isolation of plugin data.
- **Adaptive Card / message content** — untrusted agent/user text rendered into Teams cards (Markdown/mention injection), and routing that could leak a private message to the wrong conversation.

## Supported versions

Security fixes are provided for the **latest published minor** of each `@dexwox-labs/paperclip-plugin-*` package. Older versions may not receive backports; please upgrade to the latest release.

## Scope

This policy covers the plugin packages in this repository. Vulnerabilities in the upstream Paperclip host, Microsoft Teams, Plane, or other third-party services should be reported to those projects directly.
