You are acting as a principal engineer performing an architectural and implementation quality review for the Orca AI-native orchestration platform.

In the `docs/` directory, review the relevant source material before judging the implementation:

- `docs/PRODUCT.md` - product vision and operating principles
- `docs/MVP.md` - MVP scope for Levels 1-3
- `docs/TECHNICAL.md` - target architecture
- `docs/LEVEL_4.md` - future supervised execution boundaries
- `docs/milestones/4.md` - simplified Milestone 4 scope and guardrails
- `docs/implementation-plans/milestone-4.md` - executable Milestone 4 task plan
- `docs/implementation-plans/notes/m4-001-pty-feasibility.md` - native PTY feasibility result
- `docs/implementation-plans/notes/m4-015-sidecar-packaging.md` - sidecar packaging result
- `docs/implementation-plans/notes/m4-016-final-regression.md` - final validation and DoD notes, if present
- the current implementation state in the repository

Your task is to review the Milestone 4 implementation quality and detect architecture drift.

Milestone 4 is:

```text
Embedded Sessions
```

The intended M4 proof point is:

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

The platform remains:

- local-first
- Tauri v2 desktop app
- Node.js/TypeScript daemon
- event-driven
- plugin-oriented
- skill-oriented
- Goal-centric
- SQLite-backed for the MVP
- orchestration-focused

Milestone 4 adds one runtime capability: daemon-managed local PTY sessions. It must not become the memory engine, context assembler, workflow engine, adapter marketplace, terminal multiplexer, task system, or Level 4/5 automation layer.

## Review Focus

### 1. M4 Scope Compliance

Identify any implementation that exceeds the Milestone 4 boundary.

M4 must include only:

- session identity scoped to a Goal and an attached Workspace
- `sessions` table
- `session_output_chunks` table
- lifecycle events: `session.created`, `session.started`, `session.exited`, `session.failed`, `session.stopped`
- optional `session.archived` only if archive stayed a simple status transition
- internal adapter descriptors for `shell-manual`, `claude-code`, `opencode`, and `codex`
- pure adapter spawn factories returning command, args, env, and cwd
- lazy adapter availability via `GET /v1/adapters`
- `POST /v1/goals/:goalId/sessions`
- `GET /v1/goals/:goalId/sessions`
- `GET /v1/sessions/:id`
- `POST /v1/sessions/:id/start`
- `POST /v1/sessions/:id/stop`
- optional `POST /v1/sessions/:id/archive` only if retained in the implementation
- existing `/v1/events` WebSocket extended with JSON/base64 session frames
- `session.subscribe`, `session.unsubscribe`, `session.input`, and `session.resize` inbound WS frames
- `session.output` and `session.error` outbound WS frames
- `node-pty` isolated behind the daemon PTY wrapper
- fake PTY implementation for tests
- one PTY per running session
- capped per-session output tail, default 1 MiB, stored outside the general event store
- input and resize transport with no persistence
- stop semantics with SIGTERM then SIGKILL after a grace period
- boot reconciliation that marks prior `starting`/`running` sessions as `failed` with `daemon_restart`
- Goal detail Sessions panel
- Create Session dialog
- one embedded xterm.js terminal view for the selected session
- sidecar packaging support for `node-pty` on the supported local target
- M1/M2/M3 create/list/refine/workspace/restart behavior preserved

Flag any of the following as drift unless explicitly justified by a documented defect:

