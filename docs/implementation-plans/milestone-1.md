# Orca — Milestone 1 Implementation Plan

**Source milestone:** `docs/milestones/1.md`
**Status:** Ready for AI-assisted execution
**Scope guard:** Tasks below MUST NOT introduce plugin, skill, PTY, memory, recommendation, workflow, or AI reasoning systems. Any task that requires such code is out of scope for M1.

This document decomposes Milestone 1 (Local Runtime Foundation) into bounded executable tasks. Each task is sized for a single AI session, has explicit acceptance criteria, and is reviewable in isolation.

---

## Conventions

- **Task ID:** `M1-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** Paths are relative to repo root.
- **Validation Steps:** Every task lists at least one deterministic command or scenario.
- **Stretch tasks** are marked `[STRETCH]` and MUST NOT block Definition of Done.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.

---

## Tasks

---

### M1-001 — Initialize pnpm Workspace

**Purpose**
Establish the repo skeleton (pnpm workspace, root TS config, ignore rules) so all subsequent packages can be wired in. Unlocks every downstream task; without this nothing is installable.

**Scope**
- IS: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.nvmrc` (Node 20 LTS).
- IS NOT: turbo/nx pipelines, ESLint/Prettier config, CI, shared types packages beyond what is listed below.

**Requirements**
- Root `package.json` declares `private: true`, scripts: `dev`, `build`, `typecheck`, `test`, `lint` (lint may be a no-op shim returning 0).
- `pnpm-workspace.yaml` includes `apps/*` and `packages/*`.
- `tsconfig.base.json` targets `ES2022`, `module: ESNext`, `moduleResolution: Bundler`, `strict: true`, `skipLibCheck: true`.
- `.gitignore` covers `node_modules`, `dist`, `*.log`, `.DS_Store`, `apps/desktop/src-tauri/target/`, Orca data dir override (`.orca-data/`).
- `.nvmrc` pins Node 20.x.

**Affected Areas**
- `/package.json`
- `/pnpm-workspace.yaml`
- `/tsconfig.base.json`
- `/.gitignore`
- `/.nvmrc`

**Dependencies**
- None.

**Acceptance Criteria**
- `pnpm install` exits 0 on a fresh clone.
- `pnpm -r typecheck` exits 0 (vacuously, no packages yet).
- `node --version` from `.nvmrc` is `v25.2.1`.

**Validation Steps**
- `corepack enable && pnpm install`
- `pnpm -r typecheck`
- Confirm `.gitignore` excludes `node_modules` via `git status` after install.

**Risks / Notes**
- Pin pnpm version via `packageManager` field to avoid drift between contributors.
- Do not introduce a Turbo or Nx build graph in M1.

---

### M1-002 — Scaffold `packages/contracts` with Zod Schemas

**Purpose**
Create the single shared package that defines wire-level schemas (Goal, DomainEvent, HTTP request/response). Used by both daemon and desktop, eliminating type drift across the process boundary.

**Scope**
- IS: package skeleton, `zod` dependency, Goal/DomainEvent/health schemas, exported TS types via `z.infer`.
- IS NOT: schemas for sessions/memory/tasks/plugins/skills, runtime validation helpers beyond zod parse, OpenAPI generation.

**Requirements**
- `packages/contracts/package.json` with name `@orca/contracts`, ESM, `exports` pointing to `dist/index.js` and `dist/index.d.ts`; build via `tsc`.
- Export the following zod schemas and inferred types:
  - `GoalStatus` (`'active' | 'archived'` for M1; reserve room without expanding scope).
  - `Goal` — `id`, `title`, `description`, `status`, `autonomyLevel` (default 1), `createdAt`, `updatedAt`, `archivedAt | null`.
  - `CreateGoalRequest` — `title` (1..200), `description` (default `''`, max 4000).
  - `CreateGoalResponse` — `{ goal: Goal }`.
  - `ListGoalsResponse` — `{ goals: Goal[] }`.
  - `HealthResponse` — `{ status: 'ok', version: string, startedAt: string }`.
  - `DomainEvent` — `seq`, `id`, `type` (literal union `'goal.created' | 'goal.updated' | 'goal.archived'`), `goalId: string | null`, `payload: Record<string, unknown>`, `createdAt`.
- No runtime side effects on import; tree-shakeable ESM.

**Affected Areas**
- `packages/contracts/package.json`
- `packages/contracts/tsconfig.json`
- `packages/contracts/src/index.ts`

**Dependencies**
- M1-001

**Acceptance Criteria**
- `pnpm --filter @orca/contracts build` produces `dist/index.{js,d.ts}`.
- `pnpm --filter @orca/contracts typecheck` exits 0.
- Importing `Goal`, `DomainEvent`, `CreateGoalRequest` from `@orca/contracts` in a sibling package compiles.

**Validation Steps**
- `pnpm --filter @orca/contracts build`
- Write a 5-line scratch script that `z.parse`s a valid and an invalid Goal payload; valid passes, invalid throws.

**Risks / Notes**
- Keep `autonomyLevel` as a number, not an enum, to avoid baking M1 assumptions about levels.
- Do not add `sessionId`, `taskId`, `causationId`, `correlationId` — milestone explicitly defers these.

---

### M1-003 — Scaffold `apps/daemon` Package

**Purpose**
Create the Node/TypeScript daemon package skeleton with the file layout the milestone prescribes. Subsequent daemon tasks slot files into this skeleton.

