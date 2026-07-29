# TenuisPi

TenuisPi is the standalone agent runtime developed for the [Tenuis](https://github.com/3x-haust/Tenuis) desktop coding application. It provides model transport and agent-session primitives behind a deliberately narrow, fail-closed bridge; it is not the Tenuis UI and does not own workspace permissions, credentials, patches, review, browser automation, or desktop control.

## Source attribution

TenuisPi was ported from [`earendil-works/pi`](https://github.com/earendil-works/pi), initially from source commit `e9e86e1c832de1edfff2d42041c8f9087d72a0cf`. The upstream MIT license and Mario Zechner copyright notice are preserved in [`LICENSE`](LICENSE) and package license files.

TenuisPi is an independently maintained standalone repository by 3x-haust. It is not a GitHub fork and is not presented as an official Pi distribution. The local `upstream` remote is fetch-only and exists for attribution, security review, and deliberate source-port updates.

## Tenuis boundary

Tenuis consumes only these audited surfaces:

- `@earendil-works/pi-ai` — model and provider transport primitives
- `@earendil-works/pi-agent-core` — agent loop and in-memory session primitives
- `@3x-haust/tenuis-pi-session` — the Tenuis-owned fail-closed session bridge

The bridge requires an exact allowlist of namespaced, application-brokered tools. It creates no default file, shell, extension, skill, settings, or credential discovery path. Tenuis injects model bindings and tools at runtime and remains the sole owner of account credentials, policy, mutations, checkpoints, review, and Computer Use.

## Repository controls

- [`tenuis/compatibility.json`](tenuis/compatibility.json) pins the imported source baseline, consumed packages, exports, platforms, and receipt contract.
- [`tenuis/patches.json`](tenuis/patches.json) limits and audits TenuisPi-specific source-port changes.
- `Tenuis compatibility` builds and tests the consumed surface on macOS, Windows, and Linux, inventories packaged files, emits SBOM/license evidence, and attests exact-commit receipts.
- `Tenuis upstream candidate` creates review-only source-update candidates. It never promotes a stable release automatically.

## Development

Requirements:

- Node.js 22.19 or newer
- npm 10 or newer

```bash
npm ci --ignore-scripts
npm --prefix packages/ai run hydrate-model-data
npm --prefix packages/ai run build:offline
npm --prefix packages/agent run build
npm --prefix packages/tenuis-session run build
npm --prefix packages/tenuis-session test
node tenuis/verify-embedding.mjs
```

A missing provider credential is not a failed build and never implies that the provider is connected. Credentialed provider checks belong to opt-in Tenuis integration tests.

## License

MIT. See [`LICENSE`](LICENSE). Third-party package notices and exact package inventories are emitted by compatibility CI for every candidate commit.