- `GET /v1/sessions` collection endpoint
- `POST /v1/sessions/:id/input`
- `POST /v1/sessions/:id/resize`
- `GET /v1/sessions/:id/output`
- `POST /v1/adapters/:id/invoke`
- `PATCH /v1/adapters/:id/config`
- generic plugin execution API
- adapter hooks, adapter-owned PTY behavior, adapter-owned streaming, or adapter output transformers
- persisted `session.output.received`, `session.input.sent`, or `session.resized` domain events
- memory extraction, memory promotion, session summaries, context assembly, prompt package injection, task graph, recommendations, workflow engine, or supervised/autonomous execution
- role catalogs, role plugins, generated prompts, model-provider SDKs, AI-backed session setup, or network calls beyond the local daemon API
- global sessions dashboard, command center, URL routing/deep-linking, memory panel, task panel, recommendations panel, or workflow UI
- terminal tabs, panes, sharing, replay, transcript export, search, command palette, themes, keymaps, tmux/screen integration, or process re-parenting
- binary WebSocket protocol, new sockets, queues, worker pools, or broad storage provider abstractions
- file watchers, workspace indexing/scanning, git refresh jobs, or per-workspace command env systems
- adapter marketplace loading or adapter configuration UI
- new top-level package
- `node-pty` imports outside `apps/daemon/src/pty/manager.ts` except a clearly scratch feasibility script
- sidecar launch behavior changes unrelated to the documented `node-pty` packaging need
- breaking changes to M1/M2/M3 request/response shapes or event ordering

### 2. Architecture Drift Detection

Identify where the implementation has drifted from:

- the architecture docs
- `docs/milestones/4.md`
- `docs/implementation-plans/milestone-4.md`
- the product philosophy
- the event-driven model
- daemon-owned orchestration and runtime state
- the Goal-centric and Workspace-scoped direction
- the M1/M2/M3 operational baseline

Examples of drift:

- UI owning session truth, adapter registration, workspace validation, or terminal lifecycle state instead of rendering daemon state
- business logic leaking into React components instead of daemon use cases, API helpers, or focused reducers/hooks
- registry mutation after boot/freeze
- generic adapter/plugin invocation introduced before the single PTY-backed session use case is proven
- role/instruction treated as structured context, prompt assembly, or memory input instead of opaque persisted strings
- adapter descriptors touching DB, events, PTY handles, output, streaming, summaries, memory, or prompts
- output bytes written to the general domain event store
- input or resize persisted
- session lifecycle events emitted outside the transaction that mutates projections
- WebSocket broadcasts happening before commit
- boot reconciliation running after HTTP/WS begins accepting traffic
- `node-pty` native details leaking into sessions, adapters, contracts, desktop, or tests that should use the local interface/fake
- xterm terminal state becoming a global store, dashboard, or multi-session terminal abstraction
- sidecar packaging changes expanding beyond copying/loading the required native runtime dependency
- implementation preserving M4 features while breaking M1/M2/M3 Goal, skill, refinement, workspace, or restart behavior

### 3. Event And Transaction Integrity

Review session create, start, fail, exit, stop, optional archive, and boot reconciliation paths carefully.

Verify that:

- every write that emits a lifecycle event updates the projection and inserts the event inside the same SQLite transaction
- committed lifecycle events are broadcast only after commit and in committed order
- `session.created` payload stays bounded and includes only session, Goal, Workspace, and adapter identity
- `session.started` is written only after a successful PTY spawn when the pid is known
- spawn failure writes `session.failed` instead of `session.started`
- command-not-found writes `session.failed` with `failure_reason = "command_not_found"` and returns a clear HTTP 422
- workspace unavailable writes `session.failed` with `failure_reason = "workspace_unavailable"` where appropriate
- natural exit writes exactly one `session.exited`
- user stop writes exactly one `session.stopped`
- stop/natural-exit races cannot produce both `session.exited` and `session.stopped`
- SIGTERM/SIGKILL escalation still produces one terminal lifecycle event
- repeated stop after terminal status returns a conflict and emits no additional event
- boot reconciliation updates all `starting`/`running` rows to `failed` with `daemon_restart` before HTTP/WS listen
- reconciliation leaves `created`, `exited`, `failed`, `stopped`, and optional `archived` rows untouched
- resize updates terminal dimensions without inserting a domain event
- output append does not insert any domain event
- input does not insert any projection row or event
- forced projection failure leaves no partial event rows
- M1/M2/M3 event sequences remain unchanged for non-session flows

### 4. PTY Runtime Quality

Review whether the PTY layer is intentionally small and isolated.

Verify that:

