# M4-015 — Sidecar Packaging Verification

## Target

- Date: 2026-05-19
- Platform / arch: linux / x64
- Sidecar target triple: `x86_64-unknown-linux-gnu`
- Node: v25.2.1
- `node-pty`: 1.1.0

## Packaging Change

`apps/daemon/scripts/build-sidecar.mjs` now treats `node-pty` as a runtime
native dependency, matching the existing `better-sqlite3` sidecar pattern:

- `node-pty` is externalized from the SEA bundle through the runtime
  `createRequire` shim.
- The sidecar runtime tree copies `node-pty` into
  `dist/sidecar/runtime/node_modules/node-pty`.
- The build verifies the target-native `node-pty` artifact exists before SEA
  injection completes.

No Tauri launch path changed. The desktop sidecar spawn path still sets
`ORCA_RUNTIME_DIR` and invokes the bundled daemon binary the same way.

## Artifact Paths

Verified local target:

- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/build/Release/pty.node`

Copied best-effort package artifacts also include:

- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/darwin-arm64/pty.node`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/darwin-x64/pty.node`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/win32-arm64/pty.node`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/win32-arm64/conpty.node`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/win32-arm64/conpty_console_list.node`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/win32-x64/pty.node`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/win32-x64/conpty.node`
- `apps/daemon/dist/sidecar/runtime/node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node`

The build only gates on the current target's required artifact set.

## Smoke Result

`node apps/daemon/scripts/m4-015-sidecar-smoke.mjs` builds the sidecar, starts
the bundled daemon with `ORCA_RUNTIME_DIR`, creates a Goal with one workspace,
creates and starts a `shell-manual` session, sends one `echo` command over the
existing WebSocket session input frame, observes `session.output`, stops the
session through the HTTP stop endpoint, and verifies the persisted output tail.

Result: exit 0 on linux / x64.

## Gate 6 Decision

Go. The bundled sidecar can load `node-pty` from the runtime tree and spawn a
trivial PTY-backed shell session without changing the Tauri spawn path.
