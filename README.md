# Orca

Local-first desktop application for multi-agent AI orchestration.

> **Status:** Milestone 1 (Local Runtime Foundation). The app boots, persists Goals through an event-sourced SQLite store, and streams updates to the UI over WebSocket. The orchestration features described in `docs/PRODUCT.md` are **not yet implemented**.

## What works today

- Tauri desktop shell with an embedded Node.js daemon
- Goal CRUD (create + list) backed by an append-only event log
- Live UI refresh via `/v1/events` WebSocket
- Per-launch auth token between desktop and daemon

## Not yet implemented

The following are specified in `docs/` but intentionally out of scope for M1:

- Plugin runtime
- Skill system
- PTY / agent sessions (Claude Code, opencode, Codex adapters)
- Shared memory engine and context assembly
- Orchestrator engine and recommendations
- Workflow engine
- Any AI reasoning

See [`docs/milestones/1.md`](docs/milestones/1.md) for the M1 scope and
[`docs/implementation-plans/milestone-1.md`](docs/implementation-plans/milestone-1.md) for the task breakdown.

## Prerequisites

- **Node.js 20+** — verify with `node --version`.
- **pnpm** — enable via Corepack: `corepack enable && corepack prepare pnpm@9.12.3 --activate`.
- **Rust toolchain** — install via [rustup](https://rustup.rs/). Required to build the Tauri shell.
- **OS-specific Tauri dependencies:**
  - **Linux:** see Tauri's [prerequisites for Linux](https://tauri.app/start/prerequisites/#linux) (`webkit2gtk-4.1`, `libsoup-3.0`, `libayatana-appindicator3`, etc.).
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Microsoft Edge WebView2 (preinstalled on Windows 11) and the Visual Studio Build Tools (Desktop development with C++).

## Install

```sh
pnpm install
```

This installs all workspace packages and rebuilds native modules (`better-sqlite3`) for the local Node version.

## Run

### Recommended — full desktop app

```sh
pnpm --filter @orca/desktop tauri:dev
```

Tauri starts the React dev server and spawns the daemon as a managed child process. Closing the window stops the daemon.

### Daemon only

For backend development or scripting against the HTTP API:

```sh
pnpm --filter @orca/daemon dev
```

The daemon listens on `http://127.0.0.1:8787` by default. It prints its per-launch auth token to stdout.

## Data location

The daemon writes its SQLite database and any future local state to a per-user data directory:

| OS              | Path                  |
| --------------- | --------------------- |
| Linux / macOS   | `~/.orca`             |
| Windows         | `%APPDATA%\Orca`      |

Override the location with the `ORCA_DATA_DIR` environment variable.

## Reset local data

To wipe Goals and the event log, stop the app and delete the database files:

```sh
# Linux / macOS
rm ~/.orca/orca.db ~/.orca/orca.db-wal ~/.orca/orca.db-shm
```

```powershell
# Windows
Remove-Item "$env:APPDATA\Orca\orca.db*"
```

All three files (`orca.db`, `orca.db-wal`, `orca.db-shm`) must be removed — SQLite runs in WAL mode.

## Troubleshooting

### `better-sqlite3` fails to load

Native bindings are compiled for the Node version present at `pnpm install` time. If you switch Node versions, rebuild:

```sh
pnpm --filter @orca/daemon rebuild better-sqlite3
```

### Port 8787 already in use

When running the daemon directly (`pnpm --filter @orca/daemon dev`), another process is holding the default port. Override it:

```sh
ORCA_PORT=9090 pnpm --filter @orca/daemon dev
```

The Tauri dev shell picks an ephemeral port automatically, so port conflicts only affect the daemon-only path.

### Tauri build / dev fails with Rust errors

Make sure `rustc` is on your `PATH`:

```sh
rustup show
```

If `rustup` is missing, install it from [rustup.rs](https://rustup.rs/) and restart your shell. On Linux, also confirm the system packages listed under **Prerequisites** are present.

## Repository layout

```
apps/
  daemon/         Node.js orchestrator daemon (Fastify + SQLite)
  desktop/        Tauri v2 shell (React + TypeScript)
packages/
  contracts/      Shared zod schemas and TypeScript types
docs/             Product, technical, and milestone specifications
```

## Useful commands

```sh
pnpm typecheck          # all workspaces
pnpm test               # all workspaces
pnpm --filter @orca/daemon test
```
