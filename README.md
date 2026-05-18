# Orca

Local-first desktop application for multi-agent AI orchestration.

> **Status:** Milestone 3 (Goal Refinement and Workspaces). On top of the M2 plugin/skill foundation, the daemon now exposes a deterministic `guided-goal-refinement` skill on the `goal.refine` extension point, persists Goal refinements and attached local workspaces, and serves a Goal detail bundle. The desktop has a three-step Create Goal flow and a Goal detail view with attach/remove workspace controls.

## What works today

- Tauri desktop shell with an embedded Node.js daemon
- Goal CRUD (create + list) backed by an append-only event log
- Live UI refresh via `/v1/events` WebSocket
- Per-launch auth token between desktop and daemon
- Static internal plugin registry (`GET /v1/plugins`) with three built-in descriptors
- Static internal skill registry (`GET /v1/skills`) with `quick-goal` and `guided-goal-refinement`
- Atomic `skill.invoked` + `goal.created` event pair on every Goal creation (M2 minimal flow unchanged)
- Refined Goal creation (M3): deterministic refinement, multi-workspace attach, lazy git inspection, atomic commit of `skill.invoked` → `goal.created` → `goal.refined?` → `workspace.attached*`
- Goal detail view (M3): refinement section + workspace list with attach / remove controls
- Runtime Diagnostics section in the UI listing registered plugins and skills

### M3 Create Goal flow

A three-step flow in the desktop app:

1. **Rough draft** — user enters a title and description.
2. **Refine** — daemon runs `guided-goal-refinement` (`POST /v1/goals/refine`, deterministic, no model calls) and returns success criteria, constraints, and assumptions. The user can edit each field before continuing.
3. **Attach workspaces** — user adds one or more local folders. Each is validated (`POST /v1/workspaces/inspect`) and submitted as part of `POST /v1/goals`. The daemon commits the refined Goal, refinement projection, and workspace attachments atomically, then broadcasts events. The user lands on the Goal detail view.

### M3 HTTP endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/v1/goals/refine` | Pure compute. Returns a refined Goal draft. Persists nothing, emits no events. |
| `POST` | `/v1/goals` | Extended additively with optional `refined` and `workspaces`. Response shape unchanged. |
| `GET`  | `/v1/goals/:id` | Goal detail bundle: Goal + refinement (if any) + attached workspaces. |
| `POST` | `/v1/workspaces/inspect` | Validate an absolute path and capture a bounded git snapshot. |
| `POST` | `/v1/goals/:id/workspaces` | Attach a workspace to an existing Goal. Emits `workspace.attached` post-commit. |
| `DELETE` | `/v1/goals/:id/workspaces/:workspaceId` | Detach a workspace. Emits `workspace.removed` post-commit. |

### Workspace path rules

- Paths submitted to the daemon must be absolute. `~`-expansion is the desktop's responsibility.
- The daemon stores only the canonical realpath (`fs.realpath`). The original `input_path` is never persisted.
- Duplicates are prevented per Goal by `(goal_id, canonical path)`.

### Git behavior

- Git inspection is **lazy and bounded** — never at boot, only on `POST /v1/workspaces/inspect` and at attach time.
- Branch and dirty-status are captured as a snapshot at attach; no watchers or background refresh.
- Calls are issued with `execFile` against the user's `git`. If `git` is missing, hangs past the bounded deadline, or the folder is not a working tree, the workspace is recorded as a non-git folder rather than failing the attach.

## Not yet implemented

The following are specified in `docs/` but intentionally deferred past M3:

- PTY / agent sessions (Claude Code, opencode, Codex adapters)
- Shared memory engine and context assembly
- Orchestrator engine, recommendations, workflow engine, task graph
- Workspace indexing or file watchers
- Any AI reasoning (refinement remains deterministic)
- External plugin API package, dynamic plugin loading, JSON manifests, permissions / sandbox
- Generic skill invocation endpoint, skill picker UI
- Cloud sync, Level 4 supervised execution, Level 5 autonomy

See [`docs/milestones/3.md`](docs/milestones/3.md) for the M3 scope,
[`docs/implementation-plans/milestone-3.md`](docs/implementation-plans/milestone-3.md) for the task breakdown,
and [`docs/dev/internal-plugins-and-skills.md`](docs/dev/internal-plugins-and-skills.md) for how to add internal plugins and skills.

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

### Production bundle (sidecar)

```sh
pnpm --filter @orca/desktop tauri:build
```

This invokes `pnpm --filter @orca/daemon build:sidecar` automatically (via Tauri's `beforeBundleCommand`) to produce a self-contained daemon executable, then packages the Tauri shell. Outputs land in `apps/desktop/src-tauri/target/release/bundle/`.

The sidecar is built using [Node SEA](https://nodejs.org/api/single-executable-applications.html): the daemon JS is embedded into a copy of the current `node` binary; SQL migrations are embedded as SEA assets. The `better-sqlite3` native binding (`.node` file) cannot live inside the SEA blob — Node's dynamic loader needs it on disk — so it ships as a Tauri resource (`runtime/node_modules/better-sqlite3/...`) alongside the binary, with `ORCA_RUNTIME_DIR` injected at spawn time.

**Caveats:**
- **Single-platform build.** The sidecar is produced for the developer's OS and architecture only. Cross-compilation is out of scope for M1.
- **`better-sqlite3` binding compatibility.** The shipped `.node` is the binding compiled at `pnpm install` time. It must match the major Node version embedded in the sidecar (i.e. the `node` on `PATH` when `build:sidecar` runs). Mismatches surface at startup as `Error: Module did not self-register` or `NODE_MODULE_VERSION` errors. To rebuild against the active Node: `pnpm --filter @orca/daemon rebuild better-sqlite3 && pnpm --filter @orca/daemon build:sidecar`.
- **AppImage requires a square icon.** The deb and rpm bundlers run cleanly; AppImage will abort on a missing icon until icons are added under `apps/desktop/src-tauri/icons/`.

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
