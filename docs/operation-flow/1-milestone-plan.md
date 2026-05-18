You are acting as the lead principal engineer for this platform.

I have attached the following documents:

Product Brief
Technical Design Document
MVP Specification (Levels 1-3)
Level 4 Specification
Level 5 Specification
Milestone 1 implementation plan
Milestone 2 implementation plan
Milestone 3 implementation plan and review

Your task is NOT to immediately generate code.

Your task is to produce:

an implementation architecture and milestone execution plan for Milestone 4 of the MVP.

The system is:

Tauri v2 desktop app
Node.js/TypeScript orchestration daemon
local-first
event-driven
plugin-oriented
skill-oriented
PTY/session-based in this milestone
Goal/memory/reasoning-centric over the full MVP
optimized for orchestration and token efficiency

The implementation plan must optimize for:

architectural correctness
clean boundaries
future extensibility
token efficiency
maintainability
operational simplicity
avoiding premature complexity
preserving future Level 4 and Level 5 evolution

The implementation plan should NOT overengineer the MVP.

We are currently starting:

## Milestone 4 — Embedded Sessions

Build:

- node-pty manager
- embedded terminal UI
- session lifecycle events
- shell/manual session
- Claude Code adapter
- opencode adapter
- codex adapter

Exit criteria:

- user can launch Claude Code/opencode/codex from inside the app and interact normally

Milestone 4 builds on:

- Milestone 1: local Tauri app, Node daemon, SQLite, event store, Goal projection, Goal CRUD, live events
- Milestone 2: internal plugin registry, internal skill registry, default skill provider, Quick Goal skill, `skill.invoked` event, read-only plugin/skill diagnostics, adapter-capable plugin metadata
- Milestone 3: deterministic Goal refinement, Goal detail bundle, canonical workspace attachments, lazy workspace/git inspection, workspace attach/remove events and projections

The Milestone 4 plan should preserve the M1-M3 operational loop:

```text
Tauri app
  -> local daemon
  -> SQLite transaction
  -> append domain events
  -> update projections
  -> broadcast committed events
  -> UI refreshes from daemon state
  -> state survives daemon restart
```

Milestone 4 should prove the next product loop:

```text
User opens a refined Goal with attached workspaces
  -> creates a manual session
  -> chooses a workspace and agent adapter
  -> optionally chooses a role / short instruction
  -> daemon validates the Goal, workspace, and adapter
  -> daemon records a session and lifecycle events
  -> daemon launches a PTY in the selected workspace
  -> adapter starts shell / Claude Code / opencode / codex in the PTY
  -> desktop renders an embedded terminal
  -> user interacts with the agent normally
  -> daemon captures output and lifecycle transitions
  -> UI shows active/completed session state
  -> session metadata and useful output history survive daemon restart
```

Keep Milestone 4 focused. It should not become the memory engine, context assembly engine, task graph, recommendation engine, workflow engine, autonomous launcher, or full terminal multiplexer.

The implementation document should include:

1. Milestone Purpose

Explain why this milestone exists and what architectural foundation it establishes beyond M1-M3.

The explanation should clarify:

- why embedded sessions are the first real execution surface of the MVP
- why sessions must be scoped to existing Goals and Workspaces
- why adapter descriptors from M2 now need a real spawn contract
- how M4 prepares for Milestone 5 shared memory without building memory extraction yet
- what session state must survive restart versus what PTY process state can be deliberately non-resumable in M4

2. Scope Review And Simplification

Review the natural interpretation of Milestone 4 and identify what should be included versus deferred.

Explicitly decide how MVP-appropriate the following are for M4:

- `node-pty` integration
- PTY lifecycle manager
- embedded terminal renderer, likely `xterm.js`
- terminal input, output, resize, focus, copy/paste behavior
- shell/manual adapter
- Claude Code adapter
- opencode adapter
- codex adapter
- adapter availability detection
- adapter command configuration
- session create/list/detail/start/stop/archive
- session output persistence
- streaming output over WebSocket
- replaying recent output when opening a session
- terminal scrollback limits
- session role and user instruction fields
- workspace command context / cwd selection
- session crash and exit-code handling
- daemon restart handling for running sessions
- sidecar packaging impact of native PTY dependencies
- session preparation/context injection
- automatic summary extraction
- recommendations or auto-launching sessions

Prefer the smallest product-complete M4 that satisfies the exit criteria.

3. High-Level Runtime Architecture

Show how these pieces interact during Milestone 4:

- Tauri app
- React Goal detail / session dashboard / terminal view
- Node daemon
- existing HTTP/WebSocket API layer
- existing plugin and skill registries
- new adapter spawn contract
- PTY manager
- session domain/usecases
- SQLite storage
- event system
- Session projection
- Workspace projection from M3
- shell / Claude Code / opencode / codex processes

