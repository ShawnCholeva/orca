You are acting as a principal engineer decomposing Milestone 4 of an AI orchestration platform into executable implementation tasks for an AI-assisted engineering workflow.

I have attached:

Product Brief
Technical Design Document
MVP Specification
Revised Milestone 4 architecture and execution plan: `docs/milestones/4.md`

Your task is to:

generate bounded executable implementation tasks

for Milestone 4.

Milestone 4 is:

Embedded Sessions

The intended proof point is:

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

The system is:

Tauri v2 desktop app
Node.js/TypeScript orchestration daemon
local-first
event-driven
plugin-oriented
skill-oriented
PTY/session-based in this milestone
Goal/memory/reasoning-centric later

The implementation tasks will later be executed by:

Sonnet 4.6
Codex 5.3
GPT 5.4
future orchestrated AI sessions

Therefore:

task clarity and execution boundaries are critical.

The implementation tasks should optimize for:

clear ownership
bounded scope
minimal ambiguity
deterministic validation
small-to-medium execution size
clean architecture progression
rapid feedback loops
early native-module risk discovery
implementation velocity

Avoid giant tasks.
Avoid vague tasks.
Avoid architecture-only tasks with no executable output.

Important Constraints

Do NOT:

redesign the architecture
expand scope
drift into Level 4/5 systems
introduce cloud infrastructure
introduce advanced plugin ecosystems
overabstract the MVP
prematurely optimize scalability
build memory extraction or context assembly
build session summaries
build tasks, recommendations, workflows, or command-center placeholder panels
build workspace indexing, search, refresh, or file watching
build context package injection
build role catalogs
build automatic prompt construction
build generic adapter invocation
build adapter hooks or adapter-owned PTY behavior
build adapter configuration UI
build a global sessions dashboard
build terminal tabs, panes, sharing, replay, search, export, command palettes, custom themes, or custom keymaps
persist terminal input, resize, or output as domain events
add binary WebSocket protocol
add new sockets, queues, workers, or storage abstractions
add new top-level packages

Preserve:

event-driven architecture
plugin-first direction
skill-first direction
daemon-owned domain state
contract-driven HTTP responses
clean runtime boundaries
future extensibility
M1/M2/M3 create/list/restart behavior
M3 refined Goals and attached Workspaces
post-commit-only event broadcasts
SQLite as the internal storage boundary
the existing JSON WebSocket channel

But optimize for:

MVP execution speed and operational clarity.

Milestone 4 Scope Must Match The Revised Plan

The task list must implement only the simplified M4 surface from `docs/milestones/4.md`:

Include:

native PTY feasibility and sidecar packaging gate
minimal session and adapter contracts
`session.created`, `session.started`, `session.exited`, `session.failed`, `session.stopped` events
optional `session.archived` only if it remains a simple terminal status transition
`sessions` table
`session_output_chunks` table
per-session capped output tail
internal adapter registry
shell/manual adapter
Claude Code adapter
opencode adapter
codex adapter
hardcoded adapter defaults with env-var overrides
lazy adapter availability detection
`node-pty` behind one daemon-local wrapper
fake PTY implementation for tests
session create/list/detail/start/stop use cases
`GET /v1/adapters`
`POST /v1/goals/:goalId/sessions`
`GET /v1/goals/:goalId/sessions`
`GET /v1/sessions/:id`
`POST /v1/sessions/:id/start`
`POST /v1/sessions/:id/stop`
optional `POST /v1/sessions/:id/archive` only if archive remains simple
boot reconciliation for `starting` / `running` sessions
existing WebSocket extended with terminal frames
`session.subscribe`
`session.unsubscribe`
`session.input`
`session.resize`
`session.output`
`session.error`
one shell/manual full-loop integration
Goal detail Sessions panel
Create session dialog
one embedded xterm.js terminal view
desktop reconnect/refetch behavior
sidecar build verification for `node-pty`
documentation of endpoints, WebSocket frames, env vars, retention cap, and restart policy

Do not include:

`GET /v1/sessions`
`POST /v1/sessions/:id/input`
`POST /v1/sessions/:id/resize`
`GET /v1/sessions/:id/output`
`POST /v1/adapters/:id/invoke`
`PATCH /v1/adapters/:id/config`
workflow endpoints
task endpoints
memory endpoints
context endpoints
output/input/resize domain events
full transcript export
full transcript replay engine
terminal multiplexer
process re-parenting
tmux/screen integration
adapter marketplace loading
adapter configuration UI
prompt/context injection
global session store or dashboard
new top-level packages

