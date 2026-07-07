# Paperclip Plugins by Dexwox

A suite of plugins for [Paperclip](https://github.com/paperclipai/paperclip).

| Package | Purpose |
|---|---|
| [`@dexwox-labs/paperclip-plugin-plane`](./packages/plane) | Bidirectional [Plane](https://plane.so) CE sync — webhook intake (HMAC), agent tools, status/comment mirroring, and a reconciliation backstop |
| [`@dexwox-labs/paperclip-plugin-teams`](./packages/teams) | Microsoft Teams Chat OS — Adaptive Card notifications, an interactive bot (approvals, commands), HITL escalation, and a generic ask surface |
| [`@dexwox-labs/paperclip-plugin-kiwi-tcms`](./packages/kiwi-tcms) | Kiwi TCMS — agent tools for test-case authoring (JSON-RPC) + one-way CI results ingest _(in development)_ |
| [`@dexwox-labs/paperclip-plugin-test-context`](./packages/test-context) | Test Context Registry — per-project environments, seed manifests, stub maps, and secret-ref credentials _(in development)_ |

Each package has its own README with configuration and usage details.

## Compatibility

Built against [`@paperclipai/plugin-sdk`](https://www.npmjs.com/package/@paperclipai/plugin-sdk). Requires a Paperclip host with company-scoped plugin config and secret-ref support (**Paperclip v2026.525.0 or later**).

## Development

This is a [pnpm](https://pnpm.io) workspace.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute and [RELEASING.md](./RELEASING.md) for how releases are cut.

## Installing a plugin into Paperclip

```bash
curl -X POST http://<your-paperclip-host>/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"@dexwox-labs/paperclip-plugin-plane"}'
```

## License

[MIT](./LICENSE)
