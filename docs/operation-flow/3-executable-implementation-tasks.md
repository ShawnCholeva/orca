You are acting as a principal engineer decomposing Milestone 6 of an AI orchestration platform into executable implementation tasks for an AI-assisted engineering workflow.

I have attached:

Product Brief
Technical Design Document
MVP Specification
Level 4 and Level 5 specifications
Milestone 1 implementation plan
Milestone 2 implementation plan
Milestone 3 implementation plan
Milestone 4 implementation plan and validation notes
Milestone 5 implementation plan and final validation notes
Milestone 6 architecture and simplified execution plan: `docs/milestones/6.md`

Your task is to:

generate bounded executable implementation tasks

for Milestone 6.

Milestone 6 is:

Context Assembly

The intended proof point is:

```text
User opens a Goal and starts the new-session flow
  -> chooses adapter, workspace, role, and short session objective
  -> daemon reads bounded Goal/refinement/workspace/memory/decision/summary projections
  -> daemon runs one internal session-preparation job boundary
  -> deterministic assembler produces compact role-aware sections
  -> daemon validates, redacts, caps, and persists package + assembly events atomically
  -> daemon broadcasts committed events with ids and small metadata only
  -> desktop shows context preview, source counts, status, warnings, and retry/regenerate
  -> user starts a normal M4 PTY session with contextPackageId
  -> adapter receives context through an explicit adapter-safe path or declares preview-only
  -> session row stores contextPackageId
  -> package, assembly metadata, and session association survive daemon restart
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
memory/decision/session-summary-aware from Milestone 5
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
safe context delivery

Avoid giant tasks.
Avoid vague tasks.
Avoid architecture-only tasks with no executable output.

Important Constraints

Do NOT:

redesign the architecture
expand scope
drift into Milestone 7 recommendations
drift into task/work-unit generation
drift into validation recommendations
drift into conflict detection
drift into Level 4 supervised execution
drift into Level 5 autonomy
introduce cloud infrastructure
introduce distributed queues, workers, schedulers, workflow engines, or automatic retry systems
introduce AI provider SDKs, provider configuration UI, model selection, prompt libraries, prompt experiments, token-accurate accounting, or provider cost tracking
introduce generic skill invocation APIs or public context-builder invocation APIs
introduce prompt injection frameworks or generic adapter prompt routing
invent unverified CLI flags for Claude Code, opencode, codex, or any other adapter
build recommendations, tasks, workflows, conflict detection, command-center panels, analytics, autonomy controls, or provider/model settings
build cross-Goal memory, workspace indexing, workspace scanning, file watching, knowledge graphs, embeddings, vector search, semantic search, or global search
build memory consolidation, ranking/relevance engines, aging/decay systems, policy/governance, or audit engines
build full transcript capture, full transcript extraction, transcript replay, transcript export, or transcript analytics
read raw M4 output tails during M6 context assembly
persist raw terminal output, assembler prompts, raw assembler input/output, raw model responses, or model reasoning in the event store
write rendered context or large source text into domain event payloads
add global context dashboards, context package history pages, diff UI, editable context UI, new top-level navigation, or deep-link routing
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
M5 Goal-scoped memory, decisions, session summaries, extraction events, and Goal detail memory/decision UI
post-commit-only event broadcasts
SQLite as the internal storage boundary
the existing WebSocket event channel for live refresh

But optimize for:

MVP execution speed, privacy, and operational clarity.

Milestone 6 Scope Must Match The Revised Plan

The task list must implement only the simplified M6 surface from `docs/milestones/6.md`.

Include:

contract schemas for context packages, context assemblies, context source refs, roles, statuses, failure codes, create/list/detail responses, M6 event literals, and `CreateSessionRequest` / session response extension with optional `contextPackageId`
`context_packages` table
`context_assemblies` table
`sessions.context_package_id` column
minimal indexes for Goal package reads, Goal assembly reads, active request idempotency, assembly reconciliation, and session package lookup
compact source attribution stored as JSON on `context_packages`
Goal-scoped context package create/list/detail use cases
manual retry/regenerate through `POST /v1/goals/:goalId/context-packages` with optional `replacePackageId`
immutable package rows with `status='ready'` only in M6
assembly lifecycle states `pending`, `running`, `succeeded`, `failed`
failure codes `invalid_input`, `invalid_output`, `output_too_large`, `goal_archived`, `source_missing`, `delivery_unavailable`, `internal_error`, `daemon_restart`
boot reconciliation of stale `pending`/`running` context assemblies to failed with `daemon_restart`
one internal `orca/session-preparation` skill descriptor for diagnostics only
one daemon-local assembler interface
one deterministic production assembler
fake assembler support for tests
bounded input builder that reads only Goal row, latest refinement fields, attached workspace metadata already known from M3, M5 memory rows, M5 decision rows, and M5 sibling session summaries
static or unit test coverage proving M6 context assembly does not import/read raw M4 output tails or transcript modules
deterministic memory, decision, and sibling-summary selection rules
role-aware context for `architect`, `engineer`, `reviewer`, and `generalist`
sectioned plaintext renderer
adapter framing/helper logic where needed
zod validation of assembler input/output and HTTP request/response shapes
normalization, content caps, best-effort secret redaction, byte-budget enforcement, and advisory token estimate before persistence and adapter delivery
hard cap defaults from the plan: 32 KiB rendered context, 4 KiB objective, 8 KiB per section, 30 memory items, 20 decisions, 5 sibling summaries, 256 chars failure message
confirmation-required decisions pinned and labeled; fail with `output_too_large` if required decision material cannot fit
idempotency by Goal, adapter, role, objective hash, workspace, source fingerprint, assembler version, and optional replacement package
events:
`context.assembly.requested`
`context.assembly.completed`
`context.assembly.failed`
`context.package.created`
event payloads with ids/counts/status/byte sizes/failure codes only
`POST /v1/goals/:goalId/context-packages`
`GET /v1/goals/:goalId/context-packages`
`GET /v1/context-packages/:id`
`POST /v1/sessions` extension with optional `contextPackageId`
session read responses and `session.created` including `contextPackageId` when present
adapter delivery metadata:
`mode: 'initial_input' | 'context_file' | 'preview_only'`
shell/manual `initial_input` only where context remains visible and user-driven
`context_file` only for adapters with verified safe startup support
`preview_only` fallback for adapters without verified safe delivery
no rendered context bytes in process args, environment variables, logs, or events
session-scoped context files with mode `0600` where used
Goal detail new-session controls for adapter/workspace/role/objective
prepare/skip buttons
context preview/status/source summary/budget usage/warnings
retry/regenerate action
session row context badge
desktop reconnect/refetch behavior using existing event subscription
documentation of endpoints, event payload rules, database retention/caps, assembly policy, adapter-delivery policy, restart policy, and non-goals

Do not include:

`POST /v1/context-packages/:id/regenerate`
`GET /v1/sessions/:sessionId/context`
inline `assembleContext` inside `POST /v1/sessions`
package archive/update/delete endpoints
generic skill invocation endpoints
generic context-builder invocation endpoints
prompt injection endpoints
recommendation endpoints
task endpoints
workflow endpoints
conflict-detection endpoints
memory search endpoints
embedding/vector endpoints
cross-Goal memory endpoints
provider/model configuration endpoints
WebSocket commands for context preparation or session launch
raw terminal output events
rendered context payload events
source memory/decision/summary text events
raw assembler input/output events
assembler prompt events
raw model response events
recommendation events
task events
workflow events
continuous reasoning events
automatic session launch
automatic context retry/backoff
AI-backed assembler implementation
model provider integration
background worker infrastructure
context package source table
global context UI
package history/diff/editor UI

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

Use the revised M6 task sequence as the required backbone:

M6-000 - Baseline
M6-001 - Contracts first
M6-002 - SQLite migration
M6-003 - Projection reads/writes
M6-004 - Assembly state and events with fake output
M6-005 - Boot reconciliation
M6-006 - Bounded input builder
M6-007 - Selection rules
M6-008 - Deterministic assembler and renderer
M6-009 - HTTP routes
M6-010 - Session create link
M6-011 - Adapter delivery
M6-012 - Desktop API wrappers
M6-013 - New-session context controls
M6-014 - Preview, status, retry
M6-015 - Session badge and restart UI
M6-016 - End-to-end proof and regression

You may split a task only if it is too large for one focused session.
You may combine adjacent tasks only if the combined scope remains clearly reviewable and does not delay validation.

Required Output Structure

For EACH task provide:

1. Task ID

Use the `M6-NNN` format from the revised task sequence.

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
specific adapter delivery rules where relevant

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
M5 projection dependencies

8. Acceptance Criteria

These must be objectively testable.

Examples:

schema parses expected payload and rejects removed fields
migration creates expected tables, columns, indexes, and foreign keys
projection read returns rows after reopening the test database
duplicate active package request returns the existing assembly/package
failed assembly retry creates a new assembly row
event sequence is persisted in committed order
broadcast occurs only after commit
context package row, assembly row, and events commit atomically
rendered context and source text are not written to the event store
raw M4 output tails and full transcripts are not read by M6 context assembly
confirmation-required decisions are present or assembly fails with `output_too_large`
pending/running assembly rows become failed on daemon restart before HTTP/WS listen
session creation without context preserves M4 behavior
session creation with context stores and returns `contextPackageId`
adapter delivery does not place rendered context bytes in argv/env/logs
desktop refetches context packages and sessions after committed context events

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
Run full `pnpm -r typecheck` and `pnpm -r test` at M6-010 and M6-016.

10. Risks / Notes

Mention:

likely pitfalls
sequencing concerns
implementation traps
temporary shortcuts allowed
privacy and event-payload traps
restart/reconciliation traps
desktop stale-state traps
adapter delivery traps

Pay special attention to:

assembling context only from bounded Goal/refinement/workspace metadata and M5 memory/decision/session-summary projections
not requiring full transcripts
not reading raw M4 output tails during M6 context assembly
not persisting raw terminal output, rendered context, source text, raw assembler input/output, prompts, or raw model responses in events
not logging rendered context, source snippets, prompts, raw assembler output, or secrets
zod-validating assembler input/output before persistence
computing source fingerprints and request fingerprints consistently
using content-free domain events
committing projection rows and events in one transaction
broadcasting only after commit
making retry/regenerate explicit and non-duplicating
leaving package rows immutable in M6
pinning confirmation-required decisions and failing when required content cannot fit
marking stale `pending`/`running` assemblies failed on boot
handling sparse, truncated, failed, pending, running, completed, and preview-only states in UI
preserving M1/M2/M3/M4/M5 regressions

Task Sequencing Requirements

The task list should:

start with baseline verification
prove contracts before daemon and desktop code depends on them
prove migration before projections use new tables/columns
prove package and assembly projections before assembler/usecase work
prove atomic fake assembly before deterministic input/selection complexity
prove boot reconciliation before HTTP/UI can surface stale states
prove bounded input before selection and rendering
prove pure selection before deterministic assembler
prove assembler/renderer before HTTP routes expose package creation
prove HTTP routes before desktop wrappers
prove session create link before adapter delivery
prove adapter delivery before desktop start-session UX claims context delivery
prove desktop read/actions before live refresh and badges
run full regression before final documentation/review

Preferred sequencing shape:

baseline before new M6 code
contracts before daemon and desktop imports
migration before projections
projections before use cases
fake assembler before deterministic assembler
input builder before selection rules and renderer
routes before desktop wrappers
session link before adapter delivery
desktop API wrappers before controls
controls before preview/status/retry
preview/status before session badges
full proof loop before final regression

Deliverables

At the end provide:

1. Task Dependency Graph

Show:

sequencing
parallelizable tasks
blocking tasks
persistence gates
adapter-delivery gates
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
Context input/selection fixtures | GPT 5.4/Codex
Deterministic assembler fixtures | GPT 5.4/Codex
Session create and adapter delivery integration | Sonnet 4.6
Desktop state/live refresh | Sonnet 4.6
UX/product feel | Human
Final milestone acceptance | Human + GPT 5.5

3. Recommended Review Gates

Suggest:

where architectural review should happen
where persistence review should happen
where integration testing should happen
where adapter-delivery validation should happen
where desktop manual smoke testing should happen
where final scope/non-goal validation should happen

before continuing further.

Required Review Gates

Gate 1: After M6-002, verify contracts, SQLite migration surface, session column, indexes, and M5-upgrade path before daemon context implementation.
Gate 2: After M6-005, verify projection helpers, fake assembly use case, atomic transaction boundaries, content-free events, idempotency, and boot reconciliation.
Gate 3: After M6-008, verify bounded input, no raw output-tail/transcript access, deterministic selection, assembler/renderer caps, redaction, source refs, and confirmation-required decision handling.
Gate 4: After M6-010, run `pnpm -r typecheck` and `pnpm -r test`; review daemon API, event, persistence, idempotency, restart, privacy, session-create, and M1-M5 regression behavior.
Gate 5: After M6-011, verify adapter delivery safety: no rendered context in argv/env/logs, `0600` context files where used, preview-only fallback when delivery is not verified, and no-context M4 session behavior unchanged.
Gate 6: After M6-015, run desktop manual smoke with one refined Goal, one attached workspace, M5 memory/decisions/session summaries, context prepare, retry/regenerate, session start with package, preview-only adapter state, reload, and daemon restart.
Gate 7: After M6-016, verify Definition of Done, final docs, and non-goals.

Most Important Instruction

Generate tasks as if:

an AI orchestration system will eventually execute them.

This means:

strong boundaries
explicit contracts
deterministic validation
minimal ambiguity
