# 3xhaustPi

Semantic-only coding runtime and black event-driven TUI used by 3xhaustPi.

```bash
npm install -g 3xhaustpi
3xhaustpi auth login openai-codex
3xhaustpi
```

The package exports the shared Electron/CLI runtime as `3xhaustpi/runtime`.
The model emits bounded intent and patch proposals; the host owns actual
capability names, paths, permissions, timeouts, revisions, and execution.
Credentials are stored in macOS Keychain, Windows Credential Manager, or Linux
Secret Service; the local mode-0600 file contains non-secret metadata only.

As of 2026-07-31 the package has passed local `npm pack`, isolated global
install, real-provider coding, crash-resume, and a five-case, 50-pair
real-provider benchmark with 98% semantic-only and 100% direct-tool
provider-reported warm cache-hit requests. Capability success and model-output
validity were 100% in both arms. It has not yet been published to the public npm
registry.

The idle TUI starts the coding runtime in a short-lived worker only when a task
begins. Five isolated runs measured 0% idle CPU and a 58.41/58.45 MiB median
mean/max RSS, 38.23% below the 94.55 MiB pre-worker baseline. An actual
`openai-codex/gpt-5.6-terra` task completed through this worker boundary.

External-app Computer Use ships platform adapters for macOS System Events,
Windows UI Automation, and Linux AT-SPI 2 behind one semantic role/name and
observation-digest policy. Windows/Linux protocol fixtures pass locally, and a
linux-arm64 and linux-x64 native archives completed an actual GTK 3 `Run` to
`Completed` accessibility action on Ubuntu 24.04; the x64 bundled Node reported
`linux/x64`. Windows target execution remains unverified.

See the repository README for the full user guide, benchmark receipt, native
archives, update verification, and exact unsupported scope.
