# Orca

Local-first desktop application for multi-agent AI orchestration. Orca coordinates multiple AI agent sessions (Claude Code, Codex) around long-running engineering **Goals** — preserving operational reasoning, managing shared context, and progressing from supervised to autonomous execution (Levels 4 and 5) under human oversight.

**→ Read [`ORCA.md`](ORCA.md) for the full system guide:** what Orca is, why it's shaped the way it is, where everything lives, and how the orchestrator-mediated workflow model works. This README only covers getting it running.

## Layout

```
apps/
  daemon/         Node.js orchestrator daemon (Fastify + SQLite) — the system of record
  desktop/        Tauri v2 shell (React + TypeScript)
packages/
  contracts/      Shared zod schemas and TypeScript types
```

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

Installs all workspace packages and rebuilds native modules (`better-sqlite3`, `node-pty`) for the local Node version.

## Run

### Full desktop app (recommended)

```sh
pnpm --filter @orca/desktop tauri:dev
```

Tauri starts the React dev server and spawns the daemon as a managed child process. Closing the window stops the daemon.

### Daemon only

For backend development or scripting against the HTTP API:

```sh
pnpm --filter @orca/daemon dev
```

The daemon listens on `http://127.0.0.1:8787` by default (override `ORCA_PORT`) and prints its per-launch auth token to stdout.

### Production bundle

```sh
pnpm --filter @orca/desktop tauri:build
```

This invokes `build:sidecar` automatically to produce a self-contained daemon executable (Node SEA), then packages the Tauri shell. See [`ORCA.md`](ORCA.md) §11 for sidecar caveats (single-platform, native-binding version matching).

## Useful commands

```sh
pnpm typecheck                  # all workspaces
pnpm test                       # all workspaces (vitest)
pnpm --filter @orca/daemon test
pnpm knip                       # unused-export check
```

## Data location

The daemon writes its SQLite database and local state to a per-user directory:

| OS            | Path             |
| ------------- | ---------------- |
| Linux / macOS | `~/.orca`        |
| Windows       | `%APPDATA%\Orca` |

Override with `ORCA_DATA_DIR`. To reset all Goals and the event log, stop the app and delete the SQLite files (WAL mode — remove all three):

```sh
# Linux / macOS
rm ~/.orca/orca.db ~/.orca/orca.db-wal ~/.orca/orca.db-shm
```

## Troubleshooting

- **`better-sqlite3` / `node-pty` fail to load** — native bindings are compiled at `pnpm install` time. After switching Node versions, rebuild: `pnpm --filter @orca/daemon rebuild better-sqlite3 node-pty`.
- **Port 8787 in use** (daemon-only path) — override: `ORCA_PORT=9090 pnpm --filter @orca/daemon dev`. The Tauri dev shell picks an ephemeral port automatically.
- **Tauri build/dev fails with Rust errors** — confirm `rustc` is on `PATH` (`rustup show`); on Linux confirm the system packages under **Prerequisites** are present.
</content>