Task Generation Rules

Each task must be:

executable independently
testable independently
reviewable independently
understandable in isolation

Each task should ideally:

touch a limited surface area
have clear inputs/outputs
have deterministic validation criteria
avoid mixing architecture concerns
avoid creating future-facing abstractions without a current consumer

Tasks should generally target:

1 focused implementation concern
or 1 tightly related implementation cluster

Use the revised M4 task sequence as the required backbone:

M4-000 - Baseline verification
M4-001 - Native PTY feasibility and sidecar spike
M4-002 - Contracts
M4-003 - Migration
M4-004 - Adapter command resolver and adapters
M4-005 - PTY wrapper with fake
M4-006 - Session projection and create/list/detail without PTY start
M4-007 - Output store and replay
M4-008 - Session start with fake PTY
M4-009 - Stop and restart reconciliation
M4-010 - WebSocket terminal protocol
M4-011 - Real shell vertical slice
M4-012 - Desktop API and session panel
M4-013 - Desktop terminal view
M4-014 - Agent adapters polish
M4-015 - Sidecar packaging verification
M4-016 - Final regression and documentation

You may split a task only if it is too large for one focused session.
You may combine adjacent tasks only if the combined scope remains clearly reviewable and does not delay validation.

Required Output Structure

For EACH task provide:

1. Task ID

Use the `M4-NNN` format from the revised task sequence.

2. Task Title

Concise and implementation-oriented.

3. Purpose

Explain:

why this task exists
what milestone capability it unlocks
why it matters architecturally

Keep concise but clear.

4. Scope

Explicitly define:

what IS included
what is NOT included

Prevent scope creep.

5. Requirements

Concrete implementation requirements.

Prefer:

bullet points
explicit outputs
specific request/response shapes where relevant
specific event ordering where relevant
specific persistence rules where relevant
specific WebSocket frame shapes where relevant
specific lifecycle transition rules where relevant

Avoid vague statements.

6. Affected Areas

Specify:

packages
folders
modules
services
UI surfaces
database tables
tests

that are expected to change.

7. Dependencies

List:

prerequisite tasks
runtime dependencies
architectural dependencies
native-module or packaging dependencies

8. Acceptance Criteria

These must be objectively testable.

Examples:

schema parses expected payload and rejects removed fields
migration creates expected tables and indexes
endpoint returns expected schema
event sequence is persisted in committed order
broadcast occurs only after commit
output chunks are capped and not written to the event store
input and resize are not persisted
only the PTY wrapper imports `node-pty`
running sessions become failed on daemon restart before HTTP/WS listen
desktop terminal receives persisted tail and live output

Avoid subjective criteria.

9. Validation Steps

Provide:

manual validation
automated validation where appropriate
edge-case validation
targeted commands where possible
full-suite checkpoints where required
native PTY smoke validation where required
sidecar packaging validation where required

The implementing agent should know how to verify success.

Use targeted tests inside each task.
Run full `pnpm -r typecheck` and `pnpm -r test` at M4-011 and M4-016.

10. Risks / Notes

Mention:

likely pitfalls
OS-specific issues
native-module issues
sidecar packaging issues
sequencing concerns
implementation traps
temporary shortcuts allowed

Pay special attention to:

`node-pty` install/import/spawn failures
native import leakage outside `apps/daemon/src/pty/manager.ts`
sidecar dev mode differing from bundled mode
session row and lifecycle event transaction boundaries
post-commit-only WebSocket broadcasts
output bytes staying out of the domain event store
input and resize never being persisted
output chunk ordering with per-session `seq` and byte offsets
capped tail deletion of whole oldest chunks only
command-not-found producing persisted `session.failed`
adapter command/args avoiding shell strings
workspace deleted, detached, or unreadable before start
archived Goal session creation rejection
stop racing with natural PTY exit
exactly one terminal lifecycle event per terminal process
boot reconciliation before HTTP/WS accepts traffic
xterm mount/unmount cleanup
desktop reconnect refetching the session tail before resubscribe

Task Sequencing Requirements

The task list should:

start with the smallest runtime and native-module foundation
maximize early validation
avoid long dependency chains
avoid blocked implementation paths
establish architecture incrementally
create visible progress quickly
prove persistence before UI depends on it
prove daemon integration before desktop implementation
prove shell/manual end to end before agent adapter polish
prove sidecar packaging before final review

Preferred sequencing shape:

baseline before dependency changes
PTY feasibility before broad session code
contracts before daemon and desktop code
migration before projection helpers
adapter resolver before session start
PTY wrapper before runtime use cases
session create/list/detail before PTY start
output store before WebSocket streaming
fake PTY integration before real shell integration
daemon full loop before desktop UI
desktop session panel before terminal view
terminal view before agent adapter polish
sidecar verification before final docs/review

Deliverables

At the end provide:

1. Task Dependency Graph

Show:

sequencing
parallelizable tasks
blocking tasks
native-module gates
full-suite review gates

2. Suggested Model Assignment

Use model roles based on decision complexity, implementation ambiguity, and blast radius.

Opus 4.7

Best for:

architecture design
milestone planning
task decomposition
orchestration reasoning
resolving scope conflicts
reviewing major architectural tradeoffs
designing plugin/skill/workflow boundaries
diagnosing complex cross-system failures

Avoid using Opus for:

boilerplate
simple endpoints
migrations
repetitive tests
small UI tweaks
GPT 5.5

Best for:

implementation review
architecture drift detection
simplification passes
MVP scope tightening
risk analysis
operational sequencing
debugging strategy
“is this overengineered?” reviews

Use GPT 5.5 as the principal reviewer / architectural immune system.

Sonnet 4.6

Best for:

primary feature implementation
medium-to-large coding tasks
daemon/runtime integration
UI wiring
API implementation
refactors with context
iterative debugging
implementing task contracts end-to-end

Use Sonnet as the main implementation engineer.

GPT 5.4 / Codex

Best for:

bounded implementation tasks
schemas
migrations
tests
simple endpoints
type cleanup
utility functions
small refactors
repetitive code generation
isolated bug fixes

Use Codex/GPT 5.4 when the task has:

clear scope
known files
explicit acceptance criteria
low architectural ambiguity
Human

Best for:

product judgment
final approval gates
native desktop smoke testing
packaging/install verification
UX feel decisions
security-sensitive choices
resolving business/product ambiguity
deciding when “good enough” is good enough

Humans should own judgment, not boilerplate.

Cleaner Assignment Rule
Opus 4.7     = architect / decomposer
GPT 5.5      = reviewer / simplifier / drift detector
Sonnet 4.6   = main builder
GPT 5.4/Codex = bounded task executor
Human        = product judgment + final validation
Task Routing Matrix
Task type	Best model
Architecture design	Opus 4.7
Milestone decomposition	Opus 4.7
Scope conflict resolution	Opus 4.7 or GPT 5.5
Architecture drift review	GPT 5.5
MVP simplification	GPT 5.5
Runtime integration	Sonnet 4.6
UI implementation	Sonnet 4.6
API implementation	Sonnet 4.6
Debugging implementation failures	Sonnet 4.6, then GPT 5.5 if systemic
SQLite migrations	GPT 5.4/Codex
Zod schemas/contracts	GPT 5.4/Codex
Unit tests	GPT 5.4/Codex
Simple endpoints	GPT 5.4/Codex
Bounded refactors	GPT 5.4/Codex or Sonnet
Native packaging issues	Human + Sonnet, escalate to Opus only if architectural
UX/product feel	Human
Final milestone acceptance	Human + GPT 5.5

3. Recommended Review Gates

Suggest:

where architectural review should happen
where integration testing should happen
where runtime validation should happen
where native dependency validation should happen
where sidecar packaging validation should happen
where desktop manual smoke testing should happen

before continuing further.

Required Review Gates

Gate 1: After M4-001, verify `node-pty` feasibility and sidecar packaging strategy before broad session work.
Gate 2: After M4-003, verify contracts and migration surface before daemon session implementation.
Gate 3: After M4-008, verify fake-PTY session start/output/exit/failure behavior and transaction boundaries.
Gate 4: After M4-011, run full typecheck/test and review daemon API, WebSocket, event, persistence, restart, and real shell behavior.
Gate 5: After M4-013, run desktop manual smoke with one refined Goal, one attached git repo or folder, shell/manual session create/start/input/output/stop/reload.
Gate 6: After M4-015, verify bundled sidecar can import `node-pty` and spawn a trivial PTY on the supported local target.
Gate 7: After M4-016, verify Definition of Done and non-goals.

Most Important Instruction

Generate tasks as if:

an AI orchestration system will eventually execute them.

This means:

strong boundaries
explicit contracts
deterministic validation
minimal ambiguity
operational clarity

The output should feel like:

implementation contracts for an AI-native engineering organization.

Optimize for proving the embedded shell/manual session loop quickly.

Do not optimize for hypothetical future scale.
