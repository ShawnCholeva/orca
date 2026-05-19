# Orca — Milestone 4 Implementation Plan

**Source milestone:** `docs/milestones/4.md`
**Builds on:** `docs/implementation-plans/milestone-3.md` (M3 must be complete and green).
**Status:** Ready for AI-assisted execution.
**Scope guard:** Tasks below MUST NOT introduce memory extraction or promotion, session summaries, context assembly, prompt construction, role catalogs, task graphs, recommendations, workflow engines, command-center panels, global session dashboards, workspace indexing/scanning/file watching, generic adapter invocation endpoints (`POST /v1/adapters/:id/invoke`), adapter configuration UI, terminal multiplexers, tabs/panes, replay engines, transcript export, terminal search, command palettes, custom themes/keymaps, binary WebSocket migration, tmux/screen integration, process re-parenting, marketplace plugin loading, new sockets, new queues, new worker pools, new top-level packages, persisted input/resize/output domain events, `GET /v1/sessions`, `POST /v1/sessions/:id/input`, `POST /v1/sessions/:id/resize`, or `GET /v1/sessions/:id/output`. Any task requiring such code is out of scope for M4.

### Inherited constraints from M1 / M2 / M3 reviews

**DaemonContext seam (M1, reaffirmed M2/M3).** All new daemon use cases MUST be wired through the explicit `DaemonContext` (`{ db, bus, now, invokeSkill, inspectWorkspace, ... }`). M4 adds `ptyManager`, `adapterRegistry`, and `sessionOutputStore` as additional fields on `DaemonContext`. Production wiring stays in `apps/daemon/src/index.ts`; tests construct an explicit context per case. No DI framework, no container, no decorators.

**Sidecar surface freeze (M1, reaffirmed M2/M3).** `apps/daemon/scripts/build-sidecar.mjs`, `apps/daemon/src/sidecar-bootstrap.ts`, and the desktop spawn paths in `apps/desktop/src-tauri/src/lib.rs` are M4's narrow exception: the build script MUST be updated to copy the `node-pty` native artifact (M4-001 spike; M4-015 verification). All other sidecar/spawn behavior remains as established in earlier milestones.

**Registry immutability (M2).** The adapter registry registers descriptors before the HTTP listener accepts connections. M4 must not add hot-registration paths or mutate the registry after boot.

**Existing M1/M2/M3 wire shapes are frozen.** The M1 `POST /v1/goals` body, the M2 `goal.create` skill loop, and the M3 refined-Goal / multi-workspace endpoints, schemas, and event sequences MUST remain byte-identical. M4 only adds new endpoints, new event types, and new schemas; nothing existing is repurposed.

**Atomicity rule (carried forward).** Every M4 daemon write that emits domain events MUST insert events and projection rows inside the same SQLite transaction and broadcast on the event bus **only after** `COMMIT` returns.

**Native-import isolation (new).** Only `apps/daemon/src/pty/manager.ts` may `import` (or `require`) `node-pty`. All session usecases, tests, and other modules depend on the local `PtyManager` interface and the in-memory fake. Violating this isolation is grounds for a blocking review comment.

This document decomposes Milestone 4 (Embedded Sessions) into bounded executable tasks. Each task is sized for a single AI session, has explicit acceptance criteria, and is reviewable in isolation.

The single proof point for M4 is:

```text
User opens a refined Goal with attached workspaces
  -> creates a manual session
  -> chooses a workspace and adapter
  -> optionally enters role and short instruction
  -> daemon validates Goal, workspace, and adapter id
  -> daemon commits session row and lifecycle event in one SQLite transaction
  -> daemon launches one PTY in the selected workspace
  -> adapter provides command, args, env, cwd only
  -> desktop renders one embedded xterm.js terminal
  -> user sends input and resize over the existing WebSocket
  -> daemon streams PTY output over the existing WebSocket
  -> daemon stores a capped output tail outside the general event store
  -> daemon records exit/stop/failure lifecycle events
  -> session metadata and output tail survive daemon restart
```

---

## Conventions

- **Task ID:** `M4-NNN` (zero-padded, sequenced for default execution order).
- **Affected Areas:** paths relative to repo root.
- **Validation Steps:** every task lists at least one deterministic command or scenario.
- **No task may exceed its declared scope** even if adjacent work seems easy — additive scope belongs in a follow-up task.
- **Full-suite gates:** `pnpm -r typecheck` and `pnpm -r test` run at M4-011 (real-shell vertical slice) and M4-016 (final). Targeted tests run inside every other task.
- **Native-module isolation rule:** all references to `node-pty` outside `apps/daemon/src/pty/manager.ts` are forbidden, including type-only imports.
- **Post-commit broadcast rule:** every lifecycle transition inserts event + updates `sessions` in a single SQLite transaction; the bus is fed only after `COMMIT`.
- **Output isolation rule:** terminal output is persisted only in `session_output_chunks`. It must never enter the general event store. Input and resize are never persisted.

---

## Tasks

---

### M4-000 — Baseline Verification

**Purpose.** Lock in a known-good M1/M2/M3 baseline before any M4 change lands. Establishes the regression anchor so every later M4 failure is unambiguously attributable to M4 work, and so M4-011 / M4-016 can compare against a recorded green state.

**Scope.**
- IS: install, typecheck, run tests, record commit SHA and test summary, verify the named regression anchors exist.
- IS NOT: any code change, dependency upgrade, new test, doc edit, or migration.

**Requirements.**
- From a clean working tree, run:
  - `pnpm install --frozen-lockfile`
  - `pnpm -r typecheck`
  - `pnpm -r test`
- Confirm the following named tests appear in the test summary as PASS:
  - `apps/daemon/test/m1-017.integration.test.ts`
  - `apps/daemon/src/m2-loop.test.ts`
  - `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts`
- Record in implementation notes / PR description:
  - `git rev-parse HEAD`
  - Date / time
  - One-line test-result summary.

**Affected Areas.** None (read-only verification).

**Dependencies.** None.

**Acceptance Criteria.**
- Baseline SHA recorded.
- M1, M2, and M3 named tests all observed as PASS.
- Working tree is clean at the recorded SHA (`git status` reports no changes).

**Validation Steps.**
- `git status` → clean.
- `pnpm -r typecheck` → exit 0.
- `pnpm -r test` → exit 0, with M1/M2/M3 named tests present.

**Risks / Notes.**
- If baseline is red, do **not** begin M4-001 — investigate upstream first. Do not commit anything in this task.

---

### M4-001 — Native PTY Feasibility and Sidecar Spike

**Purpose.** Verify that `node-pty` can be installed, imported, and used to spawn a trivial PTY on the supported M4 target, and that the existing sidecar build flow can in principle bundle the native artifact. This is a discovery task: it gates every other M4 task and unblocks broad session work only after the native-module story is known to hold.

**Scope.**
- IS: add `node-pty` as a daemon dependency in `apps/daemon/package.json`, write a scratch script that imports `node-pty`, spawns a short-lived process, observes output, and exits cleanly; perform a sidecar dry-run that copies the native artifact into the sidecar runtime tree; document target triples and prebuilds observed.
- IS NOT: any production session, adapter, projection, or wire-protocol code; no permanent CLI; no contracts; no migration; no desktop work.

**Requirements.**
- Add `node-pty` to `apps/daemon/package.json` `dependencies` at a version with prebuilds for the M4 supported target (currently linux-x64 / linux-arm64 / darwin-arm64 — record actuals).
- Create `apps/daemon/scripts/m4-001-pty-spike.mjs` (will be deleted at end of task) that:
  - Imports `node-pty`.
  - Spawns `/bin/sh -c "echo orca-pty-ok && exit 0"` (POSIX) via PTY.
  - Captures `data` events to stdout.
  - Resolves cleanly when `exit` fires.
- Perform a sidecar dry-run: run the existing `build-sidecar.mjs` flow against a copy of `apps/daemon` and confirm the native `.node` artifact can be located. Capture which files must be copied. Do NOT yet modify `build-sidecar.mjs` for production — that change is M4-015.
- Record findings in a short note under `docs/implementation-plans/notes/m4-001-pty-feasibility.md`:
  - `node-pty` version chosen
  - target triple(s) verified
  - artifact path(s) inside `node_modules/node-pty`
  - any rebuild step required
  - go/no-go decision for proceeding to M4-002.

**Affected Areas.**
- `apps/daemon/package.json` (+ lockfile).
- `apps/daemon/scripts/m4-001-pty-spike.mjs` (scratch; removed before merge if desired, but its findings note stays).
- `docs/implementation-plans/notes/m4-001-pty-feasibility.md`.

**Dependencies.** M4-000.

**Acceptance Criteria.**
- `pnpm install` succeeds; `node-pty` is present.
- The spike script prints `orca-pty-ok` and exits 0 on the M4 supported local target.
- Sidecar dry-run identifies the exact files needed to ship `node-pty` (this informs M4-015 — no production change yet).
- Findings note exists and contains a clear go/no-go.

**Validation Steps.**
- `pnpm --filter @orca/daemon install` → exit 0.
- `node apps/daemon/scripts/m4-001-pty-spike.mjs` → prints `orca-pty-ok`, exits 0.
- Manual review of the dry-run output and findings note.

**Risks / Notes.**
- If prebuilds are unavailable, resolve packaging strategy here — do **not** proceed past Gate 1 with a broken native install.
- Do not yet import `node-pty` from any production module — that is M4-005.
- Windows is best-effort; M4 only requires the primary local target to pass.

---

### M4-002 — Contracts for M4 Sessions, Adapters, Events, and WebSocket Frames

**Purpose.** Establish the shared wire contracts before daemon or desktop code depends on them. The contracts package is the single source of truth that both ends of the local IPC must agree on. This task unlocks typed shapes for the new endpoints, the new domain event types, and the new WebSocket frames.

