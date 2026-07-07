# Dexwox Paperclip Plugins

Suite of [Paperclip](https://github.com/paperclipai/paperclip) plugins built by Dexwox Innovations.

| Package | npm | Purpose |
|---|---|---|
| [`@dexwox-labs/paperclip-plugin-plane`](./packages/plane) | TBD | Bidirectional [Plane](https://plane.so) CE sync — webhook intake (HMAC), agent tools, status/comment mirror, reconciliation backstop |
| [`@dexwox-labs/paperclip-plugin-teams`](./packages/teams) | TBD | MS Teams Chat OS — v1 Adaptive Card notifications via Power Automate Workflows, v2 interactive bot on Microsoft 365 Agents SDK |
| [`@dexwox-labs/paperclip-plugin-kiwi-tcms`](./packages/kiwi-tcms) | TBD | Kiwi TCMS — agent tools for test-case authoring (JSON-RPC) + one-way CI results ingest with `plane:<id>` tagging |
| [`@dexwox-labs/paperclip-plugin-test-context`](./packages/test-context) | TBD | Test Context Registry — per-project envs, seed manifests, stub maps, secret-ref creds, ephemeral PR envs, freshness checks |

Backlog: Plane project **PCLIP** (work items PCLIP-1…40, requirement IDs P1–P9 / T1–T11 / K1–K8 / X1–X8 / D1–D4 with acceptance criteria). PRD: `project-dexwox/paperclip-plugins-prd.md`.

## Compatibility

Built against `@paperclipai/plugin-sdk`. **Note:** plugin secret-refs are disabled on paperclip master since PR #5429 (PAP-2394). Run Paperclip at `canary/v2026.509.0-canary.1` (our pinned tag — includes the in-tree Daytona provider, predates the kill switch) until company-scoped plugin config lands upstream.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Install a built package into a Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@dexwox-labs/paperclip-plugin-plane"}'
```

## License

MIT