- only `apps/daemon/src/pty/manager.ts` imports or requires `node-pty` in production code
- session use cases depend on a local `PtyManager` interface, not native package types
- fake PTY tests cover data, exit, kill, write-after-exit, and reset behavior
- the real PTY smoke is guarded by an environment flag unless it is part of a dedicated integration task
- one live PTY handle exists per running session
- runtime rejects starting a session that is not in the expected pre-start state
- handles are removed on exit/fail/stop
- output handlers and exit handlers are detached or made inert after terminal lifecycle completion
- process spawn uses command plus args, not shell string concatenation
- adapter command resolution failures are distinct from native spawn failures
- role and instruction are not interpolated into shell command strings
- environment variables avoid leaking secrets into logs
- no terminal multiplexer, process re-parenting, tmux/screen integration, or pane/tab abstraction was introduced

### 5. Adapter Design Quality

Review whether adapters are the minimum needed to launch PTY-backed sessions.

Verify that:

- adapter ids are the closed M4 set: `shell-manual`, `claude-code`, `opencode`, `codex`
- `GET /v1/adapters` exposes read-only summaries and lazy availability only
- registry registration happens before HTTP listen and is not mutated after boot
- adapter availability is cheap and does not perform scheduled/background probing
- adapters return `{ command, args, env, cwd }` only
- shell/manual fallback order matches the milestone rules
- Claude Code, opencode, and codex use env-var overrides plus default binary names
- agent adapters add no CLI-specific prompt flags in M4
- adapter tests cover PATH hit/miss, absolute path hit/miss, env overrides, and useful unavailable details
- adapters do not import `node-pty`
- adapters do not write DB rows, emit events, manage PTY handles, stream output, summarize, parse output, construct prompts, or invoke AI/model providers

### 6. Output Store And WebSocket Discipline

Review whether terminal I/O is cleanly separated from domain events.

Verify that:

- output is stored only in `session_output_chunks`
- `session_output_chunks` stores raw bytes as BLOBs, not base64 text
- `sessions.output_seq`, `output_bytes_kept`, and `output_offset_first` remain consistent
- `seq` is monotonic per session
- byte offsets are monotonic and never reused
- tail cap defaults to 1 MiB and is configurable with `ORCA_SESSION_OUTPUT_TAIL_BYTES`
- cap enforcement deletes whole oldest chunks only
- two sessions' output tails are independent
- `readTail` returns chunks in ascending `seq` order
- output for unknown sessions has a safe empty snapshot behavior if that is the documented implementation
- WS `session.output` frame `seq` and `byteOffset` match the persisted chunk returned by the output store
- input frames decode base64 once at the edge and forward raw bytes to the PTY handle
- resize frames validate cols/rows and avoid redundant updates when dimensions are unchanged
- malformed frames produce `session.error` with `invalid_message`
- unknown sessions produce `session.error` with `unknown_session`
- non-active sessions produce `session.error` with `not_active`
- slow consumer handling closes only the slow subscriber and does not block PTY output or DB writes
- no new socket, binary frame protocol, HTTP input/resize/output endpoints, transcript export, or replay engine was added

### 7. API And Contract Discipline

Verify the public surface is minimal and contract-driven.

Check that:

- `@orca/contracts` contains only M4-needed public wire schemas/types
- internal adapter spawn types, PTY types, runtime types, output-store internals, role catalogs, memory/context/task/recommendation/workflow schemas are absent from contracts
- `DomainEventType` adds only the M4 lifecycle events, plus optional `session.archived` if implemented
- `SessionStatus` values match the persistence and route behavior
- `SessionFailureReason` values are narrow and useful
- `AdapterId` rejects unknown adapters
- create/start/stop request schemas are strict
- WS frame schemas are strict if represented in contracts
- `GET /v1/adapters` returns contract-shaped adapter summaries
- `POST /v1/goals/:goalId/sessions` validates the Goal, Workspace, adapter, role, instruction, and title
- `GET /v1/goals/:goalId/sessions` is the only session collection route
- `GET /v1/sessions/:id` returns session detail plus output snapshot
- `POST /v1/sessions/:id/start` validates terminal cols/rows
- `POST /v1/sessions/:id/stop` has no hidden side effects beyond stop lifecycle
- all M4 HTTP routes inherit existing local auth/CORS behavior
- no breaking change was introduced for M1/M2/M3 callers

