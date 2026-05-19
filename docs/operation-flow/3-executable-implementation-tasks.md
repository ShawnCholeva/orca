You are acting as a principal engineer decomposing Milestone 5 of an AI orchestration platform into executable implementation tasks for an AI-assisted engineering workflow.

I have attached:

Product Brief
Technical Design Document
MVP Specification
Level 4 and Level 5 specifications
Milestone 1 implementation plan
Milestone 2 implementation plan
Milestone 3 implementation plan
Milestone 4 implementation plan and validation notes
Milestone 5 architecture and simplified execution plan: `docs/milestones/5.md`

Your task is to:

generate bounded executable implementation tasks

for Milestone 5.

Milestone 5 is:

Shared Memory

The intended proof point is:

```text
User opens a Goal with completed or stopped sessions
  -> daemon detects eligible sessions without scanning the workspace
  -> daemon reads Goal/refinement/session metadata and capped M4 output tail
  -> daemon runs one daemon-local extraction job
  -> extractor returns summary, memory candidates, and decision candidates
  -> daemon validates output with zod and normalizes/redacts candidate text
  -> daemon commits summary, memory, decisions, extraction state, and events in one SQLite transaction
  -> daemon broadcasts committed events only after commit
  -> Goal detail UI refetches memory, decisions, sessions, and summaries
  -> user can review, edit, promote/archive memory, and confirm/archive decisions
  -> all committed rows survive daemon restart
```

The system is:

Tauri v2 desktop app
Node.js/TypeScript orchestration daemon
local-first
event-driven
plugin-oriented
skill-oriented
Goal-scoped
Workspace-aware
PTY/session-based from Milestone 4
memory/reasoning-centric in this milestone
SQLite-backed
contract-driven

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
early persistence and idempotency validation
implementation velocity

Avoid giant tasks.
Avoid vague tasks.
Avoid architecture-only tasks with no executable output.

Important Constraints

Do NOT:

redesign the architecture
expand scope
drift into Milestone 6 context assembly
drift into Milestone 7 recommendations
drift into Level 4 supervised execution
drift into Level 5 autonomy
introduce cloud infrastructure
introduce distributed queues, workers, schedulers, or workflow engines
introduce AI provider SDKs, provider configuration UI, model selection, prompt libraries, or token accounting beyond hard byte/char caps
introduce generic skill invocation APIs or public extractor invocation APIs
introduce multi-extractor routing or plugin marketplace loading
introduce context packages, context scoring, prompt injection, or sibling-session startup awareness
build tasks, recommendations, workflows, conflict detection, or command-center panels
build cross-Goal memory, workspace indexing, search, refresh, file watching, knowledge graphs, embeddings, vector search, or semantic search
build memory consolidation, ranking/relevance, aging/decay, policy/governance, or audit engines
build full transcript capture, full transcript extraction, transcript replay, transcript export, or transcript analytics
persist raw terminal output, extractor prompts, raw extractor responses, or model reasoning in the event store
add provider/model settings to desktop
add global memory dashboards, graph views, recommendation panels, task panels, workflow/autonomy controls, or new top-level navigation
add new top-level packages

Preserve:

event-driven architecture
plugin-first direction
skill-first direction
Goal-scoped domain boundaries
daemon-owned domain state
contract-driven HTTP responses
clean runtime boundaries
M1 Goal CRUD and live event behavior
M2 plugin/skill registry behavior
M3 refined Goals and attached Workspaces
M4 PTY sessions, adapter behavior, lifecycle events, capped output tails, restart reconciliation, and embedded terminal behavior
post-commit-only event broadcasts
SQLite as the internal storage boundary
the existing WebSocket event channel for live refresh

But optimize for:

MVP execution speed and operational clarity.

Milestone 5 Scope Must Match The Revised Plan

The task list must implement only the simplified M5 surface from `docs/milestones/5.md`.

Include:

contract schemas for memory items, decisions, session summaries, extraction rows, extractor input/output, and M5 event literals
`goal_memory_items` table
`goal_decisions` table
`session_summaries` table
`memory_extractions` table
minimal indexes for Goal reads, source lookup, duplicate prevention, active extraction idempotency, and runner pickup
Goal-scoped memory list/create/patch use cases
Goal-scoped decision list/create/patch use cases
memory statuses `candidate`, `promoted`, `archived`
decision statuses `proposed`, `confirmed`, `archived`
automatic promotion only for deterministic low-risk memory
manual memory creation, edit, promote, archive
manual decision creation, edit, confirm, archive
compact source attribution to refinement, session/output byte window, or manual source
one daemon-local extractor interface
one deterministic extractor implementation
fake extractor support for tests
bounded extractor input assembled from Goal/refinement/session metadata and capped M4 output tail
ANSI/control stripping before extraction
input byte cap, output text caps, candidate count caps, and truncation flags
zod validation of extractor output
normalization, content hashing, duplicate prevention, and best-effort secret redaction before persistence
in-process serial extraction runner
extraction enqueue/state lifecycle with `pending`, `running`, `succeeded`, `failed`
boot reconciliation of stale `pending`/`running` extractions to failed with `daemon_restart`
terminal-session hook that enqueues after M4 terminal state commits
Goal-open detection that enqueues eligible terminal sessions for that Goal only
M3 refinement seed memory for constraints and success criteria
`GET /v1/goals/:goalId/memory`
`POST /v1/goals/:goalId/memory`
`PATCH /v1/memory/:id`
`GET /v1/goals/:goalId/decisions`
`POST /v1/goals/:goalId/decisions`
`PATCH /v1/decisions/:id`
`GET /v1/sessions/:sessionId/summary`
`POST /v1/sessions/:sessionId/extract-memory`
latest extraction status and summary fields on existing Goal/session reads where useful
events:
`memory.extraction.requested`
`memory.extraction.started`
`memory.extraction.completed`
`memory.extraction.failed`
`memory.item.created`
`memory.item.updated`
`memory.item.promoted`
`memory.item.archived`
`decision.created`
`decision.updated`
`decision.confirmed`
`decision.archived`
Goal detail memory panel
Goal detail decisions panel
session extraction badge, manual extract/retry button, and summary display in the existing sessions area
desktop reconnect/refetch behavior using existing event subscription
documentation of endpoints, event payload rules, database retention/caps, extraction policy, restart policy, and non-goals

Do not include:

`POST /v1/memory/:id/promote`
`POST /v1/memory/:id/canonicalize`
`POST /v1/memory/:id/archive`
`POST /v1/decisions/:id/confirm`
`POST /v1/decisions/:id/archive`
`GET /v1/sessions/:sessionId/extractions`
generic skill invocation endpoints
generic extractor invocation endpoints
context assembly endpoints
prompt injection endpoints
recommendation endpoints
task endpoints
workflow endpoints
memory search endpoints
embedding/vector endpoints
cross-Goal memory endpoints
provider/model configuration endpoints
WebSocket commands for memory edits or extraction triggers
raw output events
extractor prompt events
raw extractor response events
context package events
recommendation events
task events
workflow events
continuous reasoning events
canonical memory state
automatic decision confirmation
full transcript processing
AI-backed extractor implementation
model provider integration
background worker infrastructure
global memory UI

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

Use the revised M5 task sequence as the required backbone:

M5-000 - Baseline verification
M5-001 - Contracts
M5-002 - SQLite migration
M5-003 - Goal-scoped read/write projections
M5-004 - Minimal manual APIs
M5-005 - Extraction state lifecycle
M5-006 - Fake extractor commit slice
M5-007 - Bounded input builder
M5-008 - Deterministic extractor
M5-009 - Refinement seed memory
M5-010 - Runner, terminal hook, and Goal-open detection
M5-011 - Reduced summary/extraction endpoints
M5-012 - Daemon proof-loop integration test
M5-013 - Desktop API wrappers
M5-014 - Goal detail memory panel
M5-015 - Goal detail decisions panel
M5-016 - Session extraction badges and summaries
M5-017 - Live refresh and final regression

You may split a task only if it is too large for one focused session.
You may combine adjacent tasks only if the combined scope remains clearly reviewable and does not delay validation.

Required Output Structure

For EACH task provide:

1. Task ID

Use the `M5-NNN` format from the revised task sequence.

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
specific lifecycle transition rules where relevant
specific UI states where relevant

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
docs

that are expected to change.

7. Dependencies

List:

prerequisite tasks
runtime dependencies
architectural dependencies
persistence dependencies
M4 behavior dependencies

8. Acceptance Criteria

These must be objectively testable.

Examples:

schema parses expected payload and rejects removed fields
migration creates expected tables and indexes
projection read returns rows after reopening the test database
endpoint returns expected schema and rejects invalid transitions
event sequence is persisted in committed order
broadcast occurs only after commit
summary, memory, decisions, extraction state, and events commit atomically
raw output is not written to the event store
candidate content is capped and redacted before persistence
duplicate extraction does not duplicate live memory rows
pending/running extraction rows become failed on daemon restart before HTTP/WS listen
opening Goal detail enqueues only eligible terminal sessions for that Goal
desktop refetches memory/decisions/sessions/summaries after committed events

Avoid subjective criteria.

9. Validation Steps

Provide:

manual validation
automated validation where appropriate
edge-case validation
targeted commands where possible
full-suite checkpoints where required

The implementing agent should know how to verify success.

Use targeted tests inside each task.
Run full `pnpm -r typecheck` and `pnpm -r test` at M5-012 and M5-017.

10. Risks / Notes

Mention:

likely pitfalls
sequencing concerns
implementation traps
temporary shortcuts allowed
privacy and event-payload traps
restart/reconciliation traps
desktop stale-state traps

Pay special attention to:

extracting only from bounded session metadata and capped M4 output tail
not requiring full transcripts
not changing M4 PTY streaming/output-tail behavior
not persisting raw output, prompts, or raw extractor responses
not logging terminal output or extracted candidate content
zod-validating extractor output before persistence
computing source fingerprints consistently
deduping memory by `(goal_id, type, content_hash)` for non-archived rows
using content-free domain events
committing projection rows and events in one transaction
broadcasting only after commit
making retry explicit and non-duplicating
limiting automatic promotion to low-risk deterministic rules
leaving extracted decisions proposed and user-confirmable
marking stale `pending`/`running` extractions failed on boot
handling truncated or unavailable output as visible UI states
preserving M1/M2/M3/M4 regressions

Task Sequencing Requirements

The task list should:

start with baseline verification
prove contracts before daemon and desktop code depends on them
prove migration before projections use new tables
prove Goal-scoped memory and decision projections before extraction writes them
prove manual APIs before automatic extraction depends on them
prove extraction state before any extractor runs
prove fake extractor commit and transaction boundaries before deterministic extraction
prove bounded input before extraction logic broadens source handling
prove deterministic extractor with fixtures before runner integration
prove refinement seed memory before session-output extraction broadens evidence sources
prove runner, terminal hook, and Goal-open detection before desktop extraction controls
prove daemon proof loop before desktop UI
prove desktop read/actions before live refresh wiring
run full regression before final documentation/review

Preferred sequencing shape:

baseline before new M5 code
contracts before daemon and desktop imports
migration before projections
projections before APIs
manual APIs before extraction automation
extraction state before extractor commit
fake extractor before deterministic extractor
input builder before deterministic extractor
daemon integration before desktop implementation
desktop API wrappers before panels
memory panel before decisions panel
panels before session badges and summaries
live refresh before final regression

Deliverables

At the end provide:

1. Task Dependency Graph

Show:

sequencing
parallelizable tasks
blocking tasks
persistence gates
integration gates
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
"is this overengineered?" reviews

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
manual desktop smoke testing
UX feel decisions
security-sensitive choices
resolving business/product ambiguity
deciding when "good enough" is good enough

Humans should own judgment, not boilerplate.

Cleaner Assignment Rule

Opus 4.7 = architect / decomposer
GPT 5.5 = reviewer / simplifier / drift detector
Sonnet 4.6 = main builder
GPT 5.4/Codex = bounded task executor
Human = product judgment + final validation

Task Routing Matrix

Task type | Best model
--- | ---
Architecture design | Opus 4.7
Milestone decomposition | Opus 4.7
Scope conflict resolution | Opus 4.7 or GPT 5.5
Architecture drift review | GPT 5.5
MVP simplification | GPT 5.5
Runtime integration | Sonnet 4.6
UI implementation | Sonnet 4.6
API implementation | Sonnet 4.6
Debugging implementation failures | Sonnet 4.6, then GPT 5.5 if systemic
SQLite migrations | GPT 5.4/Codex
Zod schemas/contracts | GPT 5.4/Codex
Unit tests | GPT 5.4/Codex
Simple endpoints | GPT 5.4/Codex
Bounded refactors | GPT 5.4/Codex or Sonnet
Extraction runner integration | Sonnet 4.6
Deterministic extractor fixtures | GPT 5.4/Codex
Desktop state/live refresh | Sonnet 4.6
UX/product feel | Human
Final milestone acceptance | Human + GPT 5.5

3. Recommended Review Gates

Suggest:

where architectural review should happen
where persistence review should happen
where integration testing should happen
where runtime validation should happen
where desktop manual smoke testing should happen
where final scope/non-goal validation should happen

before continuing further.

Required Review Gates

Gate 1: After M5-002, verify contracts and SQLite migration surface before daemon memory/decision implementation.
Gate 2: After M5-006, verify projection helpers, manual APIs, extraction state, fake extractor commit, atomic transaction boundaries, and content-free events.
Gate 3: After M5-010, verify bounded input, deterministic extraction, refinement seed memory, runner behavior, terminal hook, Goal-open detection, and restart reconciliation.
Gate 4: After M5-012, run `pnpm -r typecheck` and `pnpm -r test`; review daemon API, event, persistence, idempotency, restart, privacy, and M1-M4 regression behavior.
Gate 5: After M5-016, run desktop manual smoke with one refined Goal, one attached workspace, one completed/stopped session, extraction retry, memory promote/archive, decision confirm/archive, reload, and daemon restart.
Gate 6: After M5-017, verify Definition of Done, final docs, and non-goals.

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

Optimize for proving the shared-memory loop quickly.

Do not optimize for hypothetical future scale.