**Scope**
- IS: `package.json`, `tsconfig.json`, empty source files matching the milestone layout, `tsx` dev runner, build via `tsc`.
- IS NOT: actual HTTP server, DB code, or event logic (those are later tasks).

**Requirements**
- `apps/daemon/package.json` name `@orca/daemon`, ESM, dependencies: `fastify`, `@fastify/websocket`, `better-sqlite3`, `zod`, `pino`, `@orca/contracts` (workspace:*). devDependencies: `tsx`, `typescript`, `vitest`, `@types/node`, `@types/better-sqlite3`.
- Scripts: `dev` (tsx watch `src/index.ts`), `build` (`tsc`), `start` (`node dist/index.js`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`).
- Create empty (or single-export stub) files: `src/index.ts`, `src/config.ts`, `src/server.ts`, `src/db.ts`, `src/migrations.ts`, `src/events.ts`, `src/goals.ts`, `src/shutdown.ts`.
- Create `migrations/` directory with a `.gitkeep`.
- `tsconfig.json` extends `tsconfig.base.json`, sets `outDir: dist`, `rootDir: src`, `composite: true`, references `../../packages/contracts`.

**Affected Areas**
- `apps/daemon/**`

**Dependencies**
- M1-002

**Acceptance Criteria**
- `pnpm --filter @orca/daemon typecheck` exits 0.
- `pnpm --filter @orca/daemon build` produces `dist/index.js`.
- `pnpm --filter @orca/daemon dev` starts a process that exits cleanly with no errors (no server yet).

**Validation Steps**
- `pnpm install && pnpm --filter @orca/daemon build`
- `ls apps/daemon/src` shows the prescribed files.

**Risks / Notes**
- `better-sqlite3` requires native bindings. Document Node 20 requirement in README later (M1-021).

---

### M1-004 — Scaffold `apps/desktop` Tauri v2 + React Shell

**Purpose**
Create the Tauri v2 shell with a React/Vite renderer so we have a window that opens and can host UI in later tasks.

**Scope**
- IS: Tauri v2 init (Rust side), Vite + React + TS renderer, blank `App.tsx` that renders `<h1>Orca</h1>`, build/dev scripts.
- IS NOT: daemon spawn, API calls, IPC commands beyond defaults, application icons/branding work.

**Requirements**
- `apps/desktop/package.json` name `@orca/desktop`, scripts: `dev` (vite), `build` (vite build), `tauri` (tauri CLI), `tauri:dev`, `tauri:build`, `typecheck`.
- `src-tauri/` initialized with Tauri v2 (`tauri.conf.json`, `Cargo.toml`, `src/main.rs`).
- `tauri.conf.json`:
  - `productName: "Orca"`, identifier `dev.orca.desktop`.
  - `build.frontendDist: "../dist"`, `build.devUrl: "http://localhost:5173"`.
  - Empty/default allowlist; do NOT widen.
- React renderer: `src/main.tsx` mounts `App`; `App.tsx` renders a static placeholder.
- Renderer depends on `@orca/contracts` (workspace) so the import path is wired even before use.

**Affected Areas**
- `apps/desktop/**`

**Dependencies**
- M1-002

**Acceptance Criteria**
- `pnpm --filter @orca/desktop tauri:dev` opens a window showing the placeholder.
- `pnpm --filter @orca/desktop typecheck` exits 0.
- `pnpm --filter @orca/desktop build` produces a `dist/` folder.

**Validation Steps**
- Run `pnpm --filter @orca/desktop tauri:dev`; window opens locally.
- Close window; process exits cleanly.

**Risks / Notes**
- Rust toolchain must be installed locally; document in README (M1-021).
- Linux WSL: GUI requires WSLg or remote display. Plan for testing on the user's native OS.

---

### M1-005 — Daemon Config + Data Directory Resolution

**Purpose**
Centralize daemon configuration (port, data dir, log level, auth token) so every later subsystem reads from a single, testable source.

**Scope**
- IS: `src/config.ts` exporting a typed `loadConfig()` that resolves data dir, port (default 8787), log level, optional `ORCA_TOKEN` (generates ephemeral if unset).
- IS NOT: dotenv loading, secret management, multi-profile support.

**Requirements**
- Data directory resolution:
  - Env `ORCA_DATA_DIR` overrides.
  - Default to `~/.orca` (POSIX) or `%APPDATA%\Orca` (Windows). Use `os.homedir()` + `path.join`.
  - Create the directory if absent.
- Port: `ORCA_PORT` env or `8787` default.
- Auth token: `ORCA_TOKEN` env or generated via `crypto.randomUUID()` at startup; export getter, never log raw value.
- Log level: `ORCA_LOG_LEVEL` env or `info`.
- Export typed `Config` interface.
- Pure (no I/O at import time); `loadConfig()` is the only side-effect entry point.

**Affected Areas**
- `apps/daemon/src/config.ts`

**Dependencies**
- M1-003

**Acceptance Criteria**
- Unit test: setting `ORCA_DATA_DIR=/tmp/orca-test-<rand>` yields `config.dataDir` equal to that path, and the directory exists after `loadConfig()`.
- Unit test: omitting `ORCA_TOKEN` produces a UUID-shaped token; setting it preserves the value.

**Validation Steps**
- `pnpm --filter @orca/daemon test` for the two unit tests above.

**Risks / Notes**
- Do not include the token value in any pino log line. Verify by grepping log output during a later integration test.

---

### M1-006 — Daemon: Fastify HTTP Server + `/v1/health`

**Purpose**
Stand up the HTTP server that all subsequent endpoints attach to. Health endpoint provides the first deterministic boot signal for the renderer.

**Scope**
- IS: Fastify instance, `GET /v1/health`, pino logger wiring, CORS for `http://localhost:5173` (Vite dev) and `tauri://localhost`.
- IS NOT: WebSocket, auth middleware, DB, Goal routes.

**Requirements**
- `src/server.ts` exports `createServer(config: Config): FastifyInstance`.
- `src/index.ts` calls `loadConfig()`, builds server, `listen({ host: '127.0.0.1', port: config.port })`. Bind ONLY to loopback.
- `GET /v1/health` returns `HealthResponse` (`status: 'ok'`, `version` from daemon `package.json`, `startedAt` ISO timestamp captured at boot).
- Use `@fastify/cors` with allowlist `['http://localhost:5173', 'tauri://localhost', 'http://tauri.localhost']`.
- Logger uses pino with `level` from config; redact `req.headers.authorization`.

**Affected Areas**
- `apps/daemon/src/server.ts`
- `apps/daemon/src/index.ts`

**Dependencies**
- M1-005

**Acceptance Criteria**
- `pnpm --filter @orca/daemon dev` boots; `curl http://127.0.0.1:8787/v1/health` returns 200 with conformant JSON.
- Connecting from a non-loopback address fails (server bound to 127.0.0.1).
- Authorization header value is not present in log output for any request.

**Validation Steps**
- Integration test (vitest) using Fastify `inject()`: `GET /v1/health` → 200, body parses through `HealthResponse` schema.
- Manual: `curl -v http://127.0.0.1:8787/v1/health`.

**Risks / Notes**
- Do not bind `0.0.0.0`. Loopback only.

---

### M1-007 — Daemon: SQLite Open with WAL + Foreign Keys

**Purpose**
Provide the singleton SQLite handle with the durability/integrity flags every later DB task depends on.

**Scope**
- IS: `src/db.ts` exporting `openDatabase(config: Config): Database.Database`, pragmas, singleton accessor.
- IS NOT: migrations (next task), prepared statements, repositories.

**Requirements**
- Use `better-sqlite3`. DB path: `path.join(config.dataDir, 'orca.db')`.
- After open, execute pragmas in order: `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- Export `getDatabase()` accessor that throws if not yet opened.
- Provide `closeDatabase()` that calls `db.close()` and clears the singleton.

**Affected Areas**
- `apps/daemon/src/db.ts`

**Dependencies**
- M1-005

**Acceptance Criteria**
- Unit test: opening DB at a fresh temp dir creates a file and `PRAGMA journal_mode` returns `wal`.
- Unit test: `PRAGMA foreign_keys` returns `1`.
- `closeDatabase()` allows reopening on the same path without error.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Inspect resulting `orca.db` exists in temp dir.

**Risks / Notes**
- WAL creates `-wal` and `-shm` companion files. README must mention deleting all three when resetting local data.
- Native binding mismatch is a common pitfall — pin Node 20 and add `engines` field to daemon `package.json`.

---

### M1-008 — Daemon: Migration Runner + `0001_init.sql`

**Purpose**
Apply the schema for `events`, `goals`, `_migrations` exactly once per fresh DB. Guarantees deterministic boot.

**Scope**
- IS: tiny migration runner (read SQL files, run pending ones inside a transaction, record in `_migrations`), the single migration file from milestone spec.
- IS NOT: down migrations, multi-file ordering across feature branches, schema diff tooling.

**Requirements**
- `src/migrations.ts` exports `runMigrations(db: Database.Database, dir: string): { applied: string[] }`.
- Algorithm:
  1. Ensure `_migrations` table exists.
  2. List `*.sql` files in `dir`, lexically sorted.
  3. For each filename not already in `_migrations`, run the SQL within a single `db.transaction(() => { ... })` and then insert `(name, applied_at)`.
- `apps/daemon/migrations/0001_init.sql` contains the EXACT schema from `docs/milestones/1.md` §9 (events, goals, indices, `_migrations` is created by runner so it should appear only in code, not in the SQL file).
- Daemon boot (`src/index.ts`) calls `runMigrations` after `openDatabase`, before `server.listen`.

**Affected Areas**
- `apps/daemon/src/migrations.ts`
- `apps/daemon/migrations/0001_init.sql`
- `apps/daemon/src/index.ts`

**Dependencies**
- M1-007

**Acceptance Criteria**
- Unit test (temp DB): run migrations on empty DB → `applied = ['0001_init.sql']`; running again → `applied = []`.
- Test confirms `events`, `goals` tables and the two named indices exist via `sqlite_master`.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Manual: delete `~/.orca/orca.db*`, boot daemon, confirm tables via `sqlite3 ~/.orca/orca.db '.schema'`.

**Risks / Notes**
- Wrap each migration in a transaction so partial application cannot record success. `better-sqlite3` transactions are synchronous — fine here.

---

### M1-009 — Daemon: In-Process Event Bus

**Purpose**
Provide the post-commit notification primitive used by the WS endpoint. Built before WS so the unit boundary is clean.

**Scope**
- IS: `src/events.ts` exporting `EventBus` with `subscribe(handler)`, `publish(event)`, and an `emitCommitted(event)` helper.
- IS NOT: durable subscriptions, backpressure, fan-out to external systems.

**Requirements**
- Pure in-memory EventEmitter wrapper, typed for `DomainEvent` from `@orca/contracts`.
- `subscribe(handler)` returns an unsubscribe function.
- Synchronous dispatch; handlers that throw must not crash the publisher — log and continue.
- Singleton bus instance exported alongside the class, for daemon-internal use.

**Affected Areas**
- `apps/daemon/src/events.ts`

**Dependencies**
- M1-008

**Acceptance Criteria**
- Unit test: subscribe, publish 3 events, observe 3 calls in order.
- Unit test: a throwing handler does not prevent a second subscriber from receiving the event.
- Unit test: unsubscribe stops further deliveries.

**Validation Steps**
- `pnpm --filter @orca/daemon test`

**Risks / Notes**
- Keep dispatch synchronous to preserve the "publish only after commit" guarantee with no scheduling gaps.

---

### M1-010 — Daemon: Goal Usecases + Event/Projection Transaction

**Purpose**
Implement the single durable write path. This is the heart of the M1 fitness function: one transaction appends a `goal.created` event AND inserts the projection row. Bus publish happens only after commit.

**Scope**
- IS: `src/goals.ts` with `createGoal({ title, description })` and `listGoals()` usecases, ID generation, ISO timestamps, transactional write, post-commit `bus.publish`.
- IS NOT: HTTP wiring (next task), edit/archive (deferred to stretch), workspaces, validation beyond schema parse.

**Requirements**
- `createGoal(input: CreateGoalRequest): Goal`:
  - Parse input via `CreateGoalRequest` zod schema; throw a typed `ValidationError` on failure.
  - Generate `goalId = crypto.randomUUID()`, `eventId = crypto.randomUUID()`, `now = new Date().toISOString()`.
  - Build the `goal.created` event with payload `{ title, description }`.
  - Inside a single `db.transaction(() => { ... })`:
    1. `INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, 'goal.created', ?, ?, ?)` — capture `seq` via `lastInsertRowid`.
    2. `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)`.
  - After commit, call `bus.publish(event)` where `event` includes the assigned `seq`.
  - Return the persisted `Goal`.
- `listGoals(): Goal[]`:
  - `SELECT * FROM goals WHERE archived_at IS NULL ORDER BY updated_at DESC`.
  - Map rows to `Goal` shape (camelCase, parse via zod for safety).
- All SQL uses prepared statements created once at module load.

**Affected Areas**
- `apps/daemon/src/goals.ts`

**Dependencies**
- M1-008, M1-009

**Acceptance Criteria**
- Unit test (temp DB): `createGoal({ title: 'X' })` returns a Goal; DB has exactly one row in `events` (type `goal.created`) and one row in `goals` with matching `id`.
- Unit test: forcing the projection insert to throw (e.g., monkey-patch) rolls back both rows.
- Unit test: `bus.publish` is NOT called when the transaction rolls back.
- Unit test: `bus.publish` IS called exactly once on success, with the event including a numeric `seq`.
- Unit test: `listGoals()` returns the created Goal.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Post-test: `sqlite3 <tmp>/orca.db 'select count(*) from events; select count(*) from goals;'` matches expectations.

**Risks / Notes**
- This task is the most consequential. Reviewer must verify the post-commit publish ordering by reading the diff.
- Do not call `bus.publish` inside the transaction callback.

---

### M1-011 — Daemon: HTTP Routes `POST /v1/goals` and `GET /v1/goals`

**Purpose**
Expose Goal usecases over HTTP, completing the API surface required for M1 baseline.

**Scope**
- IS: route registration in `src/server.ts`, request validation via zod, response shaping.
- IS NOT: edit/archive routes, pagination, filtering.

**Requirements**
- `POST /v1/goals`:
  - Parse body with `CreateGoalRequest`. On parse error, respond 400 with `{ error: 'validation_failed', issues: [...] }`.
  - Call `createGoal`; respond 201 with `CreateGoalResponse`.
- `GET /v1/goals`:
  - Call `listGoals()`; respond 200 with `ListGoalsResponse`.
- Routes register inside `createServer` so existing integration tests keep working via `inject()`.

**Affected Areas**
- `apps/daemon/src/server.ts`

**Dependencies**
- M1-010

**Acceptance Criteria**
- Integration test (`inject`): `POST /v1/goals` with valid payload returns 201 + valid `Goal`.
- Integration test: invalid payload (`title: ''`) returns 400.
- Integration test: subsequent `GET /v1/goals` returns the created Goal.
- `curl` smoke test: end-to-end create + list works against a running daemon.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Manual: `curl -X POST localhost:8787/v1/goals -H 'content-type: application/json' -d '{"title":"first"}'` then `curl localhost:8787/v1/goals`.

**Risks / Notes**
- Do not implement a command bus. Routes call usecases directly per simplification table in the milestone.

---

### M1-012 — Daemon: WebSocket `/v1/events` Endpoint

**Purpose**
Stream committed Goal events to connected renderers, enabling the live UI refresh path that proves the event-driven loop.

**Scope**
- IS: `@fastify/websocket` registration, `/v1/events` route, subscription bridge from the in-process bus, JSON framing.
- IS NOT: replay (`?sinceSeq`) — stretch task, reconnect protocol, heartbeats.

**Requirements**
- Register `@fastify/websocket`.
- On WS connect:
  - If auth is enabled, validate `?token=<token>` against `config.token`; close with 1008 on mismatch.
  - Subscribe to the bus. On each event, `ws.send(JSON.stringify(event))`.
  - On `close`, call unsubscribe.
- Server frames each event as a single JSON message conforming to `DomainEvent`.
- Bind WS under the same Fastify instance so it shares the listener and shutdown path.

**Affected Areas**
- `apps/daemon/src/server.ts`

**Dependencies**
- M1-009, M1-010, M1-011

**Acceptance Criteria**
- Integration test: open WS to running test server, `POST /v1/goals`, receive a `goal.created` message within 250ms; message parses via `DomainEvent` schema.
- Integration test: closing WS does not crash the server; subsequent events are not delivered.
- Integration test (auth enabled): connecting without token returns close code 1008.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Manual: `websocat ws://127.0.0.1:8787/v1/events?token=<token>` and `curl POST` from another shell.

**Risks / Notes**
- Browser WebSocket cannot set custom headers; query token is the M1 approach per milestone.

---

### M1-013 — Daemon: Graceful Shutdown

**Purpose**
Close HTTP server, WS clients, event bus, and SQLite cleanly on SIGTERM/SIGINT so the daemon does not leak resources or corrupt WAL.

**Scope**
- IS: signal handlers, ordered shutdown sequence, 5-second budget.
- IS NOT: auto-restart, supervisor process.

**Requirements**
- `src/shutdown.ts` exports `registerShutdown(server, db)`.
- On `SIGTERM` or `SIGINT`:
  1. Stop accepting new connections (`server.close`).
  2. Close any open WS clients with code 1001.
  3. Wait up to 5s for in-flight handlers to finish.
  4. `closeDatabase()`.
  5. `process.exit(0)`.
- If shutdown exceeds 5s, force-exit with code 1.
- Wired from `src/index.ts` after `server.listen` resolves.

**Affected Areas**
- `apps/daemon/src/shutdown.ts`
- `apps/daemon/src/index.ts`

**Dependencies**
- M1-007, M1-012

**Acceptance Criteria**
- Manual: start daemon, `kill -TERM <pid>`, process exits within 5s with code 0.
- Manual: open a WS client, kill daemon, client sees close code 1001.
- After clean shutdown, `orca.db-wal` is checkpointed or removed (not required for correctness, but should not leave a 100MB+ WAL).

**Validation Steps**
- Manual scenario above; no orphan process in `ps`.

**Risks / Notes**
- WAL checkpointing is explicitly NOT a correctness requirement per milestone §8.

---

### M1-014 — Desktop: API Client + Daemon Endpoint Wiring

**Purpose**
Provide the renderer-side HTTP/WS client typed against `@orca/contracts`. All UI tasks consume this module.

**Scope**
- IS: `src/api.ts` with `fetchHealth`, `listGoals`, `createGoal`, `openEventStream`; daemon endpoint resolution via env (`VITE_ORCA_BASE_URL`, default `http://127.0.0.1:8787`) and token (`VITE_ORCA_TOKEN`).
- IS NOT: state management library, retry/backoff logic, request caching.

**Requirements**
- All HTTP calls send `Authorization: Bearer <token>` if a token is configured.
- Response bodies validated through the matching zod schemas; on parse failure, throw a typed `ApiError`.
- `openEventStream({ onEvent, onStatus })` returns `{ close() }`. Append `?token=<token>` if token configured.
- WS reconnect: simple `setTimeout(reconnect, 1000)` on close; emit `'connecting' | 'open' | 'closed'` via `onStatus`. No exponential backoff in M1.

**Affected Areas**
- `apps/desktop/src/api.ts`

**Dependencies**
- M1-004, M1-002

**Acceptance Criteria**
- `pnpm --filter @orca/desktop typecheck` exits 0.
- Hand-test against a running daemon: `fetchHealth()` returns the typed response in the browser console (via temporary call from `App.tsx`).

**Validation Steps**
- Start daemon (M1-006 onward) and run `pnpm --filter @orca/desktop tauri:dev`; from the renderer devtools console, call exported functions.

**Risks / Notes**
- Read token from a Tauri-injected value when daemon is spawned by Tauri (M1-018). Until then, accept `VITE_ORCA_TOKEN` env for local dev.

---

### M1-015 — Desktop: Connection Status + Goal UI

**Purpose**
Deliver the minimal diagnostic UI: connection indicator, create-Goal form, and Goal list. This is the user-facing proof of the loop.

**Scope**
- IS: a single-screen React UI with three regions (status header, create form, list), styles via plain CSS, fetch on mount, refetch on `goal.*` WS events.
- IS NOT: routing, themes, placeholder panels for Workspaces/Sessions/Memory.

**Requirements**
- On mount: poll `GET /v1/health` every 5s; render `Connected` / `Disconnected` / `Connecting…` based on status.
- Mount: `openEventStream`; on any `goal.*` event, call `listGoals()` and update list state.
- Create form: title (required, 1..200), description (optional, multiline, max 4000). On submit: call `createGoal`; clear form on success; show error inline on validation failure.
- Goal list: render `goals` from state, sorted by `updatedAt` desc; show title, description (truncated), status, createdAt.
- If daemon is disconnected: disable form, show prominent error banner.

**Affected Areas**
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/*` (small, optional)
- `apps/desktop/src/styles.css`

**Dependencies**
- M1-014, M1-011, M1-012

**Acceptance Criteria**
- Manual: launch desktop app + running daemon; submit a Goal; entry appears in the list within 1s without manual refresh (driven by WS event).
- Manual: stop daemon; UI flips to Disconnected within 10s; form becomes disabled.
- Manual: restart daemon; UI flips to Connected; existing Goals appear in the list.

**Validation Steps**
- Run the above three manual scenarios end-to-end.
- Confirm DevTools network panel shows `GET /v1/goals` fires once on mount and once per WS `goal.*` event.

**Risks / Notes**
- Per milestone §12, intentionally simple. Do not introduce TanStack Query or Zustand.

---

### M1-016 — Desktop: Tauri-Managed Daemon Lifecycle

**Purpose**
Have the Tauri shell start (and stop) the daemon as a child process during dev and packaged runs, so users don't run two terminals.

**Scope**
- IS: Rust-side `Command::new` spawn of the daemon binary or `pnpm --filter @orca/daemon dev`, environment passthrough (`ORCA_DATA_DIR`, `ORCA_PORT`, generated `ORCA_TOKEN`), stdout/stderr capture to Tauri log, kill on app exit.
- IS NOT: auto-restart (deferred), sidecar packaging hardening (stretch), multi-platform CI.

**Requirements**
- In `src-tauri/src/main.rs`, on app setup:
  - Generate a UUID token via `uuid` crate.
  - Spawn daemon as a child with envs `ORCA_PORT=<chosen>`, `ORCA_TOKEN=<token>`, `ORCA_DATA_DIR=<default>`.
  - Wait until `GET /v1/health` succeeds (poll loop, 50ms interval, 10s timeout) before showing the window — OR — emit the endpoint/token to the renderer via Tauri command `get_daemon_endpoint()`.
- Renderer reads endpoint + token via `invoke('get_daemon_endpoint')` and configures `api.ts` accordingly (replaces the dev `VITE_ORCA_*` path).
- On window close, kill the child daemon process; verify in `ps` that no orphan remains.

**Affected Areas**
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src/api.ts` (consume `get_daemon_endpoint`)

**Dependencies**
- M1-013, M1-014, M1-015

**Acceptance Criteria**
- Manual: `pnpm --filter @orca/desktop tauri:dev` opens window, daemon starts as child, UI reaches Connected without manual daemon launch.
- Manual: closing the window terminates the daemon; `ps aux | grep daemon` shows nothing.
- Manual: `Authorization` header in renderer requests matches the token generated by the Rust shell.

**Validation Steps**
- Run the above manual scenarios.
- Force-kill the renderer (devtools crash) and verify the daemon does not linger (best-effort; documented limitation if it does).

**Risks / Notes**
- Production sidecar packaging is stretch (M1-022). For M1 baseline, dev-mode spawn that invokes `pnpm --filter @orca/daemon dev` is acceptable.
- This task is the most platform-sensitive — recommend human review on macOS, Windows, and Linux paths.

---

### M1-017 — Daemon Integration Tests: End-to-End Loop

**Purpose**
Provide deterministic regression coverage for the M1 fitness function so future milestones cannot accidentally break the loop.

**Scope**
- IS: vitest integration suite that exercises `POST /v1/goals` → event row → projection row → WS delivery → `GET /v1/goals` against a real Fastify + better-sqlite3 in a temp dir.
- IS NOT: UI tests (manual per M1-015), cross-process Tauri tests.

**Requirements**
- Test setup: each test uses an isolated `ORCA_DATA_DIR` via `os.tmpdir()`; teardown deletes the dir.
- Tests to include:
  1. Boot: health endpoint returns ok.
  2. Migrations apply exactly once; second boot leaves `_migrations` unchanged.
  3. Create Goal: row counts in `events` and `goals` are 1/1; matching IDs.
  4. WS delivery: a connected WS client receives the `goal.created` event after the HTTP response resolves.
  5. Restart persistence: stop server, reopen DB, `GET /v1/goals` returns the previously created Goal.
  6. Transaction rollback: simulate projection failure → no rows added, bus did not publish.

**Affected Areas**
- `apps/daemon/test/**`

**Dependencies**
- M1-012

**Acceptance Criteria**
- `pnpm --filter @orca/daemon test` exits 0 with all six tests passing.
- Tests are deterministic across 5 sequential runs locally.

**Validation Steps**
- `for i in 1 2 3 4 5; do pnpm --filter @orca/daemon test || break; done`

**Risks / Notes**
- WS test must use a real WS client (e.g., `ws` package) rather than `inject`, because Fastify `inject` does not exercise the WS upgrade path.

---

### M1-018 — CI Workflow (Install, Typecheck, Test, Build)

**Purpose**
Catch regressions on every push. Establishes the minimum durable CI surface for future milestones.

**Scope**
- IS: a single GitHub Actions workflow (or equivalent) running install / typecheck / test / build on Linux.
- IS NOT: multi-OS matrix, release pipelines, Tauri bundle builds.

**Requirements**
- `.github/workflows/ci.yml`:
  - Trigger on `push` and `pull_request`.
  - Steps: checkout, setup-node@v4 (Node 20), enable corepack, `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @orca/daemon build`, `pnpm --filter @orca/desktop build` (renderer only — no Tauri bundle).
- Cache pnpm store to keep CI under 5 min.
- Fail loudly on any non-zero exit.

**Affected Areas**
- `.github/workflows/ci.yml`

**Dependencies**
- M1-017

**Acceptance Criteria**
- Workflow runs green on a clean clone branch.
- Adding a deliberate failing test causes CI to fail.

**Validation Steps**
- Push to a feature branch; observe green CI.
- Locally: `act` may be used to dry-run if available.

**Risks / Notes**
- Cross-platform CI for Tauri bundles is explicitly NOT in M1.

---

### M1-019 — README + Dev Workflow Documentation

**Purpose**
Make the M1 system reproducible: a fresh clone reaches a running app via README.

**Scope**
- IS: top-level `README.md` covering prerequisites, install, dev start, data location, data reset, troubleshooting.
- IS NOT: architecture deep-dive (those live in `docs/`), contribution guide, release notes.

**Requirements**
- Sections:
  1. Prerequisites: Node 20, pnpm (via corepack), Rust toolchain, OS-specific notes.
  2. Install: `pnpm install`.
  3. Dev (recommended): `pnpm --filter @orca/desktop tauri:dev`.
  4. Dev (daemon only): `pnpm --filter @orca/daemon dev`.
  5. Data location: `~/.orca` (Linux/macOS), `%APPDATA%\Orca` (Windows). Note `ORCA_DATA_DIR` override.
  6. Reset local data: delete `~/.orca/orca.db*` (all three files).
  7. Troubleshooting: `better-sqlite3` rebuild, port conflicts (`ORCA_PORT`), Tauri Rust install.
- Link to `docs/milestones/1.md` and this implementation plan.

**Affected Areas**
- `/README.md`

**Dependencies**
- M1-016, M1-018

**Acceptance Criteria**
- A fresh clone on a clean machine, following only README steps, reaches a running app with a creatable Goal.
- README explicitly lists what is NOT yet implemented (plugins, skills, sessions, memory) to set expectations.

**Validation Steps**
- Wipe local repo, fresh clone, follow README verbatim, validate app launches.

**Risks / Notes**
- Keep README factual and short — exhaustive docs belong in `docs/`.

---

### M1-020 — [STRETCH] Optional Goal Edit/Archive

**Purpose**
Round out CRUD if baseline loop is stable; proves `goal.updated` and `goal.archived` events flow through the same transactional path.

**Scope**
- IS: `PATCH /v1/goals/:id` (title/description), `POST /v1/goals/:id/archive`, corresponding events + projection updates, UI controls.
- IS NOT: status-machine validation beyond active↔archived.

**Requirements**
- New usecases `updateGoal(id, patch)` and `archiveGoal(id)` mirror the M1-010 transactional pattern.
- Routes added to `server.ts`.
- Events `goal.updated` (`payload: { title?, description? }`) and `goal.archived` (`payload: {}`) emitted post-commit.
- UI: pencil/archive buttons per Goal row; archived Goals hidden from default list.

**Affected Areas**
- `apps/daemon/src/goals.ts`
- `apps/daemon/src/server.ts`
- `apps/desktop/src/App.tsx`

**Dependencies**
- M1-015 (baseline must be stable)

**Acceptance Criteria**
- Integration test: edit persists; matching `goal.updated` event present.
- Integration test: archive removes from default list; `archived_at` set.
- Manual UI verification.

**Validation Steps**
- `pnpm --filter @orca/daemon test`
- Manual UI scenarios.

**Risks / Notes**
- Resist adding richer status transitions in this task.

---

### M1-021 — [STRETCH] WS Replay via `GET /v1/events?sinceSeq=N`

**Purpose**
Demonstrate event log usability for catch-up, paving a low-risk path toward M4 session streaming.

**Scope**
- IS: HTTP endpoint that returns events with `seq > N`, ordered ascending.
- IS NOT: long-running subscribe-then-replay WS protocol.

**Requirements**
- Pagination by `seq`; max 500 events per response; include `nextSinceSeq`.
- zod schema for the response added to `@orca/contracts`.

**Affected Areas**
- `apps/daemon/src/server.ts`
- `packages/contracts/src/index.ts`

**Dependencies**
- M1-012

**Acceptance Criteria**
- Integration test: create 3 Goals, `GET /v1/events?sinceSeq=0` returns 3 events; `GET /v1/events?sinceSeq=1` returns 2.

**Validation Steps**
- `pnpm --filter @orca/daemon test`

**Risks / Notes**
- Do not let this absorb time from baseline tasks.

---

### M1-022 — [STRETCH] Production Daemon Sidecar Bundle

**Purpose**
Package the daemon as a Tauri sidecar binary so a production build runs without external pnpm/Node.

**Scope**
- IS: `pkg` or `node --experimental-sea-config` build of the daemon, Tauri `externalBin` config, smoke test of bundled `tauri:build`.
- IS NOT: code signing, multi-OS matrix CI.

**Requirements**
- Produce a single-platform (developer's OS) sidecar binary that boots and serves `/v1/health`.
- Update `tauri.conf.json` `bundle.externalBin` accordingly.
- Document binding-mismatch caveats for `better-sqlite3`.

**Affected Areas**
- `apps/daemon/package.json` (build script)
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/src/main.rs` (sidecar invocation)

**Dependencies**
- M1-016

**Acceptance Criteria**
- `pnpm --filter @orca/desktop tauri:build` produces a runnable bundle that creates a Goal end-to-end on the developer's OS.

**Validation Steps**
- Install the bundled app on the dev machine; run the M1-015 manual scenarios.

**Risks / Notes**
- Highest packaging risk. Per milestone §13, must not block M1 completion.

---

## Task Dependency Graph

```text
M1-001 (workspace)
  └── M1-002 (contracts)
        ├── M1-003 (daemon scaffold)
        │     └── M1-005 (config)
        │           ├── M1-006 (health server) ─────────────┐
        │           └── M1-007 (sqlite open)               │
        │                 └── M1-008 (migrations)          │
        │                       └── M1-009 (event bus)     │
        │                             └── M1-010 (goal usecases + txn)
        │                                   └── M1-011 (HTTP goals routes)
        │                                         └── M1-012 (WS /v1/events)
        │                                               ├── M1-013 (graceful shutdown)
        │                                               ├── M1-017 (integration tests)
        │                                               └── M1-021 [STRETCH] (replay)
        └── M1-004 (desktop scaffold)
              └── M1-014 (api client)
                    └── M1-015 (Goal UI)
                          └── M1-016 (Tauri daemon lifecycle)
                                └── M1-022 [STRETCH] (sidecar bundle)

M1-017 ──> M1-018 (CI)
M1-016, M1-018 ──> M1-019 (README)
M1-015 ──> M1-020 [STRETCH] (edit/archive)
```

### Parallelizable Branches

After M1-002 lands, two streams run in parallel:
- **Daemon branch:** M1-003 → M1-005 → M1-006 → M1-007 → M1-008 → M1-009 → M1-010 → M1-011 → M1-012
- **Desktop branch:** M1-004 → M1-014 (API client can be built against `@orca/contracts` types before daemon endpoints exist; integrate after M1-012)

### Hard Blockers

- M1-010 blocks the entire UI flow — every later task assumes the transactional write path works.
- M1-012 blocks M1-015's WS-driven refresh path.
- M1-016 blocks M1-019's "fresh clone reaches running app" criterion.

---

## Suggested Model Assignment

| Task | Recommended Model | Reasoning |
|---|---|---|
| M1-001 | Codex | Pure boilerplate; deterministic outputs. |
| M1-002 | Codex | Schema definitions, mechanical. |
| M1-003 | Codex | Package scaffolding. |
| M1-004 | Sonnet | Tauri v2 init has runtime nuances; needs judgment on config. |
| M1-005 | Codex | Small, well-bounded config module. |
| M1-006 | Sonnet | Runtime wiring + CORS + logger nuances. |
| M1-007 | Codex | Pragma sequencing is mechanical. |
| M1-008 | Sonnet | Migration runner is small but has correctness traps (transaction-per-file). |
| M1-009 | Codex | Event-emitter wrapper. |
| M1-010 | **Sonnet** | **Critical transactional logic; needs careful review.** |
| M1-011 | Codex | Route + validation. |
| M1-012 | Sonnet | WS + subscription bridge; non-trivial wiring. |
| M1-013 | Sonnet | Process lifecycle; ordering matters. |
| M1-014 | Sonnet | API client + reconnect logic. |
| M1-015 | Sonnet | UI wiring + state management; medium feature. |
| M1-016 | **Human** | **Platform-sensitive Rust + child process; verify on each target OS.** |
| M1-017 | Codex | Test writing against an existing API. |
| M1-018 | Codex | CI YAML. |
| M1-019 | Sonnet | Documentation pass; judgment on what to include. |
| M1-020 | Codex | Mirrors M1-010 pattern. |
| M1-021 | Codex | Small endpoint + schema. |
| M1-022 | **Human** | **Packaging is OS-specific; debug interactively.** |

Opus is not assigned because architectural decomposition is done in this document; no remaining M1 work warrants Opus reasoning.

---

## Recommended Review Gates

| Gate | After Task | Why |
|---|---|---|
| **Gate 1 — Daemon Loop Validated** | M1-012 | Confirm event/projection/transaction integrity and WS delivery before any UI is built on top. Run M1-017 tests early as a smoke check even if formal task lands later. Human review of M1-010 diff is REQUIRED. |
| **Gate 2 — End-to-End Loop Visible** | M1-015 | First moment the M1 fitness function is demonstrable. Manual scenario walk-through with the human before continuing. |
| **Gate 3 — Production-Like Lifecycle** | M1-016 | Verify daemon child process lifecycle on developer's target OS. Confirm no orphan processes. |
| **Gate 4 — Definition of Done** | M1-019 | Run the full Validation Strategy table from `docs/milestones/1.md` §15 against a fresh clone. Decide whether to attempt stretch tasks. |

Each gate should produce a short written checkpoint (in the task PR description or session memory) before proceeding.

---

## Execution Notes For AI Agents

- **Treat scope as a hard contract.** If a task tempts you to add adjacent work, stop and propose a follow-up task instead.
- **Run validation before claiming completion.** Each task lists deterministic commands or scenarios — execute them, paste the output, and only then mark complete.
- **Preserve the transactional ordering rule** (M1-010): event append + projection insert in one transaction; bus publish ONLY after commit. This invariant is the spine of every later milestone.
- **Do not introduce abstractions for absent systems.** No plugin loaders, no skill registries, no command bus, no storage providers. Those arrive in later milestones with concrete requirements.
- **Stretch tasks are optional.** Do not start them until baseline (M1-001 through M1-019) is green.
