You are implementing a bounded Milestone 4 task for the Orca orchestration platform found in `docs/implementation-plans/milestone-4.md`.

Follow the implementation task exactly.

Do not redesign architecture.

Do not expand scope.

Do not introduce future systems.

Optimize for:

correctness
simplicity
maintainability
clean implementation
fast validation
preserving future extensibility

Current task:

M4-009

Prerequisite:

M4-000 baseline verification must already be complete and green. If the baseline is not recorded, stop and run M4-000 first.

Important architectural constraints:

local-first
event-driven
daemon owns state
SQLite remains the internal storage boundary
existing M1/M2/M3 wire shapes are frozen
M1 Goal creation behavior must remain valid
M2 Quick Goal and internal skill loop behavior must remain valid
M3 refined Goal and workspace behavior must remain valid
registries are static boot-time descriptors, then frozen
adapter concepts stay daemon-internal in M4
adapters are spawn-only and return command, args, env, and cwd
no public adapter invocation API
daemon write paths that emit events must persist events and projection rows atomically
event bus broadcasts happen only after COMMIT succeeds
terminal output is stored only in session_output_chunks
terminal output must never be written to the general event store
terminal input and resize are never persisted
node-pty may be imported only by apps/daemon/src/pty/manager.ts
all session usecases depend on a local PtyManager interface, not node-pty directly
M4-001 may add node-pty and create a scratch feasibility script
M4-001 may perform a sidecar dry-run only; production sidecar build changes belong to M4-015
M4 keeps the existing JSON WebSocket and existing socket path
session.subscribe, session.unsubscribe, session.input, session.resize, session.output, and session.error are WebSocket frames, not domain events
running sessions are not resumed after daemon restart
boot reconciliation marks starting/running sessions failed with daemon_restart before HTTP/WS listen
desktop additions prove the embedded session loop only
no external plugin API package yet
no dynamic plugin loading yet
no JSON manifests yet
no permissions or sandbox yet
no generic skill invocation endpoint yet
no generic adapter invocation endpoint yet
no storage-provider abstraction yet
no memory extraction
no session summaries
no context assembly
no prompt construction
no role catalogs
no AI reasoning
no recommendation engine
no workflow engine
no task graph
no workspace indexing
no workspace file watching
no global sessions dashboard
no command center
no URL routing or deep-linking
no terminal multiplexer
no tabs or panes
no replay engine
no transcript export
no terminal search
no command palette
no custom themes or keymaps
no binary WebSocket migration
no tmux or screen integration
no process re-parenting
no new sockets
no new queues
no new worker pools
no new top-level package
no cloud sync

Milestone 4 proof point:

User opens a refined Goal with attached workspaces
user creates a manual session
user chooses a workspace and adapter
user optionally enters role and short instruction
daemon validates Goal, workspace, and adapter id
daemon commits session row and lifecycle event in one SQLite transaction
daemon launches one PTY in the selected workspace
adapter provides command, args, env, and cwd only
desktop renders one embedded xterm.js terminal
user sends input and resize over the existing WebSocket
daemon streams PTY output over the existing WebSocket
daemon stores a capped output tail outside the general event store
daemon records exit, stop, or failure lifecycle events
session metadata and output tail survive daemon restart

Milestone 4 included surface:

node-pty feasibility and sidecar artifact discovery
session.created, session.started, session.exited, session.failed, session.stopped events
sessions table
session_output_chunks table
capped per-session output tail, default 1 MiB
internal adapter registry
shell-manual, claude-code, opencode, and codex adapters
GET /v1/adapters
POST /v1/goals/:goalId/sessions
GET /v1/goals/:goalId/sessions
GET /v1/sessions/:id
POST /v1/sessions/:id/start
POST /v1/sessions/:id/stop
session.subscribe WebSocket frame
session.unsubscribe WebSocket frame
session.input WebSocket frame
session.resize WebSocket frame
session.output WebSocket frame
session.error WebSocket frame
PTY wrapper with fake implementation for tests
boot-time session reconciliation
desktop Goal detail Sessions panel
single embedded xterm.js terminal view
sidecar packaging verification in M4-015 only