Describe the key flows:

- create a manual session for a Goal/workspace/adapter
- launch a shell/manual PTY session
- launch Claude Code, opencode, and codex sessions
- stream PTY output to the desktop
- send terminal input and resize events from desktop to daemon
- stop a running session
- list active and historical sessions
- open a session detail/terminal view
- handle agent command not found
- handle PTY exit, crash, and daemon shutdown
- restart and reload persisted session state/output history

4. Repository Structure

Design the M4 repository changes on top of the existing M1-M3 monorepo.

Cover likely additions under:

- `packages/contracts`
- `apps/daemon/src/sessions*`
- `apps/daemon/src/pty*`
- `apps/daemon/src/adapters*`
- `apps/daemon/src/registry*`
- `apps/daemon/src/server.ts`
- `apps/desktop/src`
- `apps/desktop/src-tauri`
- daemon tests
- desktop tests or smoke coverage
- build/packaging scripts if native modules require changes

Do not propose large package extraction unless there is a concrete M4 need.

5. Technology Decisions

Recommend M4-specific technology choices and explain why:

- whether to use `node-pty` directly or wrap it behind a daemon-local PTY interface
- terminal renderer choice and why
- output storage format and retention limits
- WebSocket message design for high-volume terminal output
- HTTP versus WebSocket boundaries for session actions
- adapter command resolution and availability detection
- whether adapter configuration is static, environment-derived, or user-configurable in M4
- how to handle platform-specific shells and quoting
- how to test PTY behavior deterministically
- how to avoid leaking secrets in persisted output or logs
- how native PTY dependencies affect sidecar/dev builds

Avoid adding heavy dependencies unless they materially reduce risk.

6. Runtime Lifecycle

Describe how M4 changes daemon and desktop lifecycle behavior.

Include:

- daemon boot migrations for session state/output state
- adapter registry availability before session creation
- PTY manager initialization and shutdown
- behavior when the desktop disconnects while sessions are running
- behavior when the daemon receives shutdown while sessions are running
- behavior on daemon restart with sessions that were previously running
- how the UI handles disconnected daemon state while a terminal is open
- how session output is buffered, persisted, and replayed
- what happens if adapter executable detection fails
- what happens if the selected workspace path no longer exists

7. Event System Design

Design the M4 event additions.

Include concrete event names and payload guidance for:

- `session.created`
- `session.started`
- `session.input.sent`, if persisted at all
- `session.output.received`
- `session.resized`, if persisted at all
- `session.exited`
- `session.failed`
- `session.stopped`
- `session.archived`
- any adapter availability or command-resolution event, if included

Define:

- event interfaces
- event persistence rules
- event ordering rules
- output chunk size guidance
- which events update which projections
- which events are broadcast live but not persisted, if any
- which events the UI should react to

Keep the event design MVP-appropriate and append-only. Be explicit about whether high-volume terminal output belongs in the general event store, a dedicated session output table, or both.

8. Database Design

Design the SQLite schema changes for M4.

Cover:

- `sessions` projection table
- `session_output` or equivalent output storage, if included
- adapter id, workspace id, role, instruction, status, timestamps, exit code
- terminal dimensions, if persisted
- indexes needed for Goal detail and session dashboard views
- migration strategy from the M1-M3 schema
- retention / truncation strategy for output history

Avoid premature tables for memory extraction, tasks, recommendations, workflows, and full context packages unless the plan strongly justifies a tiny session metadata field that M5 can consume.

9. API Contract Design

Define the M4 API surface with concrete endpoint examples.

At minimum, evaluate:

- `GET /v1/adapters`
- `POST /v1/goals/:id/sessions`
- `GET /v1/goals/:id/sessions`
- `GET /v1/sessions/:id`
- `POST /v1/sessions/:id/start`
- `POST /v1/sessions/:id/input`
- `POST /v1/sessions/:id/resize`
- `POST /v1/sessions/:id/stop`
- `POST /v1/sessions/:id/archive`
- WebSocket message types for terminal output and session lifecycle updates

For each endpoint/message, specify:

- request shape
- response shape
- validation behavior
- authorization behavior inherited from M1
- emitted events
- whether it is idempotent

Do not introduce generic adapter invocation unless the plan demonstrates a concrete M4 need.

10. Adapter Design

Define the M4 adapter behavior.

Cover:

- adapter interface shape
- how the shell/manual adapter starts the user's shell
- how the Claude Code adapter starts Claude Code
- how the opencode adapter starts opencode
- how the codex adapter starts codex
- how arguments, cwd, environment, and terminal dimensions are supplied
- how availability is detected
- how command-not-found is surfaced to the UI
- how adapter metadata maps to plugin registry metadata
- how adapters remain internal-first while preserving future plugin-first architecture
- what permissions or safety prompts, if any, are required before launching local commands

