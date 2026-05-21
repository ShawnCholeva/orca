You are implementing a bounded Milestone 7 task for the Orca orchestration platform from the generated implementation task list in `docs/implementation-plans/milestone-7.md`.

Follow the assigned implementation task exactly.

Do not use the superpowers plugin.

Do not redesign architecture.

Do not expand scope.

Do not introduce future systems.

Optimize for:

correctness
simplicity
maintainability
clean implementation
fast validation
deterministic behavior
privacy-preserving orchestration
content-free events
suggestion-only supervision
preserving future Level 4/Level 5 extensibility

Current task:

M7-003

Prerequisite:

Milestone 6 must be complete and green before any M7 task begins. M7-000 baseline verification must already be complete and recorded before any implementation task after M7-000 begins. If the baseline is not recorded, stop and run M7-000 first.

Important architectural constraints:

local-first
event-driven
Goal-scoped
Workspace-aware
daemon owns state
SQLite remains the internal storage boundary
existing M1/M2/M3/M4/M5/M6 wire shapes remain valid unless the assigned M7 task explicitly extends them
M1 Goal creation and live event behavior must remain valid
M2 plugin and skill registry behavior must remain valid
M3 refined Goal and workspace behavior must remain valid
M4 PTY sessions, adapters, lifecycle events, capped output tails, restart reconciliation, and embedded terminal behavior must remain valid
M5 Goal-scoped memory, decisions, session summaries, extraction events, and Goal detail memory/decision UI must remain valid
M6 bounded context packages, deterministic session preparation, context preview/status UI, contextPackageId session association, adapter delivery policy, and restart-safe context persistence must remain valid
daemon write paths that emit events must persist events and projection rows atomically
event bus broadcasts happen only after COMMIT succeeds
M7 is suggestion-only: it may recommend, prefill, associate, record feedback, and surface conflicts, but it must not execute work automatically
M7 rows are Goal-scoped
M7 source attribution is compact JSON on the owning row
M7 must use bounded projection reads, not workspace scans, transcripts, or raw M4 output tails
M7 events are control-plane signals with ids/counts/statuses/changed-field keys/failure codes only
M7 events must not include recommendation rationale text, task title/description/acceptance criteria/validation steps, conflict description/resolution note, feedback notes, proposedAction bodies, rendered context, raw source text, memory content, decision text, summary text, raw terminal output, prompts, raw provider input/output, raw model responses, or model reasoning
terminal output remains outside the general event store
terminal input and resize remain outside domain events

Milestone 7 proof point:

Meaningful Goal activity occurs
daemon evaluates deterministic orchestration triggers
daemon gathers bounded Goal, task, workspace, session, memory, decision, summary, and context-package inputs
daemon runs explicit internal task/recommendation/conflict jobs only when needed
deterministic providers generate bounded tasks, recommendations, conflicts, and supervision records
daemon validates, deduplicates, supersedes, caps, and persists orchestration state atomically
daemon records content-free lifecycle events with ids, counts, statuses, and failure codes only
desktop shows Goal-scoped tasks, recommendations, and conflicts
user accepts, rejects, dismisses, modifies, or resolves suggestions
accepted recommendations can prefill existing M3/M4/M5/M6/M7 flows but never auto-launch work
validation recommendations appear after implementation-like activity
conservative conflicts are surfaced for human resolution
task, recommendation, conflict, and feedback state survives daemon restart

Milestone 7 included surface:

contract schemas for tasks, task generations, recommendations, recommendation generations, recommendation feedback, conflicts, source refs, proposed actions, roles, statuses, failure codes, trigger kinds, M7 event literals, and HTTP request/response payloads
CreateSessionRequest extension with optional taskId and fromRecommendationId
session read response extension with optional taskId and fromRecommendationId
session.created event extension with optional taskId and fromRecommendationId
CreateContextPackageRequest extension with optional taskId and fromRecommendationId
context package read response extension with optional taskId and fromRecommendationId
context.package.created event extension with optional taskId and fromRecommendationId
tasks table
task_generations table
recommendations table
recommendation_generations table
recommendation_feedback table
conflicts table
sessions.task_id column
sessions.from_recommendation_id column
context_packages.task_id column
context_packages.from_recommendation_id column
minimal indexes for Goal task/recommendation/conflict reads, active generation idempotency, active task/recommendation/conflict dedupe, session task lookup, context package task lookup, and terminal feedback idempotency
Goal-scoped task create/list/update/split/generate use cases
Goal-scoped recommendation generate/list/detail use cases
recommendation accept/reject/dismiss/modify use cases
conflict list/resolve/dismiss use cases
manual regenerate/re-evaluate through POST /v1/goals/:goalId/tasks/generate and POST /v1/goals/:goalId/recommendations/generate
generation lifecycle states: pending, running, succeeded, failed
task statuses: proposed, open, in_progress, blocked, done, cancelled, archived
recommendation statuses: proposed, accepted, rejected, dismissed, modified, superseded
conflict statuses: open, resolved, dismissed
failure codes: invalid_input, invalid_output, provider_error, daemon_restart, goal_archived, sparse_input, internal_error
boot reconciliation of stale pending/running task and recommendation generation rows to failed with daemon_restart
internal orca/recommendation-generation, orca/task-generation, and orca/conflict-detection skill descriptors for diagnostics only
one daemon-local RecommendationProvider interface
one deterministic production recommendation provider
fake recommendation provider support for tests
one deterministic task generator
one deterministic conflict detector set
bounded input builders that read only existing Goal/refinement/workspace/session/memory/decision/session-summary/context-package projections and M7 task/recommendation/conflict rows
static or unit test coverage proving M7 orchestration does not import/read raw M4 output tails or transcript modules
deterministic task generation from Goal refinement and bounded M5/M6 evidence
deterministic recommendation rules for create_session, continue_session, review_output, refine_goal, split_task, run_validation, resolve_conflict, update_plan, ask_user, mark_complete, and pause_work
deterministic validation and review recommendation rules after implementation-like activity
conservative conflict detectors for active workspace overlap, contradictory confirmed decisions, reviewer rejection, blockers, and unresolved task-blocking questions
source attribution stored as compact JSON ids on task/recommendation/conflict rows
zod validation of generator/provider input/output and HTTP request/response shapes
normalization, content caps, best-effort secret redaction where persisted text is accepted, request fingerprinting, duplicate prevention, and supersede behavior before persistence
hard cap defaults: 256 char recommendation title, 4 KiB recommendation rationale, 4 KiB proposedAction JSON, 32 source refs per recommendation, 256 char task title, 8 KiB task description, 20 acceptance criteria, 20 validation steps, 1 KiB conflict description, 4 KiB conflict resolution note, 2 KiB feedback note, 256 char failure message, 4 KiB serialized event payload
idempotency by Goal, trigger kind, trigger source id, provider/generator version, input fingerprint, active row state, and proposed action/task/conflict fingerprint as applicable
Goal detail task panel
Goal detail recommendations panel
Goal detail conflicts banner/drawer
desktop accept/reject/dismiss/modify controls
desktop prefill into existing M3 refinement, M4 session creation, M6 context preparation, and M7 task flows without automatic downstream submission
desktop reconnect/refetch behavior using existing event subscription
documentation of endpoints, event payload rules, caps, generation policy, suggestion-only policy, restart policy, retry/idempotency policy, and non-goals

Milestone 7 excluded surface:

Level 4 supervised execution
Level 5 autonomy
approval gates
automatic session launch
automatic context preparation
automatic validation command execution
automatic task status transitions from session activity without user action
automatic retry/backoff
automatic recommendation execution
AI-backed recommendation provider implementations
model provider SDKs
provider/model configuration UI
prompt template libraries
prompt experiments
token-accurate accounting
provider cost tracking
generic skill invocation endpoints
generic reasoning-job endpoints
generic action execution endpoints
generic workflow endpoints
POST /v1/recommendations/:id/execute
POST /v1/recommendations/:id/regenerate
GET /v1/recommendations as a cross-Goal list
POST /v1/skills/:id/invoke
POST /v1/tasks/:id/archive as a separate endpoint
manual conflict creation endpoint
recommendation history/diff/editor pages
task board/Gantt/dependency graph UI
global task or recommendation dashboards
command-center panels
recommendation analytics
multi-step workflow planning
workflow engines
distributed queues
background workers
schedulers
continuous reasoning loops
cloud infrastructure
multi-agent scheduling
agent task assignment endpoints
cross-Goal memory
cross-Goal recommendations
workspace indexing/scanning/file watching
knowledge graphs
embeddings
vector search
semantic search
global search
memory consolidation
semantic ranking
relevance engines
aging/decay systems
analytics dashboards
policy/governance systems
audit engines
full transcript capture/replay/export/analytics
raw M4 output-tail reads during M7 orchestration
source reverse-index join tables
WebSocket commands for task/recommendation/conflict mutation
rendered context payload events
raw provider prompt/template events
feedback comment events
continuous reasoning events
external PM integrations
new top-level packages

Implementation instructions:

Analyze the current repository structure first.
Read the specific M7 task before editing.
Check task dependencies and do not skip prerequisite validation.
Honor the mandatory review gates before continuing past gated tasks.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where wire contracts, provider/generator output, or request/response parsing require it.
Avoid unnecessary abstractions.
Prefer deterministic/simple logic.
Preserve existing M1/M2/M3/M4/M5/M6 behavior unless the M7 task explicitly changes it.
Keep public API changes limited to the task's declared endpoints/contracts.
Keep generation daemon-local in M7.
Keep deterministic providers conservative; unsupported synthesis is not allowed.
Keep the DaemonContext seam explicit; add dependencies to context instead of using module globals.
Do not add AI provider SDKs, prompt management, model calls, provider config, or model selection.
Do not add git libraries such as simple-git, isomorphic-git, nodegit, or dugite.
Do not add file watchers such as chokidar or fs.watch.
Do not invent unverified CLI flags for Claude Code, opencode, codex, or any other adapter.
Do not log recommendation rationale, task description, acceptance criteria, validation steps, conflict description, conflict resolution note, feedback notes, proposedAction bodies, rendered context, raw source text, memory content, decision text, summary text, prompts, raw responses, tokens, secrets, workspace file contents, or adapter context-file paths.
Use content-free event payloads and REST projection reads for detailed state.
Ensure the assigned task validation steps pass.

M7 event set:

task.generation.requested
task.generated
task.generation.failed
task.created
task.updated
task.split
task.status_changed
task.associated_with_session
task.associated_with_context_package
recommendation.generation.requested
recommendation.generated
recommendation.generation.failed
recommendation.accepted
recommendation.rejected
recommendation.dismissed
recommendation.modified
recommendation.superseded
conflict.detected
conflict.resolved
conflict.dismissed
user.feedback.recorded

No other M7 orchestration events are allowed unless the assigned task explicitly amends the milestone plan.

M7 table/column set:

tasks
task_generations
recommendations
recommendation_generations
recommendation_feedback
conflicts
sessions.task_id
sessions.from_recommendation_id
context_packages.task_id
context_packages.from_recommendation_id

No other M7 persistence tables or columns are allowed unless the assigned task explicitly amends the milestone plan.

Generation lifecycle rules:

pending -> running -> succeeded is the normal path.
pending -> running -> failed is the failure path.
Failed rows are terminal.
Retry is explicit through POST /v1/goals/:goalId/tasks/generate or POST /v1/goals/:goalId/recommendations/generate.
Retry after failure creates a new generation row for the current request fingerprint.
If an active pending/running/succeeded generation already exists for the current request fingerprint, generate/retry returns that row and does not duplicate work.
Boot reconciliation marks stale pending/running task and recommendation generations failed with daemon_restart before HTTP/WS listen.
The runner is in-process and bounded. Do not add queues, schedulers, workers, or automatic backoff.

Idempotency rules:

Generation request fingerprint = sha256(goalId + ':' + triggerKind + ':' + (triggerSourceId ?? '') + ':' + providerOrGeneratorId + ':' + providerOrGeneratorVersion + ':' + inputFingerprint).

Task fingerprint = sha256(goalId + ':' + canonicalTitle + ':' + role) for generator-origin tasks. Manual tasks bypass the active-fingerprint unique index.

Recommendation fingerprint = sha256(goalId + ':' + type + ':' + canonicalProposedActionJson).

Conflict fingerprint = sha256(goalId + ':' + conflictType + ':' + sortedSourceIds).

Failed generation rows are terminal and excluded from active idempotency so retry can create a new row.

Input fingerprint rule:

Input fingerprints must be deterministic over the bounded projection snapshot:
goal id
refinement id/version
sorted workspace ids/dirty flags
sorted task ids/statuses/updated_at
sorted memory item ids/updated_at
sorted decision ids/status/updated_at
sorted recent session summary ids/updated_at
latest context package id
sorted active recommendation ids/status
sorted active conflict ids/status
trigger discriminator

Input rules:

Read only existing projections:
Goal row
latest Goal refinement fields
attached workspace metadata
session row/lifecycle/status fields
M5 Goal memory
M5 Goal decisions
M5 sibling session summaries
M6 context package id and small metadata
M7 task rows
M7 recommendation rows
M7 conflict rows
M7 feedback rows

Do not scan workspace files.
Do not call git.
Do not require or create full transcripts.
Do not read M4 output tails.
Do not import M4 output-tail or transcript modules under apps/daemon/src/orchestrator, apps/daemon/src/recommendations, apps/daemon/src/tasks, or apps/daemon/src/conflicts.
Apply best-effort redaction before persistence for text accepted at API boundaries.
Validate provider/generator input/output with zod.
Normalize and cap text before persistence.

HTTP/API rules:

POST /v1/goals/:goalId/tasks/generate triggers in-process task generation with request { "trigger": "manual" }.
GET /v1/goals/:goalId/tasks lists Goal-scoped tasks and latest task generation rows.
POST /v1/goals/:goalId/tasks creates a user task.
PATCH /v1/tasks/:id updates allowed task fields and status.
POST /v1/tasks/:id/split creates child tasks.
POST /v1/tasks/:id/associate-session associates an existing session.
POST /v1/goals/:goalId/recommendations/generate triggers in-process recommendation generation with request { "trigger": "manual" }.
GET /v1/goals/:goalId/recommendations lists Goal-scoped recommendations and latest recommendation generation rows.
GET /v1/recommendations/:id returns one recommendation detail.
POST /v1/recommendations/:id/accept records accept feedback and returns the proposedAction for prefill only.
POST /v1/recommendations/:id/reject records reject feedback.
POST /v1/recommendations/:id/dismiss records dismiss feedback.
PATCH /v1/recommendations/:id modifies a non-terminal recommendation and records modify feedback.
GET /v1/goals/:goalId/conflicts lists Goal-scoped conflicts.
POST /v1/conflicts/:id/resolve resolves or dismisses a conflict.
POST /v1/sessions accepts optional taskId and fromRecommendationId only.
POST /v1/goals/:goalId/context-packages accepts optional taskId and fromRecommendationId only.
No WebSocket commands are added in M7.
Desktop reacts to M7 events by refetching REST projections, not by patching detailed state from event payloads.

Recommendation acceptance rules:

Accepting a recommendation updates recommendation state and feedback only.
Accepting a recommendation does not automatically call M3, M4, M5, M6, or M7 downstream endpoints.
Desktop may open an existing downstream flow with prefilled fields.
The user must still submit the existing downstream flow.
There is no generic execute-action endpoint.
Per-kind prefill mapping belongs in the desktop client and must stay explicit.

Conflict rules:

Conflict detection is deterministic and conservative.
Allowed detector families are active workspace overlap, contradictory confirmed decisions, reviewer rejection, blocker reported, and unresolved question.
Each detected conflict emits conflict.detected and creates a linked resolve_conflict recommendation in one transaction.
Resolving or dismissing a conflict auto-dismisses the linked resolve_conflict recommendation in the same transaction.
There is no manual conflict creation endpoint.

Review gates:

Gate 1: After M7-002, verify contracts, SQLite migration surface, session/context columns, indexes, and upgrade path from an M6 database.
Gate 2: After M7-006, verify projection helpers, generation lifecycle, request fingerprinting, active idempotency, transaction boundaries, and content-free events.
Gate 3: After M7-010, verify bounded inputs, no raw output-tail/transcript access, deterministic rules, source refs, caps, superseding, false-positive conflict handling, and run full-suite pnpm -r typecheck and pnpm -r test.
Gate 4: After M7-012, verify orchestrator trigger mapping, single-flight behavior, dirty-flag re-evaluation, boot reconciliation, restart behavior, and broadcast-after-commit.
Gate 5: After M7-017, verify daemon API, events, persistence, idempotency, restart, privacy, session-create, context-create, and M1-M6 regression behavior for association extensions.
Gate 6: After M7-023, run desktop manual smoke with one refined Goal, one attached workspace, M5 memory/decisions/session summaries, an M6 context package, task generation, recommendation generation, accept/reject/dismiss/modify, context/session prefill, conflict detection/resolution, reload, and daemon restart.
Gate 7: After M7-024, verify final proof loop, final docs, M7 Definition of Done, non-goals, and run full-suite pnpm -r typecheck and pnpm -r test.

Full-suite gates:

After M7-010: pnpm -r typecheck and pnpm -r test must be green.
After M7-024: pnpm -r typecheck and pnpm -r test must be green.

Baseline validation for M7-000:

Run pnpm install --frozen-lockfile.
Run pnpm -r typecheck.
Run pnpm -r test.
Record git rev-parse HEAD.
Record final test summary line counts.
Record pre-existing dirty paths from git status without attributing them to M7.
Confirm named M1-M6 regression anchors pass:
M1 Goal CRUD plus live events.
M2 plugin/skill registry.
M3 Goal-with-workspaces integration.
M4 session lifecycle integration.
M5 daemon proof-loop integration.
M6 daemon proof-loop integration.

Before finishing:

verify all acceptance criteria
verify validation steps
verify task dependencies and review gates
verify M1/M2/M3/M4/M5/M6 baseline behavior still works where relevant
verify no excluded M7 surface was introduced
verify events are content-free and <= 4 KiB serialized
verify projection rows and events commit atomically
verify broadcasts happen only after commit
verify retry/idempotency behavior does not duplicate active generations
verify stale pending/running generations reconcile on boot where applicable
verify M7 orchestration does not read raw M4 output tails or transcript modules
verify recommendation acceptance never auto-launches or auto-executes downstream work
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:

Commit changes
Run `/simplify`, then commit again if any changes made
Output changes from a product perspective

Do not implement unrelated future milestone functionality.