**Scope.**
- IS: extend `DomainEventType`; add session/adapter schemas; add request/response schemas for the kept HTTP endpoints; add WS frame schemas; add a structured error-code union for session/adapter failures; round-trip parse tests.
- IS NOT: daemon code, DB code, desktop code; no internal PTY/adapter spawn types; no `GET /v1/sessions`; no `/input`, `/resize`, or `/output` HTTP shapes; no memory/context/task/recommendation/workflow schemas.

**Requirements.**
- File: `packages/contracts/src/index.ts`.
- Extend `DomainEventType` (append in this order; do not reorder existing literals): `"session.created"`, `"session.started"`, `"session.exited"`, `"session.failed"`, `"session.stopped"`. Optional `"session.archived"` if archive is retained (see M4-006).
- Add:
  - `SessionStatus = z.enum(["created", "starting", "running", "exited", "failed", "stopped", "archived"])`.
  - `SessionFailureReason = z.enum(["command_not_found", "workspace_unavailable", "spawn_failed", "daemon_restart", "internal_error"])`.
  - `AdapterId = z.enum(["shell-manual", "claude-code", "opencode", "codex"])` (strict; no marketplace ids).
  - `AdapterAvailabilityStatus = z.enum(["available", "unavailable", "unknown"])`.
  - `AdapterSummary = z.object({ id: AdapterId, title: z.string(), availability: AdapterAvailabilityStatus, detail: z.string().optional() })`.
  - `ListAdaptersResponse = z.object({ adapters: z.array(AdapterSummary) })`.
  - `SessionSummary = z.object({ id, goalId, workspaceId, adapterId: AdapterId, role: z.string().nullable(), title: z.string(), status: SessionStatus, createdAt, startedAt: z.string().nullable(), exitedAt: z.string().nullable() })`.
  - `SessionDetail = SessionSummary.extend({ instruction: z.string().nullable(), pid: z.number().nullable(), command: z.string().nullable(), args: z.array(z.string()).nullable(), cwd: z.string().nullable(), terminalCols: z.number().nullable(), terminalRows: z.number().nullable(), exitCode: z.number().nullable(), exitSignal: z.string().nullable(), failureReason: SessionFailureReason.nullable(), failureDetail: z.string().nullable(), archivedAt: z.string().nullable() })`.
  - `SessionOutputSnapshot = z.object({ sessionId: z.string(), firstByteOffset: z.number().int().nonnegative(), nextSeq: z.number().int().nonnegative(), totalBytesKept: z.number().int().nonnegative(), chunks: z.array(z.object({ seq: z.number().int().nonnegative(), byteOffset: z.number().int().nonnegative(), dataBase64: z.string() })) })`.
  - `CreateSessionRequest = z.object({ workspaceId: z.string().min(1), adapterId: AdapterId, role: z.string().trim().max(100).optional(), instruction: z.string().max(4000).optional(), title: z.string().trim().min(1).max(200).optional() }).strict()`.
  - `CreateSessionResponse = z.object({ session: SessionDetail })`.
  - `ListSessionsResponse = z.object({ sessions: z.array(SessionSummary) })` (used only by `GET /v1/goals/:goalId/sessions`).
  - `GetSessionResponse = z.object({ session: SessionDetail, output: SessionOutputSnapshot })`.
  - `StartSessionRequest = z.object({ terminalCols: z.number().int().positive().max(1000), terminalRows: z.number().int().positive().max(1000) }).strict()`.
  - `StartSessionResponse = z.object({ session: SessionDetail })`.
  - `StopSessionRequest = z.object({}).strict()` (placeholder for future grace flag).
  - `StopSessionResponse = z.object({ session: SessionDetail })`.
  - If archive retained: `ArchiveSessionRequest`, `ArchiveSessionResponse` mirroring stop.
- Add WebSocket frame schemas (under a `SessionWs` namespace or as flat schemas — pick one and be consistent):
  - Client → daemon:
    - `SessionSubscribeFrame = z.object({ type: z.literal("session.subscribe"), sessionId: z.string().min(1) }).strict()`.
    - `SessionUnsubscribeFrame = z.object({ type: z.literal("session.unsubscribe"), sessionId: z.string().min(1) }).strict()`.
    - `SessionInputFrame = z.object({ type: z.literal("session.input"), sessionId: z.string().min(1), dataBase64: z.string().min(1) }).strict()`.
    - `SessionResizeFrame = z.object({ type: z.literal("session.resize"), sessionId: z.string().min(1), cols: z.number().int().positive().max(1000), rows: z.number().int().positive().max(1000) }).strict()`.
  - Daemon → client:
    - `SessionOutputFrame = z.object({ type: z.literal("session.output"), sessionId: z.string(), seq: z.number().int().nonnegative(), byteOffset: z.number().int().nonnegative(), dataBase64: z.string() }).strict()`.
    - `SessionErrorFrame = z.object({ type: z.literal("session.error"), sessionId: z.string().optional(), code: z.enum(["unknown_session", "not_active", "invalid_message"]), message: z.string() }).strict()`.
- Add round-trip parse tests in `packages/contracts/src/index.test.ts`:
  - Each schema parses a happy fixture.
  - Each strict schema rejects an extra unknown field.
  - `AdapterId` rejects unknown adapters.
  - `SessionStatus` rejects unknown statuses.
  - `DomainEventType` includes the new literals in the documented order.

**Affected Areas.**
- `packages/contracts/src/index.ts`.
- `packages/contracts/src/index.test.ts`.

**Dependencies.** M4-000. (M4-001 should be green; not a hard build dependency for contracts.)

**Acceptance Criteria.**
- All new schemas parse their happy fixture and reject removed/extra fields where `.strict()` applies.
- No internal PTY type leaks into contracts (no `IPty`, no `node-pty` import).
- `pnpm --filter @orca/contracts typecheck` and `pnpm --filter @orca/contracts test` pass.

**Validation Steps.**
- `pnpm --filter @orca/contracts typecheck` → exit 0.
- `pnpm --filter @orca/contracts test` → exit 0; new test cases present.
- `grep -R "node-pty" packages/contracts/src` → no matches.

**Risks / Notes.**
- Keep adapter ids as a closed enum in M4 — it constrains the registry and prevents accidental external-plugin surface area.
- Do not include adapter spawn shapes (`command`, `args`, `env`, `cwd`) in the public contracts — those are daemon-internal.

---

### M4-003 — Migration `0004_sessions.sql`

**Purpose.** Land the only two new tables M4 requires (`sessions`, `session_output_chunks`) and the indexes that make per-Goal listing and per-session output replay cheap. Persistence must be in place before any projection helper or usecase can compile.

**Scope.**
- IS: a new migration file, migration tests for fresh DB / M3-upgrade / idempotent replay, FK behavior, index presence.
- IS NOT: any helper, projection, usecase, or route code; no seed data; no changes to existing tables.

**Requirements.**
- File: `apps/daemon/src/migrations/0004_sessions.sql` (or the project's existing migration directory convention — match M3's `0003_*` placement exactly).
- Tables:
  ```sql
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    role TEXT,
    instruction TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    pid INTEGER,
    command TEXT,
    args_json TEXT,
    cwd TEXT,
    terminal_cols INTEGER,
    terminal_rows INTEGER,
    exit_code INTEGER,
    exit_signal TEXT,
    failure_reason TEXT,
    failure_detail TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    exited_at TEXT,
    archived_at TEXT,
    output_seq INTEGER NOT NULL DEFAULT 0,
    output_bytes_kept INTEGER NOT NULL DEFAULT 0,
    output_offset_first INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_sessions_goal_created
    ON sessions(goal_id, created_at DESC);

  CREATE INDEX idx_sessions_goal_status
    ON sessions(goal_id, status);

  CREATE TABLE session_output_chunks (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL,
    byte_length INTEGER NOT NULL,
    written_at TEXT NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (session_id, seq),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_session_output_session_seq
    ON session_output_chunks(session_id, seq);
  ```
- Migration must be idempotent (re-running against an already-migrated DB is a no-op).
- Migration test cases in `apps/daemon/src/migrations.test.ts` (extend existing pattern):
  - Fresh DB: migrations apply cleanly; both new tables and all three indexes exist.
  - M3-upgrade: a DB with only `0001`/`0002`/`0003` migrates to `0004` without error.
  - Idempotent replay: applying the migration twice does not error.
  - FK behavior: deleting a `goals` row cascades to `sessions`; deleting a `workspaces` row that still has sessions is RESTRICTed.
  - FK behavior: deleting a `sessions` row cascades to `session_output_chunks`.

**Affected Areas.**
- `apps/daemon/src/migrations/0004_sessions.sql` (path matches M3 convention).
- `apps/daemon/src/migrations.ts` (only if a manifest array needs updating).
- `apps/daemon/src/migrations.test.ts`.

**Dependencies.** M4-000, M4-002 (so the schema field set matches contract shapes).