Keep adapters thin. They should adapt command invocation, not become orchestration engines.

11. PTY And Session Management Design

Define how sessions work in M4.

Include:

- domain model fields
- session status lifecycle
- PTY process lifecycle
- input/output channels
- output buffering and persistence
- terminal resize semantics
- stop/kill escalation behavior
- exit-code and signal handling
- duplicate start prevention
- session ownership by Goal and Workspace
- behavior for archived Goals or removed Workspaces
- security/privacy considerations for terminal output and local commands

Keep session support focused on manual launch and interaction. Do not build auto-launch, scheduling, task assignment engines, workflow runners, or long-running background orchestration loops.

12. UI Architecture

Define the M4 UI changes.

Cover:

- where session creation appears in the existing Goal detail view
- adapter selector
- workspace selector
- role / short instruction fields
- session dashboard/list
- embedded terminal panel
- active/completed/failed/archived states
- output replay when opening an existing session
- stop/archive controls
- adapter unavailable/error states
- disconnected daemon state while terminal is open
- runtime diagnostics preservation from M2/M3
- event subscriptions and refresh behavior

Keep UI minimal but real. Avoid placeholder panels for memory, tasks, recommendations, and workflows unless backed by M4 data.

13. Milestone Task Breakdown

Break Milestone 4 into sequential implementation tasks.

Each task should include:

- purpose
- dependencies
- affected areas
- expected outputs
- acceptance criteria
- validation steps
- risks/notes

The breakdown should be detailed enough that another agent could execute tasks one-by-one.

Include task sequencing for:

- baseline verification of M1-M3
- dependency/build feasibility check for native PTY support
- contract updates
- database migration
- adapter registry and availability API
- session domain/projection/usecases
- PTY manager abstraction
- shell/manual adapter
- Claude Code/opencode/codex adapters
- session HTTP API
- WebSocket terminal streaming
- desktop terminal component
- desktop session creation/list/detail UI
- integration tests
- restart/shutdown behavior tests
- documentation

14. Validation Strategy

Define how we validate:

- M1-M3 regression safety
- daemon startup after migration
- native PTY dependency installation/build behavior
- session create/list/detail lifecycle
- shell/manual PTY launch
- Claude Code/opencode/codex command construction and missing-command behavior
- terminal input/output streaming
- terminal resize behavior
- stop/exit/failure transitions
- event persistence and ordering
- output persistence/replay limits
- projection correctness
- WebSocket/UI refresh behavior
- daemon restart behavior
- desktop flow end-to-end
- sidecar build impact, if relevant

Prefer deterministic tests using a fake PTY implementation for domain/usecase tests and a small real PTY smoke test where the environment supports it.

15. Risks and Simplifications

Identify:

- biggest technical risks
- native dependency / packaging risks
- cross-platform PTY risks
- product scope risks
- privacy/security risks around terminal output and local command execution
- adapter command portability risks
- WebSocket throughput risks
- database growth risks from output persistence
- daemon restart/recovery risks
- UI terminal complexity risks
- overengineering traps to avoid
- things intentionally deferred

16. Definition of Done

Provide a precise "Milestone 4 complete" definition.

The definition should make clear that M4 is complete only when:

- the user can create a manual session from a Goal detail view
- the user can select an attached workspace as the session cwd
- shell/manual, Claude Code, opencode, and codex adapters have defined behavior
- unavailable adapter commands are handled clearly
- the daemon launches a PTY and streams output to the desktop
- the desktop sends user input and resize events back to the daemon
- session lifecycle events are persisted and broadcast after commit where appropriate
- session metadata and useful output history are queryable after restart
- running PTYs are shut down or marked non-resumable on daemon restart according to the chosen M4 policy
- M1-M3 functionality still works
- no memory extraction engine, context assembly engine, recommendation engine, workflow engine, task graph, or Level 4/5 automation has been introduced

Very important constraints:

Preserve plugin-first architecture
Preserve skill-first architecture
Preserve event-driven design
Build on the existing M1-M3 runtime instead of replacing it
Use M3 Workspaces as the only source of session cwd
Do NOT build cloud infrastructure
Do NOT build Level 4/5 autonomous systems yet
Do NOT build memory extraction or context assembly in M4
Do NOT build task graph/recommendation systems in M4
Do NOT build workflow automation in M4
Do NOT build auto-launching sessions in M4
Do NOT build workspace indexing or file watching in M4
Avoid premature microservices
Avoid overengineering
Favor clean boundaries over feature quantity
Favor deterministic systems over excessive AI reasoning
Favor hooks/events over constant orchestration loops
Favor local-first behavior and explicit user control

Output the implementation plan as a professional engineering design document with clear sections, rationale, and implementation sequencing.