Milestone 4 excluded surface:

GET /v1/sessions
POST /v1/sessions/:id/input
POST /v1/sessions/:id/resize
GET /v1/sessions/:id/output
POST /v1/adapters/:id/invoke
PATCH /v1/adapters/:id/config
session.output.received domain event
session.input.sent domain event
session.resized domain event
memory, context, summary, task, recommendation, or workflow endpoints
memory, context, summary, task, recommendation, or workflow tables
adapter marketplace loading
adapter configuration UI
CLI prompt/context injection
role catalogs
global session store
global session dashboard
route system or URL deep-linking
terminal tabs, panes, sharing, search, replay, transcript export, or command palette
custom terminal themes or keymaps
binary WebSocket protocol
new socket paths
external queues
storage provider abstractions
background worker pools
file watchers
new git libraries beyond the M3 workspace inspection approach
AI provider SDKs

Implementation instructions:

Analyze the current repository structure first.
Read the specific M4 task before editing.
Check task dependencies and do not skip prerequisite validation.
Honor the mandatory review gates before continuing past gated tasks.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where wire contracts or request/response parsing require it.
Avoid unnecessary abstractions.
Prefer deterministic/simple logic.
Preserve existing M1/M2/M3 behavior unless the M4 task explicitly changes it.
Keep public API changes limited to the task's declared endpoints/contracts.
Keep registry, adapter, skill, and PTY code daemon-internal unless the task explicitly changes contracts.
Keep the DaemonContext seam explicit; add dependencies to context instead of using module globals.
Do not modify sidecar build/spawn surfaces except for the explicit M4-001 dry-run and M4-015 packaging task.
Use execFile, not exec, for subprocesses where code must spawn commands.
Do not add git libraries such as simple-git, isomorphic-git, nodegit, or dugite.
Do not add file watchers such as chokidar or fs.watch.
Do not add AI provider SDKs, prompt management, or model calls.
Do not log terminal output, instruction text, or other session byte streams.
Add comments only where helpful.
Ensure the task validation steps pass.

M4-001-specific instructions:

Add node-pty only to apps/daemon/package.json dependencies.
Create apps/daemon/scripts/m4-001-pty-spike.mjs as a scratch feasibility script.
The spike must import node-pty, spawn `/bin/sh -c "echo orca-pty-ok && exit 0"`, print observed output, and exit 0.
Run pnpm install and the spike script.
Perform a sidecar dry-run to identify required node-pty native artifacts.
Do not modify apps/daemon/scripts/build-sidecar.mjs in M4-001.
Record findings in docs/implementation-plans/notes/m4-001-pty-feasibility.md.
Record node-pty version, verified target triple, native artifact paths, rebuild requirements, and go/no-go decision.
If node-pty cannot install, import, spawn, or be located for sidecar packaging, stop after documenting the blocker.

Review gates:

Gate 1: After M4-001, verify node-pty installs, imports, spawns, sidecar dry-run identifies required artifacts, and go/no-go is recorded.
Gate 2: After M4-003, verify contracts and migration surface; no forbidden schemas or PTY types in contracts; both tables and indexes present.
Gate 3: After M4-008, verify fake-PTY start loop, transaction discipline, output isolation, and spawn-vs-event ordering.
Gate 4: After M4-011, run full typecheck/test and verify the real-shell daemon vertical slice, restart reconciliation, and one-terminal-event invariant.
Gate 5: After M4-013, run desktop manual smoke for refined Goal to shell-manual session to terminal output to stop to reload.
Gate 6: After M4-015, verify bundled sidecar can require node-pty and spawn a trivial PTY without changing the Tauri spawn path.
Gate 7: After M4-016, verify Definition of Done and non-goals.

Before finishing:

verify all acceptance criteria
verify validation steps
verify M1/M2/M3 baseline behavior still works where relevant
verify no excluded M4 surface was introduced
verify node-pty import isolation when production PTY code exists
verify output/input/resize are not domain events
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:

Commit changes
Run `/simplify`, then commit again if any changes made
Output changes from a product perspective

Do not implement unrelated future milestone functionality.
