You are acting as a principal engineer decomposing Milestone 7 of an AI orchestration platform into executable implementation tasks for an AI-assisted engineering workflow.

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
Milestone 6 implementation plan and final validation notes
Milestone 7 architecture and simplified execution plan: `docs/milestones/7.md`

Your task is to:

generate bounded executable implementation tasks

for Milestone 7.

Milestone 7 is:

Suggested Orchestration

The intended proof point is:

```text
Meaningful Goal activity occurs
  -> daemon evaluates deterministic orchestration triggers
  -> daemon gathers bounded Goal, task, workspace, session, memory, decision, summary, and context-package inputs
  -> daemon runs explicit internal task/recommendation/conflict jobs only when needed
  -> deterministic providers generate bounded tasks, recommendations, conflicts, and supervision records
  -> daemon validates, deduplicates, supersedes, caps, and persists orchestration state atomically
  -> daemon records content-free lifecycle events with ids, counts, statuses, and failure codes only
  -> desktop shows Goal-scoped tasks, recommendations, and conflicts
  -> user accepts, rejects, dismisses, modifies, or resolves suggestions
  -> accepted recommendations can prefill existing M3/M4/M5/M6/M7 flows but never auto-launch work
  -> validation recommendations appear after implementation-like activity
  -> conservative conflicts are surfaced for human resolution
  -> task, recommendation, conflict, and feedback state survives daemon restart
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
context-package-aware from Milestone 6
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
safe suggestion-only behavior

Avoid giant tasks.
Avoid vague tasks.
Avoid architecture-only tasks with no executable output.

Important Constraints

Do NOT:

redesign the architecture
expand scope
drift into Level 4 supervised execution
drift into Level 5 autonomy
introduce approval gates
introduce automatic session launch
introduce automatic validation execution
introduce automatic task execution
introduce agent task assignment or multi-agent scheduling
introduce multi-step workflow planning
introduce workflow engines, distributed queues, background workers, schedulers, or continuous daemon reasoning loops
introduce cloud infrastructure
introduce provider/model SDKs, provider configuration UI, model selection, prompt libraries, prompt experiments, token-accurate accounting, provider cost tracking, or prompt-management frameworks
introduce generic skill invocation APIs, generic reasoning-job APIs, generic action execution APIs, or generic workflow APIs
introduce public recommendation execution endpoints
introduce cross-Goal recommendations or cross-Goal memory
introduce workspace indexing, workspace scanning, file watching, knowledge graphs, embeddings, vector search, semantic search, or global search
introduce memory consolidation, semantic ranking, relevance engines, aging/decay systems, analytics dashboards, policy/governance, or audit engines
introduce full transcript processing, full transcript replay, transcript export, or transcript analytics
read raw M4 output tails during M7 orchestration unless an existing M5 projection already exposes a bounded summary field
persist raw terminal output, raw provider input/output, prompts, raw model responses, model reasoning, recommendation bodies, conflict bodies, feedback comments, task descriptions, acceptance criteria, validation steps, or large source text in domain event payloads
write proposed action bodies or source memory/decision/summary text into domain event payloads
add global task dashboards, global recommendation pages, command-center panels, recommendation analytics, dependency graph views, new top-level navigation, or deep-link routing
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
M6 bounded context packages, deterministic session preparation, context preview/status UI, contextPackageId session association, adapter delivery policy, and restart-safe context persistence
post-commit-only event broadcasts
SQLite as the internal storage boundary
the existing WebSocket event channel for live refresh

But optimize for:

MVP execution speed, privacy, operational clarity, and suggestion-only supervision.

Milestone 7 Scope Must Match The Revised Plan

The task list must implement only the simplified M7 surface from `docs/milestones/7.md`.

Include:

contract schemas for tasks, task generations, recommendations, recommendation generations, recommendation feedback, conflicts, source refs, proposed actions, roles, statuses, failure codes, M7 event literals, and `CreateSessionRequest` / session response and `CreateContextPackageRequest` / context package response extensions with optional `taskId` and `fromRecommendationId`
`tasks` table
`task_generations` table
`recommendations` table
`recommendation_generations` table
`recommendation_feedback` table
`conflicts` table
`sessions.task_id` and `sessions.from_recommendation_id` columns
`context_packages.task_id` and `context_packages.from_recommendation_id` columns
minimal indexes for Goal-scoped task/recommendation/conflict reads, active generation idempotency, active task/recommendation/conflict deduplication, session task lookup, and context package task lookup
Goal-scoped task create/list/update/split/generate use cases
Goal-scoped recommendation generate/list/detail use cases
recommendation accept/reject/dismiss/modify use cases
conflict list/resolve/dismiss use cases
manual regenerate/re-evaluate through `POST /v1/goals/:goalId/tasks/generate` and `POST /v1/goals/:goalId/recommendations/generate`
generation lifecycle states `pending`, `running`, `succeeded`, `failed`
task statuses `proposed`, `open`, `in_progress`, `blocked`, `done`, `cancelled`, `archived`
recommendation statuses `proposed`, `accepted`, `rejected`, `dismissed`, `modified`, `superseded`
conflict statuses `open`, `resolved`, `dismissed`
failure codes `invalid_input`, `invalid_output`, `provider_error`, `daemon_restart`, `goal_archived`, `sparse_input`, `internal_error`
boot reconciliation of stale `pending`/`running` task and recommendation generation rows to failed with `daemon_restart`
internal `orca/recommendation-generation`, `orca/task-generation`, and `orca/conflict-detection` skill descriptors for diagnostics only
one daemon-local `RecommendationProvider` interface
one deterministic production recommendation provider
fake recommendation provider support for tests
one deterministic task generator
one deterministic conflict detector set
bounded input builders that read only existing Goal/refinement/workspace/session/memory/decision/session-summary/context-package projections and M7 task/recommendation/conflict rows
static or unit test coverage proving M7 orchestration does not import/read raw M4 output tails or transcript modules
deterministic task generation from Goal refinement and bounded M5/M6 evidence
deterministic recommendation rules for `create_session`, `continue_session`, `review_output`, `refine_goal`, `split_task`, `run_validation`, `resolve_conflict`, `update_plan`, `ask_user`, `mark_complete`, and `pause_work`
deterministic validation and review recommendation rules after implementation-like activity
conservative conflict detectors for active workspace overlap, contradictory confirmed decisions, reviewer rejection, blockers, and unresolved task-blocking questions
source attribution stored as compact JSON ids on task/recommendation/conflict rows
zod validation of generator/provider input/output and HTTP request/response shapes
normalization, content caps, best-effort secret redaction where persisted text is accepted, request fingerprinting, and duplicate/supersede behavior before persistence
hard cap defaults from the plan: 256 char recommendation title, 4 KiB recommendation rationale, 4 KiB proposedAction JSON, 32 source refs per recommendation, 256 char task title, 8 KiB task description, 20 acceptance criteria, 20 validation steps, 4 KiB conflict resolution note, 2 KiB feedback note, 256 char failure message
idempotency by Goal, trigger kind, trigger source id, provider/generator version, input fingerprint, active row state, and proposed action/task/conflict fingerprint as applicable
events:
`task.generation.requested`
`task.generated`
`task.generation.failed`
`task.created`
`task.updated`
`task.split`
`task.status_changed`
`task.associated_with_session`
`task.associated_with_context_package`
`recommendation.generation.requested`
`recommendation.generated`
`recommendation.generation.failed`
`recommendation.accepted`
`recommendation.rejected`
`recommendation.dismissed`
`recommendation.modified`
`recommendation.superseded`
`conflict.detected`
`conflict.resolved`
`conflict.dismissed`
`user.feedback.recorded`
event payloads with ids/counts/statuses/changed field keys/failure codes only
`POST /v1/goals/:goalId/tasks/generate`
`GET /v1/goals/:goalId/tasks`
`POST /v1/goals/:goalId/tasks`
`PATCH /v1/tasks/:id`
`POST /v1/tasks/:id/split`
`POST /v1/tasks/:id/associate-session`
`POST /v1/goals/:goalId/recommendations/generate`
`GET /v1/goals/:goalId/recommendations`
`GET /v1/recommendations/:id`
`POST /v1/recommendations/:id/accept`
`POST /v1/recommendations/:id/reject`
`POST /v1/recommendations/:id/dismiss`
`PATCH /v1/recommendations/:id`
`GET /v1/goals/:goalId/conflicts`
`POST /v1/conflicts/:id/resolve`
`POST /v1/sessions` extension with optional `taskId` and `fromRecommendationId`
`POST /v1/goals/:goalId/context-packages` extension with optional `taskId` and `fromRecommendationId`
session read responses and `session.created` including optional task/recommendation association ids when present
context package read responses and `context.package.created` including optional task/recommendation association ids when present
Goal detail Tasks panel
Goal detail Recommendations panel
Goal detail Conflicts banner/drawer
desktop API wrappers for all new routes
desktop accept/reject/dismiss/modify/resolve flows
desktop accepted-recommendation prefill into existing M4 session creation and M6 context preparation flows without auto-launching
desktop reconnect/refetch behavior using existing event subscription
documentation of endpoints, event payload rules, database retention/caps, generation policy, trigger policy, feedback policy, conflict policy, restart policy, and non-goals

Do not include:

`POST /v1/recommendations/:id/execute`
`POST /v1/recommendations/:id/regenerate`
`GET /v1/recommendations` cross-Goal list
`GET /v1/tasks` cross-Goal list
`POST /v1/skills/:id/invoke`
`POST /v1/tasks/:id/archive` as a separate endpoint
generic skill invocation endpoints
generic reasoning job endpoints
generic action execution endpoints
generic workflow endpoints
approval-gate endpoints
workflow execution endpoints
task assignment endpoints
recommendation history/analytics endpoints
provider/model configuration endpoints
prompt template endpoints
memory search endpoints
embedding/vector endpoints
cross-Goal memory endpoints
WebSocket commands for task/recommendation/conflict mutation
raw terminal output events
rendered context payload events
raw provider input/output events
provider prompt/template events
raw model response events
raw recommendation body events
raw conflict body events
raw task description/acceptance-criteria/validation-step events
feedback comment events
continuous reasoning events
automatic session launch
automatic context preparation
automatic validation command execution
automatic task status transitions from session activity without user action
automatic retry/backoff
AI-backed recommendation provider implementation
model provider integration
background worker infrastructure
task source join tables
recommendation source join tables
global task UI
global recommendation UI
recommendation history/diff/editor pages
task board/Gantt/dependency graph UI

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

Use the revised M7 task sequence as the required backbone:

M7-000 - Baseline Verification
M7-001 - Contracts first
M7-002 - SQLite migration
M7-003 - Tasks projection and persistence
M7-004 - Recommendations projection and persistence
M7-005 - Conflicts projection and persistence
M7-006 - Generation lifecycle model
M7-007 - Deterministic task generator
M7-008 - Deterministic recommendation provider and input builder
M7-009 - Validation and review recommendation rules
M7-010 - Conflict detectors
M7-011 - Orchestrator triggers and runner
M7-012 - Boot reconciliation
M7-013 - Task HTTP routes
M7-014 - Recommendation HTTP routes
M7-015 - Conflict HTTP routes
M7-016 - Session create extension
M7-017 - Context package create extension
M7-018 - Internal skill descriptors
M7-019 - Desktop API wrappers
M7-020 - Tasks panel UI
M7-021 - Recommendations panel UI
M7-022 - Conflicts banner UI
M7-023 - Live refresh integration
M7-024 - End-to-end proof, restart test, and full regression

You may split a task only if it is too large for one focused session.
You may combine adjacent tasks only if the combined scope remains clearly reviewable and does not delay validation.

Required Output Structure

For EACH task provide:

1. Task ID

Use the `M7-NNN` format from the revised task sequence.

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
specific accepted-recommendation prefill rules where relevant

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
M3 refinement/workspace dependencies
M4 session behavior dependencies
M5 projection dependencies
M6 context package dependencies

8. Acceptance Criteria

These must be objectively testable.

Examples:

schema parses expected payload and rejects removed fields
migration creates expected tables, columns, indexes, and foreign keys
projection read returns rows after reopening the test database
duplicate active generation request returns the existing generation row
failed generation retry creates a new generation row
event sequence is persisted in committed order
broadcast occurs only after commit
task/recommendation/conflict rows and events commit atomically
recommendation superseding preserves accepted/rejected/dismissed audit history
task splitting creates child rows and preserves parent linkage
accepting a recommendation persists feedback and returns proposedAction without auto-launching work
conflict resolution auto-dismisses the linked `resolve_conflict` recommendation
raw M4 output tails and full transcripts are not read by M7 orchestration
raw provider input/output, recommendation bodies, conflict bodies, task bodies, feedback notes, source text, and proposedAction bodies are not written to the event store
pending/running generation rows become failed on daemon restart before HTTP/WS listen
session creation without task/recommendation ids preserves M4 behavior
session creation with task/recommendation ids stores and returns those ids
context package creation without task/recommendation ids preserves M6 behavior
context package creation with task/recommendation ids stores and returns those ids
desktop refetches tasks, recommendations, conflicts, sessions, and context packages after committed M7 events

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
Run full `pnpm -r typecheck` and `pnpm -r test` at M7-010 and M7-024.

10. Risks / Notes

Mention:

likely pitfalls
sequencing concerns
implementation traps
temporary shortcuts allowed
privacy and event-payload traps
restart/reconciliation traps
desktop stale-state traps
accepted-recommendation prefill traps
false-positive conflict traps
duplicate recommendation/task traps

Pay special attention to:

generating suggestions only from bounded Goal/refinement/workspace/session/memory/decision/session-summary/context-package/task/recommendation/conflict projections
not requiring full transcripts
not reading raw M4 output tails during M7 orchestration
not persisting raw terminal output, raw provider input/output, source text, raw recommendation/conflict/task bodies, proposedAction bodies, prompts, raw model responses, or feedback comments in events
not logging provider inputs/outputs, source snippets, proposedAction bodies, raw model data, or secrets
zod-validating generator/provider input/output before persistence
computing input fingerprints, request fingerprints, task fingerprints, recommendation fingerprints, and conflict fingerprints consistently
using content-free domain events
committing projection rows and events in one transaction
broadcasting only after commit
making regenerate/re-evaluate explicit and non-duplicating
leaving accepted/rejected/dismissed recommendation rows immutable except audit-safe read metadata
marking stale `pending`/`running` generations failed on boot
handling sparse, failed, pending, running, generated, modified, accepted, rejected, dismissed, superseded, open-conflict, resolved-conflict, archived-source, and empty states in UI
preserving M1/M2/M3/M4/M5/M6 regressions

Task Sequencing Requirements

The task list should:

start with baseline verification
prove contracts before daemon and desktop code depends on them
prove migration before projections use new tables/columns
prove task/recommendation/conflict projections before generation/usecase work
prove generation lifecycle and idempotency before deterministic provider complexity
prove deterministic task generation before task routes expose generation
prove recommendation provider and rules before recommendation routes expose lifecycle actions
prove conflict detectors before conflict routes expose resolution
prove orchestrator triggers before boot reconciliation and HTTP/UI rely on background state
prove HTTP routes before desktop wrappers
prove session/context extension without regressing M4/M6 before accepted-recommendation UI claims prefill behavior
prove desktop API wrappers before panels
prove panels before live refresh
run full regression before final documentation/review

Preferred sequencing shape:

baseline before new M7 code
contracts before daemon and desktop imports
migration before projections
projections before use cases
generation lifecycle before deterministic generators/providers
input builders before rules and runner
routes before desktop wrappers
session/context extension before accepted-recommendation prefill UI
desktop API wrappers before panels
panels before live refresh
full proof loop before final regression

Deliverables

At the end provide:

1. Task Dependency Graph

Show:

sequencing
parallelizable tasks
blocking tasks
persistence gates
generation/idempotency gates
accepted-recommendation integration gates
desktop integration gates
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
Task/recommendation/conflict fixtures | GPT 5.4/Codex
Deterministic provider/rule fixtures | GPT 5.4/Codex
Session/context association integration | Sonnet 4.6
Desktop state/live refresh | Sonnet 4.6
UX/product feel | Human
Final milestone acceptance | Human + GPT 5.5

3. Recommended Review Gates

Suggest:

where architectural review should happen
where persistence review should happen
where generation/idempotency testing should happen
where accepted-recommendation integration should happen
where desktop manual smoke testing should happen
where final scope/non-goal validation should happen

before continuing further.

Required Review Gates

Gate 1: After M7-002, verify contracts, SQLite migration surface, session/context package columns, indexes, and upgrade path from an M6 database before daemon orchestration implementation.
Gate 2: After M7-006, verify projection helpers, generation lifecycle, request fingerprinting, active idempotency, transaction boundaries, and content-free events.
Gate 3: After M7-010, run `pnpm -r typecheck` and `pnpm -r test`; verify bounded inputs, no raw output-tail/transcript access, deterministic task/recommendation/conflict rules, source refs, caps, superseding, and false-positive conflict handling.
Gate 4: After M7-012, verify orchestrator trigger mapping, single-flight behavior, dirty-flag re-evaluation, boot reconciliation, daemon restart behavior, and broadcast-after-commit.
Gate 5: After M7-017, verify daemon API, event, persistence, idempotency, restart, privacy, session-create, context-create, and M1-M6 regression behavior for association extensions.
Gate 6: After M7-023, run desktop manual smoke with one refined Goal, one attached workspace, M5 memory/decisions/session summaries, an M6 context package, task generation, recommendation generation, accept/reject/dismiss/modify, context/session prefill, conflict detection/resolution, reload, and daemon restart.
Gate 7: After M7-024, run `pnpm -r typecheck` and `pnpm -r test`; verify Definition of Done, final docs, and non-goals.

Most Important Instruction

Generate tasks as if:

an AI orchestration system will eventually execute them.

This means:

strong boundaries
explicit contracts
deterministic validation
minimal ambiguity