### 8. Database And Projection Discipline

Review the M4 persistence shape.

Verify that:

- migration `0004_sessions.sql` creates only `sessions` and `session_output_chunks`
- earlier migrations are not rewritten for M4
- `sessions` contains only session lifecycle, command, terminal, failure, and output-tail accounting fields
- `session_output_chunks` contains `session_id`, `seq`, `byte_offset`, `byte_length`, `written_at`, and raw `data`
- indexes support per-Goal session list and per-session output replay
- deleting a Goal cascades sessions as documented
- deleting a Workspace with sessions is restricted
- deleting a session cascades output chunks
- no memory, summary, context, task, recommendation, workflow, transcript analytics, pane/tab, adapter config, or workspace scan/index table was added
- session list ordering is stable and matches the API tests
- projection helpers do not open their own unrelated transactions or publish events
- restart behavior reads projection tables rather than relying on event replay in M4
- output retention updates counters and deletes chunks in a single transaction

### 9. Desktop Integration Quality

Review the UI as the minimum product loop for embedded sessions.

Verify that:

- existing M1/M2/M3 Goal list, Create Goal flow, Goal detail refinement, and workspace behavior remain usable
- sessions live under Goal detail, not a global dashboard
- Create Session dialog uses attached M3 workspaces from daemon state
- adapter selector uses `GET /v1/adapters`
- unavailable adapters are clear but do not become a configuration UI
- role and instruction fields remain opaque strings
- creating a session calls `POST /v1/goals/:goalId/sessions`
- starting a session calls `POST /v1/sessions/:id/start`
- stopping a session calls `POST /v1/sessions/:id/stop`
- session list refreshes on relevant committed lifecycle events
- terminal view fetches detail/tail before subscribing or otherwise avoids duplicate/lost output on reconnect
- terminal view subscribes and unsubscribes on mount/unmount
- xterm, fit addon, resize observer, and WS listeners are disposed on unmount
- input is disabled for terminal statuses while output remains visible
- resize sends only changed dimensions
- gap detection refetches detail tail once and avoids infinite loops
- errors such as `command_not_found` and `workspace_unavailable` are shown simply
- there is no global session store, route system, deep linking, command center, terminal settings UI, adapter configuration UI, or multi-tab/pane terminal UI
- the visual addition remains small, maintainable, and consistent with the existing desktop app

### 10. Sidecar And Packaging Discipline

Review whether `node-pty` packaging is the narrow M4 exception.

Verify that:

- M4-001 records the target, `node-pty` version, artifact layout, and go/no-go
- M4-015 updates sidecar packaging only enough to load `node-pty` at runtime
- sidecar runtime tree includes the required current-target `pty.node`
- native runtime shimming does not pull `node-pty` into the SEA bundle incorrectly
- bundled smoke proves the sidecar can load `node-pty` and run the shell loop
- Tauri launch path remains unchanged unless a documented defect required a narrow fix
- packaging notes document the supported target and any best-effort target caveats
- no signed distribution, updater, marketplace, external worker, new daemon transport, or broad packaging rewrite was added

### 11. Test And Validation Coverage

Assess whether validation proves the M4 loop without overbuilding a test matrix.

Expected coverage:

- M1 baseline integration still passes
- M2 loop still passes
- M3 create/refine/workspace integration still passes
- contracts parse happy paths and reject invalid M4 wire shapes
- migration tests cover fresh DB, M3 upgrade, idempotent replay, indexes, and FK behavior
- adapter resolver tests cover PATH, absolute paths, env overrides, hits, misses, and unavailable details
- registry tests confirm exactly the four M4 adapters
- PTY fake tests cover output, exit, kill, write after exit, and reset
- real PTY smoke is available and gated
- session projection tests cover insert/read/list/detail
- create session use case covers happy path, archived Goal, missing/wrong Workspace, unreadable Workspace, unknown adapter, and post-commit broadcast behavior
- output store tests cover sequencing, byte offsets, cap enforcement, multi-session isolation, and no event writes
- start tests cover happy path, command-not-found, workspace unavailable, spawn failure, event ordering, output persistence, and no output events
- stop tests cover natural exit, user stop, SIGKILL escalation, race with natural exit, and exactly one terminal event
- boot reconciliation tests cover `starting`/`running` to `failed` and ordering before HTTP/WS listen
- WebSocket tests cover subscribe, unsubscribe, output frame seq/offset, input forwarding, resize persistence without event, malformed frames, unknown sessions, inactive sessions, and slow consumers where practical
- real shell vertical slice covers HTTP + WS + PTY + output tail + restart
- desktop API tests cover M4 endpoints
- desktop component tests cover Sessions panel, Create Session dialog, session list, stop control, terminal tail write, live output, gap handling, input, resize, unsubscribe, and cleanup
- sidecar smoke proves bundled `node-pty` and shell session loop
- `pnpm -r typecheck`, `pnpm -r test`, and sidecar smoke pass if those are the established gates
- manual Tauri/dev smoke is recorded if claimed as part of shippability

Flag missing tests that create real regression risk. Do not demand tests for deferred systems such as memory extraction, context assembly, task graphs, recommendations, workflow engines, workspace indexing, file watching, terminal multiplexing, high-concurrency stress, transcript search, Windows production packaging, or AI behavior.

## Definition Of Done Cross-Check

Check `docs/milestones/4.md` section 17 line by line:

1. Refined Goal detail can create a session for an attached workspace.
2. User can select shell/manual, Claude Code, opencode, or codex adapters; unavailable adapters are clear.
3. Daemon validates Goal, workspace, and adapter before start.
4. Session create/start/exit/fail/stop lifecycle transitions are persisted as domain events and projections in the same transaction.
5. Daemon broadcasts lifecycle events only after commit.
6. Daemon launches exactly one PTY per running session in the selected workspace.
7. Desktop renders one embedded xterm terminal for the selected session.
8. Input, resize, and output flow over the existing JSON WebSocket channel.
9. Input and resize are not persisted.
10. Output is not persisted in the general event store.
11. A capped output tail is stored in `session_output_chunks`.
12. Session list/detail and output tail survive daemon restart.
13. Sessions that were `starting` or `running` on daemon boot are marked `failed` with `daemon_restart` before HTTP/WS accepts traffic.
14. Stop sends SIGTERM, then SIGKILL after a short grace period.
15. Command-not-found produces a persisted `session.failed` and a clear 422 response.
16. Only the PTY wrapper imports `node-pty`, allowing for a documented scratch feasibility script if still present.
17. Adapters are pure spawn factories and do not own PTY behavior.
18. `pnpm -r typecheck` and `pnpm -r test` pass, including M1/M2/M3 regressions and M4 shell/restart tests.
19. The sidecar build can include `node-pty` for the supported M4 target.
20. No memory extraction, summary extraction, context assembly, task graph, recommendation engine, workflow engine, file watcher/indexer, global sessions dashboard, adapter config UI, terminal multiplexer, process re-parenting, cloud/distributed runtime, or Level 4/5 automation has been added.

If any item is not satisfied, classify it as a finding unless the implementation notes explicitly mark it as an accepted outstanding manual gate.

## Findings Format

For each issue, provide:

- severity: `critical`, `high`, `medium`, or `low`
- file and line reference where possible
- the drift or defect
- why it matters long-term
- recommended correction
- correction timing: `immediate`, `soon`, or `acceptable for MVP`

Prioritize findings by risk to:

- M1/M2/M3 regression safety
- native PTY isolation and sidecar viability
- event/transaction correctness
- session lifecycle correctness
- output retention and privacy
- daemon-owned runtime boundaries
- Goal/Workspace scoping
- future memory/context/session-summary architecture
- future plugin/adapter architecture
- desktop terminal cleanup and reconnect correctness

If no findings are discovered, state that explicitly and list any residual risks or testing gaps.

Do not rewrite the implementation during the review. Produce a review report focused on defects, drift, missing validation, and targeted remediation.