**Acceptance Criteria.**
- Both tables and all three indexes present in `sqlite_master` after migration.
- FK ON DELETE CASCADE/RESTRICT behaviors verified by test.
- No changes to existing tables, indexes, or earlier migration files.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- migrations.test.ts` → exit 0; new tests present.
- Manual `PRAGMA index_list('sessions')` / `PRAGMA index_list('session_output_chunks')` inspection (optional but recommended).

**Risks / Notes.**
- Do not add memory, summary, context, task, recommendation, workflow, pane/tab, or transcript columns — they belong to later milestones.
- Keep `args_json` as `TEXT`; serialize when writing.
- `output_offset_first` advances when oldest chunks are deleted under the cap; default `0` for new sessions.

---

### M4-004 — Adapter Command Resolver, Adapters, and Internal Registry

**Purpose.** Implement the four M4 adapters as pure spawn factories and the internal adapter registry that lists them. Adapters resolve only `{ command, args, env, cwd }`; they do not touch DB, events, PTY handles, streaming, output, summaries, memory, or prompts. This is a runtime-independent layer that session usecases will consume.

**Scope.**
- IS: `apps/daemon/src/adapters/{types,resolve,registry,shell-manual,claude-code,opencode,codex}.ts`; adapter unit tests; registry registration in `apps/daemon/src/registry/bootstrap.ts`.
- IS NOT: any session row write; any PTY spawn; any HTTP route; any WebSocket; any CLI-specific argv flags for agent adapters.

**Requirements.**
- `adapters/types.ts`:
  ```ts
  export interface AdapterSpawnInput {
    goalId: string;
    sessionId: string;
    workspacePath: string;
    role?: string;
    instruction?: string;
  }
  export interface AdapterSpawnResult {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }
  export type AdapterAvailability =
    | { status: "available"; detail?: string }
    | { status: "unavailable"; detail: string }
    | { status: "unknown" };
  export interface AgentAdapter {
    id: "shell-manual" | "claude-code" | "opencode" | "codex";
    title: string;
    resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult>;
    probeAvailability(): Promise<AdapterAvailability>;
  }
  ```
- `adapters/resolve.ts`:
  - `resolveBinary(candidates: string[]): Promise<{ resolvedPath: string } | { error: "not_found"; tried: string[] }>` — checks each candidate (absolute path → `fs.access` X_OK; bare name → walk `PATH`).
  - Pure-ish: takes `env` and `fs` capabilities as injectable args for testability.
- Adapters (one file each):
  - `shell-manual.ts`:
    - Candidates: `process.env.ORCA_SHELL` → `process.env.SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh` (POSIX); `process.env.ORCA_SHELL` → `process.env.COMSPEC` → `cmd.exe` (Windows best-effort).
    - `args` empty; `env` inherits PATH + adds `ORCA_GOAL_ID`, `ORCA_SESSION_ID`, and (when present) `ORCA_ROLE`, `ORCA_INSTRUCTION`.
    - `cwd` = `workspacePath`.
  - `claude-code.ts`: `ORCA_CLAUDE_CODE_BIN` → `claude`; `args` empty; `env` includes `ORCA_GOAL_ID`/`ORCA_SESSION_ID`; no prompt flags.
  - `opencode.ts`: `ORCA_OPENCODE_BIN` → `opencode`; same shape.
  - `codex.ts`: `ORCA_CODEX_BIN` → `codex`; same shape.
- `adapters/registry.ts`:
  - In-memory `Map<AdapterId, AgentAdapter>` populated at bootstrap.
  - `list(): AdapterSummary[]` — calls `probeAvailability()` lazily (caches per-process; recompute on miss is acceptable; no scheduled probes).
  - `get(id): AgentAdapter | undefined`.
- Wire registry into `apps/daemon/src/registry/bootstrap.ts` so the four adapters are registered before HTTP listen.
- Tests in `apps/daemon/src/adapters/*.test.ts`:
  - `resolveBinary`: PATH hit; PATH miss; env override hit; env override miss; absolute-path hit; absolute-path missing X_OK.
  - `shell-manual`: env override beats `SHELL`; falls back to `/bin/sh` when neither set; emits expected `env` keys; `cwd` matches input.
  - Each agent adapter: env override beats default; missing binary yields `probeAvailability().status === "unavailable"` with a useful `detail`.
  - Registry: lists exactly the four ids; `get("unknown" as any)` returns undefined.
  - No adapter test imports `node-pty`.

**Affected Areas.**
- `apps/daemon/src/adapters/` (new directory).
- `apps/daemon/src/registry/bootstrap.ts` (registration only).
- `apps/daemon/src/registry/bootstrap.test.ts` (assert adapters registered).

**Dependencies.** M4-002 (uses `AdapterId`, `AdapterSummary`).

**Acceptance Criteria.**
- `pnpm --filter @orca/daemon test -- adapters` passes.
- Bootstrap registers all four adapters before HTTP listen.
- No `node-pty` import in any adapter file or test.
- `args` is always an array; no shell strings; no quoting hazards.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- adapters` → exit 0.
- `grep -R "node-pty" apps/daemon/src/adapters` → no matches.
- `grep -R "execSync\\|spawn(" apps/daemon/src/adapters` → no real-process spawns (resolver only inspects PATH; it does not execute candidates).

**Risks / Notes.**
- Do not introduce CLI-specific prompt flags for Claude Code, opencode, or codex in M4. The instruction is exposed only via env vars for shell/manual; agent adapters receive it via env too but never as argv.
- `probeAvailability` must be cheap and never block boot — keep it lazy.

---

### M4-005 — PTY Wrapper With Fake

**Purpose.** Encapsulate `node-pty` behind a single daemon-local wrapper with a stable interface and an in-memory fake. All session usecases depend on the interface; only this module imports the native package. This is the foundation that makes the rest of M4 testable without spawning real processes.

**Scope.**
- IS: `apps/daemon/src/pty/{types,manager,fake}.ts`; unit tests for the fake; one guarded real-PTY smoke test.
- IS NOT: any session row write; any WebSocket; any HTTP route; any usecase.

**Requirements.**
- `pty/types.ts`:
  ```ts
  export interface PtyStartOptions {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  }
  export interface PtyHandle {
    readonly pid: number;
    write(data: Buffer): void;       // takes raw bytes (Buffer); callers decode base64 once at the edge
    resize(cols: number, rows: number): void;
    kill(signal?: "SIGTERM" | "SIGKILL"): void;
  }
  export interface PtyEvents {
    onData(handler: (chunk: Buffer) => void): () => void;
    onExit(handler: (exit: { exitCode: number | null; signal: string | null }) => void): () => void;
  }
  export interface PtyManager {
    start(opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents };
  }
  ```
- `pty/manager.ts`:
  - Implements `PtyManager` using `node-pty`.
  - **Only file in the repo allowed to import `node-pty`.**
  - Translates `node-pty` events into `PtyEvents`.
  - On error during spawn, throws a tagged error: `{ name: "PtySpawnError", code: "command_not_found" | "spawn_failed", cause }`.
- `pty/fake.ts`:
  - In-process simulator: provides a `FakePtyManager` plus a `controlFakePty(handle)` helper for tests to inject output and exit.
  - Tracks all live handles; resets between tests.
  - Never imports `node-pty`.
- Tests:
  - `pty/fake.test.ts`: simulate output → handlers receive bytes; simulate exit → handler fires once; `kill("SIGKILL")` triggers immediate exit; `write` after exit is a no-op (does not throw).
  - `pty/manager.smoke.test.ts` (guarded by env, e.g. `ORCA_RUN_REAL_PTY=1`): spawn `sh -c "echo orca && exit 0"`, observe output, observe exit code 0.

**Affected Areas.**
- `apps/daemon/src/pty/` (new directory).
- `apps/daemon/src/pty/fake.test.ts`.
- `apps/daemon/src/pty/manager.smoke.test.ts` (skipped by default; runs under the env flag).

**Dependencies.** M4-001 (native install proven).

**Acceptance Criteria.**
- `pnpm --filter @orca/daemon test -- pty/fake` passes.
- `grep -R "from \"node-pty\"\\|require(\"node-pty\")" apps/daemon/src` returns exactly one match: `pty/manager.ts`.
- The real smoke test, when enabled, prints the expected output and exits 0.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- pty/` → exit 0.
- `ORCA_RUN_REAL_PTY=1 pnpm --filter @orca/daemon test -- pty/manager.smoke` → exit 0 (manual / CI-optional).
- `grep` invariant above.

**Risks / Notes.**
- Keep the wrapper minimal — no buffering, no chunk coalescing, no output rate-limiting; those are session-runtime concerns.
- Handlers must be detachable; return disposers from `onData` / `onExit`.
- The fake must never accept a `node-pty` type — its interface is `PtyHandle`/`PtyEvents` only.

---

### M4-006 — Session Projection and Create/List/Detail Without PTY Start

**Purpose.** Persist session rows and emit `session.created` before any PTY logic is wired in. This proves the projection, transaction boundary, and HTTP surface in isolation. Once green, every downstream task layers behavior on a stable foundation.

**Scope.**
- IS: `sessions/projection.ts`, `sessions/errors.ts`, `sessions/usecases.ts` (create/list/detail only), `GET /v1/adapters`, `POST /v1/goals/:goalId/sessions`, `GET /v1/goals/:goalId/sessions`, `GET /v1/sessions/:id`; integrate optional `POST /v1/sessions/:id/archive` only if archive remains in scope (decision recorded in PR description).
- IS NOT: start/stop usecases or routes; no PTY interaction; no WebSocket; no output streaming.

**Requirements.**
- `sessions/errors.ts`: structured error class hierarchy with codes `goal_not_found`, `goal_archived`, `workspace_not_found`, `workspace_not_attached`, `workspace_unavailable`, `adapter_not_found`, `session_not_found`. Map to HTTP 400/404/409/422 in the route layer.
- `sessions/projection.ts`:
  - `insertSession(tx, row)` — `tx` is a sqlite transaction handle.
  - `listSessionsByGoal(db, goalId): SessionSummary[]` (ordered by `created_at DESC`).
  - `getSessionDetail(db, sessionId): SessionDetail | null`.
  - `setSessionStatus(tx, sessionId, status, fields?)` for later use; safe no-op write only of provided fields.
- `sessions/usecases.ts`:
  - `createSession(ctx, { goalId, workspaceId, adapterId, role?, instruction?, title? })`:
    - Validate goal exists and is not archived.
    - Validate workspace exists and is attached to that goal.
    - Validate `fs.access(workspace.path)` succeeds.
    - Validate adapter id resolves in registry.
    - Compute title fallback: `${adapterId} session` if not provided.
    - In a single SQLite transaction: insert `sessions` row with status `"created"`; insert `session.created` event with payload `{ sessionId, goalId, workspaceId, adapterId }`.
    - After COMMIT: broadcast event on the bus.
    - Return `SessionDetail` with empty `SessionOutputSnapshot` placeholder (output store from M4-007 not yet integrated — use `{ chunks: [], nextSeq: 0, firstByteOffset: 0, totalBytesKept: 0 }`).
  - `listSessionsForGoal(ctx, goalId)`.
  - `getSession(ctx, sessionId)` — returns detail; if M4-007 has landed, includes a tail snapshot, otherwise the empty snapshot above.
- HTTP wiring (extend `apps/daemon/src/server.ts` or extract `sessions/routes.ts` if size demands; do not introduce a router framework):
  - `GET /v1/adapters` → calls registry → `ListAdaptersResponse`.
  - `POST /v1/goals/:goalId/sessions` → `CreateSessionRequest` → `CreateSessionResponse`. 404 on goal_not_found; 409 on goal_archived; 422 on adapter/workspace problems; 400 on schema failure.
  - `GET /v1/goals/:goalId/sessions` → `ListSessionsResponse`.
  - `GET /v1/sessions/:id` → `GetSessionResponse` (404 if missing).
  - Optional `POST /v1/sessions/:id/archive` only if archive retained.
- Unit + integration tests:
  - `sessions/usecases.test.ts`: happy create; rejects archived goal; rejects wrong workspace/goal pair; rejects unreadable workspace path; rejects unknown adapter; broadcasts post-commit (assert bus call comes after COMMIT).
  - `sessions/projection.test.ts`: insert + read round-trip; list order by created_at desc; detail null on missing.
  - `server.test.ts`: route smoke for the four endpoints; schema rejection of unknown fields (strict).

**Affected Areas.**
- `apps/daemon/src/sessions/{projection,usecases,errors}.ts` (new).
- `apps/daemon/src/sessions/{projection,usecases}.test.ts` (new).
- `apps/daemon/src/server.ts` + `apps/daemon/src/server.test.ts`.
- `apps/daemon/src/index.ts` (wire `DaemonContext.adapterRegistry`).

**Dependencies.** M4-002, M4-003, M4-004.

**Acceptance Criteria.**
- All four (or five, with archive) endpoints return contract-shaped responses.
- `session.created` is emitted exactly once per successful create, post-commit only.
- Goal/workspace/adapter validation paths are covered by tests.
- Daemon restart preserves created sessions and their `session.created` events; relisting works.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- sessions` → exit 0.
- `pnpm --filter @orca/daemon test -- server` → exit 0.
- Optional curl smoke against a dev daemon to confirm response shapes.

**Risks / Notes.**
- Do not start a PTY here — `status` cannot leave `"created"` in this task.
- Keep `archived_at` writes optional behind the archive decision. If archive is dropped, do not write the field, do not add the route, do not emit `session.archived`.
- Confirm `DaemonContext` extension does not break M1/M2/M3 tests.

---

### M4-007 — Session Output Store and Tail Replay

**Purpose.** Implement the capped per-session output ring (chunk append + tail read + cap enforcement) before any live streaming depends on it. This is the only place session bytes are persisted, and it stays out of the general event store.

**Scope.**
- IS: `sessions/output-store.ts`; unit tests; integration into `getSession` detail snapshot.
- IS NOT: WebSocket plumbing; PTY integration; HTTP `/output` endpoint; transcript export.

**Requirements.**
- File: `apps/daemon/src/sessions/output-store.ts`.
- API:
  ```ts
  export interface SessionOutputStore {
    appendChunk(sessionId: string, data: Buffer): { seq: number; byteOffset: number };
    readTail(sessionId: string): SessionOutputSnapshot;
  }
  ```
- Semantics:
  - `appendChunk`:
    - Read current `sessions.output_seq`, `output_bytes_kept`, `output_offset_first` in a transaction.
    - Insert `(session_id, seq, byte_offset, byte_length, written_at, data)`.
    - Update `output_seq = seq + 1`, `output_bytes_kept = output_bytes_kept + data.length`.
    - Compute `byte_offset` = previous total bytes written (monotonic, never decreases).
    - Enforce cap (default 1 MiB; env-configurable via `ORCA_SESSION_OUTPUT_TAIL_BYTES`):
      - While `output_bytes_kept > cap`, delete the oldest whole chunk and subtract its `byte_length` from `output_bytes_kept`; advance `output_offset_first` to that deleted chunk's `byte_offset + byte_length`.
    - Single transaction; commit; return new seq + offset.
  - `readTail`:
    - Read all chunks for `session_id` ordered by `seq ASC`.
    - Return `{ sessionId, firstByteOffset: output_offset_first, nextSeq: output_seq, totalBytesKept: output_bytes_kept, chunks: [{ seq, byteOffset, dataBase64 }] }`.
- Wire into `getSession` so detail responses include the tail.
- Tests in `apps/daemon/src/sessions/output-store.test.ts`:
  - Append three chunks → `nextSeq` is 3; `byteOffset` increases monotonically; bytes sum to `totalBytesKept`.
  - Cap enforcement: with `ORCA_SESSION_OUTPUT_TAIL_BYTES=64`, append several 50-byte chunks → oldest chunks deleted whole; `firstByteOffset` advances; `totalBytesKept <= 64` after each append where possible.
  - Two sessions independent: appending to A does not affect B's tail.
  - No write to any event-store table (assert via SQL count of session-prefixed events unchanged).
  - `readTail` for unknown session returns empty snapshot with `firstByteOffset: 0`, `nextSeq: 0`.

**Affected Areas.**
- `apps/daemon/src/sessions/output-store.ts` (new).
- `apps/daemon/src/sessions/output-store.test.ts` (new).
- `apps/daemon/src/sessions/usecases.ts` (wire into `getSession`).
- `apps/daemon/src/config.ts` (read `ORCA_SESSION_OUTPUT_TAIL_BYTES`; default 1 MiB).

**Dependencies.** M4-003 (tables exist), M4-006 (use in detail).

**Acceptance Criteria.**
- Cap enforcement deletes whole chunks only; no partial chunk slicing.
- `output_offset_first`, `output_bytes_kept`, `output_seq` invariants hold across appends and deletes.
- No event-store writes occur from this module.
- Detail endpoint includes the tail snapshot.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- output-store` → exit 0.
- `pnpm --filter @orca/daemon test -- sessions/usecases` → still green.
- `grep -R "output.received\\|output.appended" apps/daemon/src` → no matches (output is never an event).

**Risks / Notes.**
- Cap must be measured in bytes, not chunks. Chunk sizes will vary.
- Never `UPDATE` an existing chunk row — always insert + (when needed) delete from the head.
- The cap is a soft post-condition: a single very large chunk may exceed the cap until the next append; document this explicitly.

---

### M4-008 — Session Start With Fake PTY

**Purpose.** Wire the start usecase end to end against the fake PTY, including adapter resolution, transactional `session.started` event, output capture into the output store, and lifecycle events for exit/failure. This is where create-only sessions become live (under test).

**Scope.**
- IS: `sessions/runtime.ts` (in-process registry of live PTY handles per session), `startSession` usecase, `POST /v1/sessions/:id/start` route, integration of adapter resolver + PTY wrapper + output store; lifecycle transitions for `starting → running → exited`/`failed`.
- IS NOT: stop semantics (M4-009); restart reconciliation (M4-009); WebSocket protocol (M4-010); real `node-pty` integration in tests (M4-011).

**Requirements.**
- `sessions/runtime.ts`:
  - `SessionRuntime` interface owns live `PtyHandle`s keyed by session id, plus subscriber list (subscribers added in M4-010).
  - `runtime.start(ctx, sessionId)`:
    1. Load session by id; reject if status is not `"created"`; reject if missing.
    2. Reload workspace + goal; revalidate `fs.access` of `workspace.path`. On failure → emit `session.failed` with `failure_reason = "workspace_unavailable"`; mark status `"failed"`; return.
    3. Resolve adapter via registry; if `probeAvailability` returns `unavailable` for an agent adapter, that surfaces in the UI but is **not** a hard block — the actual hard block is `resolveBinary` returning `not_found`. If the adapter's `resolveSpawn` throws or `resolveBinary` reports `not_found` → emit `session.failed` with `failure_reason = "command_not_found"`; mark status `"failed"`; return 422.
    4. In a single SQLite transaction: update `sessions` (`status = "starting"`, `command`, `args_json`, `cwd`, `terminal_cols`, `terminal_rows`); insert `session.started` event with `{ sessionId, goalId, pid: <known after spawn — see below>, cwd, terminalCols, terminalRows }`. **Spawn-before-event ordering note:** spawn the PTY first (so `pid` is known), then write the row + event in one tx; if the spawn fails, do not write `session.started` — instead write a `session.failed` event with `"spawn_failed"` and mark `"failed"`.
    5. After COMMIT of `session.started`: set `status = "running"` (separate small tx + projection update is acceptable; alternatively fold into the started tx if the runtime can guarantee the spawn handle is alive — pick one and document).
    6. Attach `onData(chunk)` → `outputStore.appendChunk(sessionId, chunk)` → broadcast `session.output` (broadcaster wired in M4-010; for M4-008 just persist).
    7. Attach `onExit({ exitCode, signal })` → in one tx: update `sessions` (`status = "exited"`, `exit_code`, `exit_signal`, `exited_at`); insert `session.exited` event; broadcast post-commit.
- `startSession(ctx, sessionId, { terminalCols, terminalRows })` is the thin usecase layer over `runtime.start`.
- HTTP: `POST /v1/sessions/:id/start` → 404 missing; 409 wrong-state; 422 command_not_found / workspace_unavailable / spawn_failed; 200 `StartSessionResponse`.
- Tests in `apps/daemon/src/sessions/usecases.test.ts`:
  - Happy path: create → start (fake spits "hello\n" then exits 0) → detail shows `status = "exited"`, `exit_code = 0`, `output.chunks` contains the bytes.
  - `command_not_found`: shell-manual with `ORCA_SHELL=/no/such/binary` → 422; `session.failed` persisted; status `"failed"`.
  - `workspace_unavailable`: rm or chmod the workspace dir → 422; `session.failed` persisted.
  - `spawn_failed`: fake throws on spawn → 422; `session.failed` persisted; no `session.started` event.
  - Event ordering: in a tx, the projection update and event insert commit together; bus.broadcast is invoked after COMMIT (assert mock call ordering).
  - Output is never written to the event store (count event rows with `type` like `session.output%` → 0).

**Affected Areas.**
- `apps/daemon/src/sessions/runtime.ts` (new).
- `apps/daemon/src/sessions/usecases.ts` (add `startSession`).
- `apps/daemon/src/sessions/usecases.test.ts`.
- `apps/daemon/src/server.ts` (route).
- `apps/daemon/src/index.ts` (wire `ctx.ptyManager`, `ctx.sessionOutputStore`, `ctx.sessionRuntime`).

**Dependencies.** M4-004, M4-005, M4-006, M4-007.

**Acceptance Criteria.**
- Start usecase emits exactly one of `session.started` or `session.failed` per call.
- On natural exit, exactly one `session.exited` event is emitted (no duplicate terminal events).
- Output chunks land in `session_output_chunks` only.
- Broadcasts occur only after the corresponding COMMIT.
- All listed failure modes return 422 with the documented `failure_reason`.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- sessions/usecases` → exit 0.
- `pnpm --filter @orca/daemon test -- server` → still green.
- `grep -R "node-pty" apps/daemon/src/sessions` → no matches.

**Risks / Notes.**
- Be deliberate about the spawn-vs-event order. The simplest safe rule: spawn first; if it throws, persist `session.failed`; if it succeeds, persist `session.started` with the known `pid`. Document the chosen ordering in `runtime.ts`.
- Backpressure / slow-consumer policy is a M4-010 concern; for now, `appendChunk` is always called inline.
- Do not yet introduce subscriber broadcasting — that comes with the WebSocket task.

---

### M4-009 — Stop and Restart Reconciliation

**Purpose.** Add user-initiated stop semantics and boot-time reconciliation. Stop must handle the natural-exit race so exactly one terminal lifecycle event is committed. Reconciliation must run before HTTP/WS accept traffic so the UI never sees a `running` session that has no live process.

**Scope.**
- IS: stop usecase + route; reconciliation routine called from daemon bootstrap.
- IS NOT: WebSocket plumbing; archive (already optional, decided in M4-006); desktop work.

**Requirements.**
- Stop semantics:
  - `runtime.stop(ctx, sessionId)`:
    - If session not in `"starting"`/`"running"` → 409.
    - Set internal `stopRequested = true` on the handle slot.
    - Call `handle.kill("SIGTERM")`; start a timer (default 5 s, env `ORCA_SESSION_STOP_GRACE_MS`).
    - On natural `onExit`: in one tx → update `sessions` (`status = "stopped"`, `exit_code`, `exit_signal`, `exited_at`); insert `session.stopped` event `{ sessionId, goalId, exitCode, exitSignal, reason: "user_request" }`; commit; broadcast.
    - On timer expiry without exit: `handle.kill("SIGKILL")`; the `onExit` handler then emits the single `session.stopped` event as above.
    - **Race rule:** the `onExit` handler must check `stopRequested` and choose between `session.stopped` (true) and `session.exited` (false). Exactly one terminal event is committed per terminal process.
- `POST /v1/sessions/:id/stop` → 200 `StopSessionResponse`; 404 missing; 409 wrong-state.
- Reconciliation:
  - `reconcileSessionsOnBoot(db, bus, now)`:
    - Before HTTP/WS listen, find all rows with `status IN ('starting', 'running')`.
    - For each, in one tx: update `status = "failed"`, `failure_reason = "daemon_restart"`, `exited_at = now`; insert `session.failed` event.
    - Commit all sessions; **then** broadcast events; **then** open HTTP/WS sockets.
- Tests:
  - `runtime` test: start → stop before natural exit → exactly one `session.stopped`; no `session.exited`.
  - Race: start → fake fires `onExit` (status 0) just as stop is called → exactly one terminal event (assertion: count of terminal events for this session == 1).
  - SIGKILL escalation: fake ignores SIGTERM → SIGKILL kills it → `session.stopped` committed once with the kill signal.
  - Reconciliation: seed DB with two `"running"` rows + one `"created"` + one `"exited"` → call reconciler → the two running rows become `"failed"` with `"daemon_restart"`; the others untouched.
  - Reconciliation timing: assert HTTP/WS listen is not invoked until reconciler resolves (use a sequencing mock).

**Affected Areas.**
- `apps/daemon/src/sessions/runtime.ts` (extend).
- `apps/daemon/src/sessions/usecases.ts` (`stopSession`).
- `apps/daemon/src/sessions/reconciliation.ts` (new, or fold into `runtime.ts` if small).
- `apps/daemon/src/index.ts` (call reconciler before `server.listen`).
- `apps/daemon/src/server.ts` (route).

**Dependencies.** M4-006, M4-007, M4-008.

**Acceptance Criteria.**
- Exactly one terminal lifecycle event per terminal process under all three scenarios (natural exit, user stop with timely SIGTERM, escalated SIGKILL).
- Reconciliation runs before HTTP/WS accepts traffic; assertions cover ordering.
- Stop is idempotent: a second stop call against an already-stopped session returns 409 and emits no additional events.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- sessions` → exit 0.
- `pnpm --filter @orca/daemon test -- reconciliation` (if separate file) → exit 0.

**Risks / Notes.**
- The race between user stop and natural exit is the most likely source of double events; covering it with an explicit `stopRequested` flag inside `runtime` is mandatory.
- Do not attempt to resume the process; reconciliation marks it failed and moves on.
- If running on a platform where SIGTERM is not honored by the spawned shell, document the local behavior — do not introduce per-OS hacks.

---

### M4-010 — WebSocket Terminal Protocol

**Purpose.** Extend the existing `/v1/events` JSON WebSocket with the minimal frame set required to subscribe to a session, push live output, and receive input/resize. This is the live channel that makes the terminal interactive. It must stay out of the domain event store and never persist input/resize.

**Scope.**
- IS: WS message handling for `session.subscribe` / `session.unsubscribe` / `session.input` / `session.resize`; outbound `session.output` / `session.error`; slow-consumer policy; subscriber lifecycle.
- IS NOT: a new socket; binary frames; HTTP `/input`/`/resize`/`/output`; persisted output/input/resize events.

**Requirements.**
- File: extend the existing WS handler under `apps/daemon/src/server.ts` (or its existing WS module). Do not add a new socket or path.
- Subscribers:
  - Per-session subscriber list lives in `sessions/runtime.ts`.
  - On `session.subscribe`: validate session exists; record the WS connection; send any backlog **via existing detail endpoint refetch on the client** (do not send tail on subscribe — the client fetches detail first; this keeps frame semantics simple).
  - On `session.unsubscribe`: remove WS from list; send no further frames.
  - On WS close / error: remove from all subscriber lists.
- Inbound:
  - `session.input`: decode `dataBase64` → `Buffer` → `runtime.write(sessionId, buf)` → `handle.write(buf)`. If session not running → respond with `session.error` `{ code: "not_active" }`. Never persist.
  - `session.resize`: validate `cols`/`rows`; only forward to handle if changed since last resize for that session (per-subscriber dedupe is fine); update `sessions.terminal_cols` / `terminal_rows` columns in a single tx **without** emitting a domain event. Never emit `session.resized`.
- Outbound:
  - `session.output`: emitted from the `onData` path. For each appended chunk → for each live subscriber → send `{ type: "session.output", sessionId, seq, byteOffset, dataBase64 }`. The chunk persisted via output store and the chunk broadcast over WS must share the same `seq`/`byteOffset`.
  - `session.error`: schema codes are `"unknown_session"`, `"not_active"`, `"invalid_message"`.
- Slow consumer:
  - Per-subscriber buffered-write threshold (e.g. `ORCA_SESSION_WS_BUFFER_LIMIT_BYTES`, default 1 MiB). If exceeded, close that subscriber's connection cleanly; do not back-pressure the PTY; do not retry persistence.
- Tests:
  - `apps/daemon/src/server.test.ts` (extend) or `apps/daemon/src/sessions/ws.test.ts`:
    - Subscribe → fake PTY emits data → subscriber receives `session.output` with matching `seq`/`byteOffset` to the persisted chunk.
    - Unsubscribe → no further frames after the next emit.
    - `session.input` reaches fake PTY (assert via fake's recorded writes).
    - `session.resize` updates `sessions.terminal_cols`/`terminal_rows` without inserting an event.
    - `session.input` against an exited session → `session.error` `{ code: "not_active" }`; no PTY write.
    - Unknown session id → `session.error` `{ code: "unknown_session" }`.
    - Malformed frame → `session.error` `{ code: "invalid_message" }`; connection stays open.
    - Slow-consumer policy: simulate non-draining subscriber; assert connection is closed after buffered amount exceeds limit; PTY keeps running; other subscribers unaffected.

**Affected Areas.**
- `apps/daemon/src/server.ts` (or its WS module).
- `apps/daemon/src/sessions/runtime.ts` (subscriber registry; broadcast hook).
- `apps/daemon/src/sessions/ws.test.ts` (or extended `server.test.ts`).
- `apps/daemon/src/config.ts` (`ORCA_SESSION_WS_BUFFER_LIMIT_BYTES`).

**Dependencies.** M4-007 (output store provides `seq`/`byteOffset`), M4-008 (runtime emits data), M4-009 (lifecycle stable).

**Acceptance Criteria.**
- `session.output` frames are emitted in monotonic `seq` order per session.
- `seq`/`byteOffset` on the WS frame equals the value returned by `outputStore.appendChunk`.
- No event rows are written for input/resize/output.
- No new socket and no binary frames are introduced.
- Slow-consumer disconnect does not block PTY writes or DB writes.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- server` → exit 0 (with new WS cases).
- `pnpm --filter @orca/daemon test -- sessions` → still green.
- `grep -R "session\\.input\\|session\\.resize\\|session\\.output" apps/daemon/src/events.ts` → no matches (these are not domain events).

**Risks / Notes.**
- Keep base64 encoding at the edges only — the output store stores raw `BLOB` bytes.
- Per-frame chunk size: prefer one chunk per `onData` call from `node-pty`; do not coalesce in M4 unless tests show pathological frame counts.
- On reconnect, the client fetches detail → resets `lastSeenSeq` → resubscribes; the daemon does not replay missed frames over WS.

---

### M4-011 — Real Shell Vertical Slice

**Purpose.** Prove the entire daemon-side loop end to end with the real `node-pty` shell adapter and a real (test-temp) workspace before any desktop UI code lands. This is the first gate that exercises native spawn + projection + WS + restart in one flow.

**Scope.**
- IS: one integration test that drives the daemon through the full shell loop; full-suite typecheck/test; brief manual daemon smoke.
- IS NOT: desktop code; sidecar build changes; agent adapter polish.

**Requirements.**
- Test file: `apps/daemon/test/m4-011-shell-vertical-slice.integration.test.ts`.
- The test:
  1. Spin up the daemon in-process (or via the existing integration harness from M3).
  2. Create a Goal + attach a temp directory workspace.
  3. `GET /v1/adapters` → assert `shell-manual` available.
  4. `POST /v1/goals/:id/sessions` with `adapterId: "shell-manual"`.
  5. Open WS, send `session.subscribe`.
  6. `POST /v1/sessions/:id/start` with `{ terminalCols: 80, terminalRows: 24 }`.
  7. Send `session.input` containing base64-encoded `"echo orca-vertical-slice && exit 0\n"`.
  8. Collect `session.output` frames until shell exits.
  9. Assert: at least one frame contains `"orca-vertical-slice"`; persisted output tail (via `GET /v1/sessions/:id`) contains the same bytes; terminal events appear in order `session.created` → `session.started` → `session.exited`; status is `"exited"`; `exit_code` is 0.
  10. Restart the daemon. Assert detail still returns the session; output tail bytes are still present.
  11. Optional but recommended: create a second session, start it (don't exit), restart the daemon, assert that on next boot the session is `"failed"` with `failure_reason = "daemon_restart"`.
- Full-suite gate: run `pnpm -r typecheck` and `pnpm -r test` and confirm exit 0.
- Manual daemon smoke: run the daemon, drive the same flow via curl + a tiny WS client (or the test harness); record results in PR.

**Affected Areas.**
- `apps/daemon/test/m4-011-shell-vertical-slice.integration.test.ts` (new).
- Possibly `apps/daemon/test/utils/` for shared harness helpers, if needed.

**Dependencies.** M4-005 (real PTY available), M4-008, M4-009, M4-010.

**Acceptance Criteria.**
- Integration test passes deterministically (one retry budget; flake means investigate, not retry-loop).
- Lifecycle events appear in the documented order; exactly one terminal event.
- Output tail survives a daemon restart.
- A previously running session is reconciled to `"failed"` with `"daemon_restart"` after restart.
- Full `pnpm -r typecheck` and `pnpm -r test` are green.

**Validation Steps.**
- `pnpm -r typecheck` → exit 0.
- `pnpm -r test` → exit 0; new integration test present and PASS.
- Manual smoke recorded in PR.

**Risks / Notes.**
- This is the riskiest task for native-platform variance. If the shell doesn't honor SIGTERM cleanly on the local target, document the behavior — do not paper over it.
- The integration test must not depend on a system-installed `claude`/`opencode`/`codex` — only the shell adapter.
- If timing flakes appear around `onExit` vs final `onData`, prefer to wait for `onExit` and then drain a small grace window before asserting output content.

---

### M4-012 — Desktop API Client and Goal Detail Sessions Panel

**Purpose.** Bring the embedded-session surface to the desktop. This task adds the desktop API client methods, the Sessions panel on the Goal detail view, the Create Session dialog, and the session list — all backed by mocked API/WS in tests. The terminal view itself comes in M4-013.

**Scope.**
- IS: `apps/desktop/src/api.ts` extensions; `apps/desktop/src/goal-detail/sessions/{SessionsPanel,CreateSessionDialog,SessionListItem,state}.tsx`; component tests with mocked fetch/WS; integration into the existing Goal detail screen.
- IS NOT: xterm integration (M4-013); global sessions store; route system; URL deep-linking; adapter configuration UI.

**Requirements.**
- API client (`apps/desktop/src/api.ts`):
  - `listAdapters(): Promise<ListAdaptersResponse>`.
  - `listSessions(goalId): Promise<ListSessionsResponse>`.
  - `getSession(sessionId): Promise<GetSessionResponse>`.
  - `createSession(goalId, body): Promise<CreateSessionResponse>`.
  - `startSession(sessionId, body): Promise<StartSessionResponse>`.
  - `stopSession(sessionId): Promise<StopSessionResponse>`.
  - Optional `archiveSession(sessionId)` only if archive retained.
  - Each method maps non-2xx responses into a tagged error type with `code` and `message`.
- Components (under `apps/desktop/src/goal-detail/sessions/`):
  - `SessionsPanel.tsx`: renders inside the existing Goal detail view; shows session list; create-session button; selection state for which session to display below; surfaces creation/start errors inline.
  - `CreateSessionDialog.tsx`:
    - Workspace selector populated from existing M3 attached workspaces.
    - Adapter selector populated from `GET /v1/adapters`; unavailable adapters show a tooltip with the `detail` and remain selectable (start will fail with a clear error).
    - Optional role + instruction fields (opaque strings; no schema beyond length limits).
    - Submit → create → on success, immediately call `startSession` with `terminalCols`/`terminalRows = 80/24` placeholders (the terminal view will resize later).
  - `SessionListItem.tsx`: shows id (short), adapter, workspace name, status badge, created time, stop button (if running/starting).
  - `state.ts` (optional): local reducer/hook for selection + per-session ephemeral status; no global store.
- Component tests under `apps/desktop/src/goal-detail/sessions/*.test.tsx`:
  - Empty state renders.
  - List state renders multiple sessions.
  - Create dialog validates: workspace required; adapter required; role/instruction within length limits.
  - Create + start happy path triggers both API calls.
  - Stop button calls `stopSession` and reflects status change on next list refresh.
  - Unavailable adapter shows the detail tooltip; user can still attempt start; surfaced error is `command_not_found` with the env-var override hint.
  - WS reconnect behavior is mocked here only to the extent the panel listens for `session.created`/`session.started`/`session.exited` to refresh the list — terminal subscribe/output is M4-013.

**Affected Areas.**
- `apps/desktop/src/api.ts` + `apps/desktop/src/api.test.ts`.
- `apps/desktop/src/goal-detail/sessions/` (new directory).
- `apps/desktop/src/goal-detail/` (mount the Sessions panel).
- Existing Goal detail tests (update to assert Sessions panel renders).

**Dependencies.** M4-002 (contracts), M4-011 (daemon ready).

**Acceptance Criteria.**
- Sessions panel renders for any refined Goal with attached workspaces.
- Create dialog enforces required fields and length limits client-side.
- Error display surfaces `command_not_found` and `workspace_unavailable` distinctly.
- No global session store; no route changes; no terminal UI yet.

**Validation Steps.**
- `pnpm --filter @orca/desktop typecheck` → exit 0.
- `pnpm --filter @orca/desktop test -- goal-detail/sessions` → exit 0.

**Risks / Notes.**
- Keep state local to the panel. Do not introduce Redux, Zustand, or context providers beyond the existing app conventions.
- Do not over-fetch: refresh the session list on lifecycle events (`session.created`, `session.started`, `session.exited`, `session.failed`, `session.stopped`) received over WS; otherwise rely on the user opening/closing the dialog.

---

### M4-013 — Desktop Terminal View (xterm.js)

**Purpose.** Add the single embedded xterm terminal view that completes the M4 product loop end to end. On mount it fetches the detail tail, subscribes over WS, forwards input/resize, and tears down cleanly on unmount.

**Scope.**
- IS: `SessionTerminalView.tsx`, `useSessionStream.ts`, xterm.js + fit addon dependency, mount/unmount cleanup, reconnect refetch behavior.
- IS NOT: tabs, panes, themes, keymaps, search, command palette, replay engine, transcript export, deep linking.

**Requirements.**
- Add `xterm` and `xterm-addon-fit` to `apps/desktop/package.json` `dependencies`.
- File: `apps/desktop/src/goal-detail/sessions/useSessionStream.ts`.
  - Takes `sessionId`.
  - On mount: `GET /v1/sessions/:id` → seed initial output (decode base64 chunks, write to xterm in `seq` order), record `lastSeenSeq = nextSeq`.
  - Open or join the existing WS; send `session.subscribe`.
  - On `session.output`: if `seq <= lastSeenSeq` → ignore; if `seq === lastSeenSeq` → write; if `seq > lastSeenSeq` → there is a gap → refetch detail tail once, reset `lastSeenSeq`, write subsequent frames.
  - On WS reconnect (existing app behavior): refetch detail tail; reset `lastSeenSeq`; re-send `session.subscribe`.
  - On unmount: send `session.unsubscribe`; remove listeners.
- File: `apps/desktop/src/goal-detail/sessions/SessionTerminalView.tsx`.
  - Mounts xterm + fit addon to a `<div ref>`.
  - Calls `useSessionStream(sessionId)`.
  - Wires xterm `onData` → base64-encode bytes → `session.input` frame.
  - Wires `ResizeObserver` + fit addon: on change, send `session.resize { cols, rows }` only when values change.
  - On unmount: dispose xterm, fit addon, resize observer; unsubscribe.
  - When session reaches a terminal status (`exited`/`failed`/`stopped`), input is disabled but output remains visible.
- Component tests with mocked WS:
  - Initial render writes the tail bytes once.
  - Live frame appends after tail.
  - Gap detection triggers a single detail refetch; no infinite loop.
  - Input from xterm triggers a `session.input` frame.
  - Resize triggers a `session.resize` frame only when dimensions change.
  - Unmount triggers `session.unsubscribe` and disposes xterm (assert no further frames on dispose).
- Manual smoke (Tauri dev or `apps/desktop` dev): open a refined Goal with one attached git repo or folder, create a shell-manual session, run `ls`, run `echo hello`, run an interactive command (e.g. `python3 -q` if available), then stop and reload.

**Affected Areas.**
- `apps/desktop/package.json` (+ lockfile).
- `apps/desktop/src/goal-detail/sessions/SessionTerminalView.tsx` (new).
- `apps/desktop/src/goal-detail/sessions/useSessionStream.ts` (new).
- Goal detail integration to render the terminal for the selected session.
- Component tests under `apps/desktop/src/goal-detail/sessions/`.

**Dependencies.** M4-010 (WS protocol), M4-012 (panel + selection).

**Acceptance Criteria.**
- Terminal renders for a running session and shows live output.
- Unmount disposes xterm; no orphan listeners (assert via dev tools or test mock).
- Gap-detection refetches detail exactly once per gap.
- Reconnect refetches and resubscribes deterministically.
- Manual smoke recorded in PR.

**Validation Steps.**
- `pnpm --filter @orca/desktop typecheck` → exit 0.
- `pnpm --filter @orca/desktop test -- SessionTerminalView` → exit 0.
- Manual Tauri/dev smoke per the steps above.

**Risks / Notes.**
- The xterm fit-addon resize observer is the most common source of resize loops. Debounce + compare against last sent dimensions to avoid spamming the WS.
- The terminal must be the only consumer of the WS for that session — do not also wire the panel to render output.
- On WS reconnect, the safe ordering is: refetch detail → reset seq → write tail → subscribe. The reverse leaks frames or duplicates them.

---

### M4-014 — Agent Adapter Polish

**Purpose.** Once the shell vertical slice is proven, verify the agent adapters (Claude Code, opencode, codex) resolve commands correctly and their unavailable paths produce clear UI errors. This task does not add CLI flags; it confirms that the spawn-only contract is sufficient for the three agent CLIs.

**Scope.**
- IS: targeted tests for `probeAvailability` happy/unavailable; one opt-in smoke per installed adapter (skipped if binary absent); UI verification that the adapter selector shows availability correctly.
- IS NOT: prompt construction; CLI argument flags; per-adapter session UX; adapter configuration.

**Requirements.**
- Tests in `apps/daemon/src/adapters/*.test.ts` (extend):
  - For each agent adapter: with the env override pointed at a fake script that prints `hello` and exits → `probeAvailability` reports `available` (if availability is determined by spawn-once; if it's PATH-only, then PATH resolution).
  - With override pointed at `/no/such/binary` → `probeAvailability` reports `unavailable` with a non-empty `detail`.
- Opt-in real smoke (guarded by `ORCA_REAL_ADAPTER_SMOKE_<ID>=1`): start each agent adapter in a tmp workspace, observe at least one byte of output, send the adapter's natural exit (typically Ctrl-D or `exit`), assert clean shutdown.
- Desktop check: open the Create Session dialog with all four adapters; if `claude`/`opencode`/`codex` are not installed, the items show `unavailable` with the env-override hint.

**Affected Areas.**
- `apps/daemon/src/adapters/{claude-code,opencode,codex}.test.ts`.
- Possibly small refinements to availability `detail` strings.
- Desktop dialog availability indicator (light polish only).

**Dependencies.** M4-013 (UI in place to verify visually).

**Acceptance Criteria.**
- Each agent adapter's availability paths are covered by tests.
- Real smoke (where binaries exist) passes.
- Unavailable adapters surface a clear hint in the desktop dialog.

**Validation Steps.**
- `pnpm --filter @orca/daemon test -- adapters` → exit 0 (with new cases).
- Optional `ORCA_REAL_ADAPTER_SMOKE_CLAUDE_CODE=1 pnpm --filter @orca/daemon test -- claude-code.smoke` → exit 0 when binary present.

**Risks / Notes.**
- Different agent CLIs have different startup banners and TTY expectations — keep assertions loose on output content.
- Do not add adapter-specific flags. If an agent CLI requires a flag to be useful, document the gap and defer it.

---

### M4-015 — Sidecar Packaging Verification

**Purpose.** Update the sidecar build script so `node-pty` ships with the bundled daemon and verify that the bundled runtime can `require('node-pty')` and spawn a trivial PTY on the supported M4 local target. This is the only acceptable modification to the sidecar surface in M4.

**Scope.**
- IS: minimal change to `apps/daemon/scripts/build-sidecar.mjs` to copy the `node-pty` native artifact into the sidecar output; a smoke script that exercises the bundled daemon.
- IS NOT: signed distribution; Windows packaging beyond best-effort; additional sidecar features.

**Requirements.**
- Update `apps/daemon/scripts/build-sidecar.mjs`:
  - During the existing copy step, also copy `node_modules/node-pty/build/Release/*.node` (or equivalent paths recorded in M4-001) plus required JS shims.
  - Verify the produced sidecar tree has the artifact at the expected relative path.
  - No change to how the desktop launches the sidecar.
- Smoke script `apps/daemon/scripts/m4-015-sidecar-smoke.mjs`:
  - Builds the sidecar (`pnpm --filter @orca/daemon build:sidecar` or equivalent).
  - Invokes the bundled daemon in a child process.
  - Drives the M4-011 shell flow against it (create Goal, attach workspace, create session, start, send `echo`, observe output, stop).
  - Exits 0 on success.
- Document the artifact path(s), per target, in `docs/implementation-plans/notes/m4-015-sidecar-packaging.md`.

**Affected Areas.**
- `apps/daemon/scripts/build-sidecar.mjs`.
- `apps/daemon/scripts/m4-015-sidecar-smoke.mjs` (new).
- `docs/implementation-plans/notes/m4-015-sidecar-packaging.md` (new).

**Dependencies.** M4-001, M4-011.

**Acceptance Criteria.**
- `pnpm --filter @orca/daemon build:sidecar` succeeds and produces a tree containing the `node-pty` native artifact.
- The smoke script runs end to end against the bundled daemon and exits 0.
- No change to the Tauri spawn path in `apps/desktop/src-tauri/src/lib.rs`.

**Validation Steps.**
- `pnpm --filter @orca/daemon build:sidecar` → exit 0; manual `ls` of the output confirms the artifact.
- `node apps/daemon/scripts/m4-015-sidecar-smoke.mjs` → exit 0.

**Risks / Notes.**
- The most common pitfall is mismatched ABI between the build-time Node and the bundled runtime Node. If `require('node-pty')` fails inside the bundle, rebuild the native module against the bundled Node version or use prebuilds matching that ABI.
- Windows packaging is best-effort; failing on Windows in M4 is acceptable if the supported local target is POSIX.

---

### M4-016 — Final Regression and Documentation

**Purpose.** Run the full automated suite, record a manual smoke, and update README and operation notes with the new endpoints, WebSocket frames, env vars, retention cap, and restart policy. This closes the milestone and locks the operational contract.

**Scope.**
- IS: full typecheck/test; manual shell full-loop record; doc updates (`README.md`, `docs/operation-flow/*` as appropriate); DoD checklist against `docs/milestones/4.md` §17.
- IS NOT: new code; new features; new tests beyond a final regression sweep.

**Requirements.**
- Run `pnpm -r typecheck` and `pnpm -r test`. All green.
- Manual smoke (recorded in PR): one refined Goal, one attached git repo or folder, shell/manual create/start/input/output/stop, then reload the daemon and confirm detail + tail persisted.
- Update `README.md` with a short "Sessions" section:
  - Endpoints kept: `GET /v1/adapters`, `POST /v1/goals/:goalId/sessions`, `GET /v1/goals/:goalId/sessions`, `GET /v1/sessions/:id`, `POST /v1/sessions/:id/start`, `POST /v1/sessions/:id/stop`, optional `POST /v1/sessions/:id/archive`.
  - WS frames: `session.subscribe`, `session.unsubscribe`, `session.input`, `session.resize`, `session.output`, `session.error`.
  - Env vars: `ORCA_SHELL`, `ORCA_CLAUDE_CODE_BIN`, `ORCA_OPENCODE_BIN`, `ORCA_CODEX_BIN`, `ORCA_SESSION_OUTPUT_TAIL_BYTES`, `ORCA_SESSION_STOP_GRACE_MS`, `ORCA_SESSION_WS_BUFFER_LIMIT_BYTES`.
  - Retention: per-session output tail cap (default 1 MiB; oldest whole chunks deleted on overflow).
  - Restart policy: `starting`/`running` sessions on boot become `failed` with `daemon_restart` before HTTP/WS listen; no process resumption.
- Update `docs/operation-flow/` (if applicable) to reference the new session loop.
- Run through the 20-point DoD list in `docs/milestones/4.md` §17 and confirm each item; record outcomes in the PR.

**Affected Areas.**
- `README.md`.
- `docs/operation-flow/*` (as applicable).
- Possibly `docs/implementation-plans/milestone-4.md` (this doc) — add a "completion notes" appendix.

**Dependencies.** M4-011, M4-013, M4-014, M4-015.

**Acceptance Criteria.**
- Full `pnpm -r typecheck` and `pnpm -r test` exit 0.
- All 20 DoD points confirmed; any deviations explicitly recorded.
- README/operation docs accurately reflect the implementation.
- No new top-level package; no forbidden surface introduced (see §Scope guard at top).

**Validation Steps.**
- `pnpm -r typecheck` → exit 0.
- `pnpm -r test` → exit 0.
- Manual smoke recorded.
- DoD checklist filled.

**Risks / Notes.**
- This is the final scope-guard pass. If any task added a forbidden surface (e.g., `GET /v1/sessions`, `POST /v1/sessions/:id/input`, memory tables, marketplace loading), reject the diff and reopen the relevant task.
- Documentation drift is the biggest risk here — verify each endpoint/frame/env var against actual code, not against this plan.

---

## Deliverable 1 — Task Dependency Graph

```text
M4-000  Baseline verification
  |
  v
M4-001  Native PTY feasibility + sidecar spike        <- Gate 1
  |
  v
M4-002  Contracts
  |
  +--> M4-003  Migration                              <- Gate 2 (after 003)
  |       |
  |       v
  |     M4-004  Adapter resolver + adapters + registry
  |       |
  |       v
  |     M4-005  PTY wrapper + fake
  |       |
  |       v
  |     M4-006  Session projection + create/list/detail
  |       |
  |       v
  |     M4-007  Output store + tail replay
  |       |
  |       v
  |     M4-008  Session start with fake PTY           <- Gate 3
  |       |
  |       v
  |     M4-009  Stop + restart reconciliation
  |       |
  |       v
  |     M4-010  WebSocket terminal protocol
  |       |
  |       v
  |     M4-011  Real shell vertical slice             <- Gate 4 (full suite)
  |       |
  |       v
  |     M4-012  Desktop API + Sessions panel
  |       |
  |       v
  |     M4-013  Desktop terminal view (xterm)         <- Gate 5 (manual smoke)
  |       |
  |       v
  |     M4-014  Agent adapter polish
  |       |
  |       v
  +---> M4-015  Sidecar packaging verification        <- Gate 6
          |
          v
        M4-016  Final regression + documentation      <- Gate 7 (DoD)
```

**Parallelizable slots.**
- M4-004 (adapters) and M4-005 (PTY wrapper) can proceed in parallel after M4-003 if executed by two agents — both depend on contracts/migration and on M4-001's go decision, but neither depends on the other.
- M4-007 (output store) and M4-006 (create/list/detail) can be split across two sessions if the second agent stubs the snapshot integration point; otherwise keep them serial.

**Blocking tasks.** M4-001, M4-008, M4-011, M4-013, M4-015 are blocking gates — do not proceed past them with unresolved findings.

**Native-module gates.** M4-001 (feasibility), M4-005 (isolation invariant), M4-015 (bundled smoke).

**Full-suite review gates.** M4-011 and M4-016.

---

## Deliverable 2 — Suggested Model Assignment

| Task | Recommended | Rationale |
|---|---|---|
| M4-000 Baseline verification | **Human** | Trivial to run, but a green/red gating decision the human should own. |
| M4-001 Native PTY + sidecar spike | **Human** + **Opus** | Mixed risk: native install, prebuild availability, packaging dry-run. Opus to reason about the strategy; human to confirm the local install works. |
| M4-002 Contracts | **Codex (GPT 5.3)** | Schema-heavy, mechanical, high-precision. Strong fit for structured-output. |
| M4-003 Migration | **Codex (GPT 5.3)** | SQL DDL + migration tests; tightly bounded. |
| M4-004 Adapters + registry | **Sonnet 4.6** | Multiple files with similar shapes; medium implementation complexity. |
| M4-005 PTY wrapper + fake | **Sonnet 4.6** | Native API translation + fake; medium complexity, high isolation discipline. |
| M4-006 Create/list/detail | **Sonnet 4.6** | Projection + routes + transaction discipline; runtime integration. |
| M4-007 Output store | **Codex (GPT 5.3)** | Tight algorithm with deterministic tests; structured. |
| M4-008 Start with fake PTY | **Sonnet 4.6** | Runtime integration with subtle event-ordering rules. |
| M4-009 Stop + reconciliation | **Sonnet 4.6** | Race-condition discipline; one terminal event invariant. |
| M4-010 WS protocol | **Sonnet 4.6** | WS handler extensions; backpressure policy; medium complexity. |
| M4-011 Real shell slice | **Sonnet 4.6** (implementation) + **Human** (smoke) | Integration test; manual confirmation is irreducibly human. |
| M4-012 Desktop API + panel | **Sonnet 4.6** | UI wiring is Sonnet's sweet spot. |
| M4-013 Terminal view | **Sonnet 4.6** (implementation) + **Human** (manual smoke) | xterm wiring + irreducibly visual smoke. |
| M4-014 Agent adapter polish | **Sonnet 4.6** + **Human** (binary smokes) | Tests + manual checks for installed CLIs. |
| M4-015 Sidecar packaging | **Opus** + **Human** | Native + packaging reasoning; manual verification. |
| M4-016 Final regression + docs | **Opus** (DoD review) + **Sonnet 4.6** (docs drafting) + **Human** (sign-off) | Cross-cutting verification; final sign-off is human. |

Opus reserved for cross-cutting decisions:
- Native dependency strategy (M4-001).
- Sidecar packaging strategy and bundle verification (M4-015).
- Final DoD review (M4-016) if scope drift is suspected.

---

## Deliverable 3 — Recommended Review Gates

| Gate | When | Reviewer focus | Mandatory checks |
|---|---|---|---|
| **Gate 1** | After M4-001 | Native dependency feasibility | `node-pty` installs, imports, spawns; sidecar dry-run identifies required artifacts; go/no-go decision recorded. |
| **Gate 2** | After M4-003 | Contracts + migration surface | No forbidden schemas (`GET /v1/sessions`, `/input`, `/resize`, `/output`); no internal PTY types in contracts; both tables + three indexes present; FK behavior verified. |
| **Gate 3** | After M4-008 | Fake-PTY full loop + transaction discipline | Exactly one of `session.started`/`session.failed` per start; output is in chunks only, never events; broadcasts post-commit only; spawn-vs-event ordering documented. |
| **Gate 4** | After M4-011 | Daemon vertical slice + full suite | `pnpm -r typecheck` + `pnpm -r test` green; real-shell integration test passes; restart reconciliation marks `running` → `failed` with `daemon_restart` before HTTP/WS listen. |
| **Gate 5** | After M4-013 | Desktop manual smoke | Refined Goal → shell-manual session → live terminal → stop → reload daemon → tail persists. xterm dispose/unmount clean. No global session dashboard. |
| **Gate 6** | After M4-015 | Sidecar packaging | Bundled sidecar can `require('node-pty')` and spawn a trivial PTY on the supported local target. No change to Tauri spawn path. |
| **Gate 7** | After M4-016 | DoD + non-goals | All 20 DoD points confirmed; no forbidden surface introduced; docs match implementation. |

**Recommended sequencing of human attention.**
- Gates 1, 2, 6 are short reviews focused on risk (native, contracts, packaging).
- Gate 3 verifies the transaction/event invariants in isolation — read the start/stop tests carefully.
- Gate 4 is the largest review point: run the full suite locally; scan integration output; assert the one-terminal-event invariant under all three exit scenarios.
- Gate 5 is irreducibly manual — budget 20–30 minutes (create, run a few commands, restart daemon, reopen, verify tail).
- Gate 7 is a checklist pass against `docs/milestones/4.md` §17.

---

## Completion Notes

M4-016 final regression evidence and the Gate 7 DoD checklist are recorded in
`docs/implementation-plans/notes/m4-016-final-regression.md`.

---

## Out-of-scope Reminder (read before any task)

If a task is about to introduce any of the following, **stop and reject the diff**:

- `GET /v1/sessions`
- `POST /v1/sessions/:id/input`, `POST /v1/sessions/:id/resize`, `GET /v1/sessions/:id/output`
- `POST /v1/adapters/:id/invoke`, `PATCH /v1/adapters/:id/config`
- Workflow, task, recommendation, memory, context, or summary endpoints, tables, or events
- `session.output.received`, `session.input.sent`, or `session.resized` domain events
- Full transcript export, replay engine, terminal multiplexer, process re-parenting, tmux/screen integration
- Adapter marketplace loading, adapter configuration UI, CLI prompt/context injection, role catalogs
- Global session store, sessions dashboard, command center, route system, URL deep-linking
- Tabs, panes, terminal sharing, terminal search, command palettes, custom themes, custom keymaps
- Binary WebSocket protocol, new sockets, new queues, new worker pools, new storage abstractions
- A new top-level package
- `node-pty` imports anywhere outside `apps/daemon/src/pty/manager.ts`
- File watchers (`chokidar`, `fs.watch`, etc.), git libraries beyond what M3 already uses, AI provider SDKs

When in doubt: M4 is the embedded shell/manual session loop with capped output persistence and restart safety. Everything else is later.
