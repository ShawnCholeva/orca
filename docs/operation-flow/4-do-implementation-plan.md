You are implementing a bounded Milestone 6 task for the Orca orchestration platform from the generated implementation task list in `docs/implementation-plans/milestone-6.md`.

Follow the assigned implementation task exactly.

Do not use the superpowers plugin

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
privacy-preserving context handling
preserving future extensibility

Current task:

M6-004

Prerequisite:

Milestone 5 must be complete and green before any M6 task begins. M6-000 baseline verification must already be complete and recorded before any implementation task after M6-000 begins. If the baseline is not recorded, stop and run M6-000 first.

Important architectural constraints:

local-first
event-driven
Goal-scoped
Workspace-aware
daemon owns state
SQLite remains the internal storage boundary
existing M1/M2/M3/M4/M5 wire shapes remain valid unless the assigned M6 task explicitly extends them
M1 Goal creation and live event behavior must remain valid
M2 plugin and skill registry behavior must remain valid
M3 refined Goal and workspace behavior must remain valid
M4 PTY sessions, adapters, lifecycle events, capped output tails, restart reconciliation, and embedded terminal behavior must remain valid
M5 Goal-scoped memory, decisions, session summaries, extraction events, and Goal detail memory/decision UI must remain valid
daemon write paths that emit events must persist events and projection rows atomically
event bus broadcasts happen only after COMMIT succeeds
M6 events are control-plane signals with ids/counts/status/byte sizes/failure codes only
M6 events must not include rendered context, raw source text, memory content, decision text, summary text, raw terminal output, prompts, raw assembler input/output, raw model responses, or model reasoning
M6 context assembly must not read M4 raw output tails or transcripts
terminal output remains outside the general event store
terminal input and resize remain outside domain events
rendered context must not appear in process args, environment variables, logs, WebSocket events, or domain event payloads
context packages are Goal-scoped and immutable in M6
session creation remains user-driven
context preparation and session launch remain a two-step flow
no inline assembleContext inside POST /v1/sessions
no full transcript capture or extraction
no context package archive/update/delete endpoints
no package history, diff, or editable-context UI
no generic skill invocation endpoint
no public context-builder invocation endpoint
no prompt injection endpoint
no prompt-management framework
no generic adapter prompt routing
no recommendations
no task or work-unit generation
no validation recommendations
no conflict detection
no workflow engine
no supervised execution
no autonomous launch
no automatic session launch
no automatic retry/backoff
no continuous reasoning
no sibling-session startup awareness beyond bounded M5 session summaries
no cross-Goal memory
no workspace indexing
no workspace scanning
no workspace file watching
no embedding or vector search
no semantic search
no knowledge graph
no AI provider SDKs
no provider/model configuration UI
no prompt template libraries
no prompt experiments
no token-accurate accounting
no provider cost tracking
no background queues, workers, schedulers, or worker pools
no provider configuration tables
no source reverse-index table such as context_package_sources
no recommendation, task, workflow, embedding, vector, semantic-search, provider, prompt, or cross-Goal memory tables
no global context dashboard
no command center
no new top-level package
no cloud sync

Milestone 6 proof point:

User opens a Goal and starts the new-session flow
daemon lets the user choose adapter, workspace, role, and short session objective
daemon reads bounded Goal/refinement/workspace/memory/decision/session-summary projections
daemon runs one internal session-preparation job boundary
deterministic assembler produces compact role-aware sections
daemon validates, redacts, caps, and persists package plus assembly events atomically
daemon broadcasts committed events only after commit
desktop shows context preview, source counts, status, warnings, and retry/regenerate
user starts a normal M4 PTY session with contextPackageId
adapter receives context through an explicit adapter-safe path or declares preview-only
session row stores contextPackageId
package, assembly metadata, and session association survive daemon restart

Milestone 6 included surface:

contract schemas for context packages, context assemblies, context source refs, roles, statuses, failure codes, create/list/detail responses, and M6 event literals
CreateSessionRequest extension with optional contextPackageId
session read response extension with optional contextPackageId
session.created event extension with optional contextPackageId
context_packages table
context_assemblies table
sessions.context_package_id column
minimal indexes for Goal package reads, Goal assembly reads, active request idempotency, assembly reconciliation, and session package lookup
compact source attribution stored as JSON on context_packages
Goal-scoped context package create/list/detail use cases
manual retry/regenerate through POST /v1/goals/:goalId/context-packages with optional replacePackageId
immutable package rows with status='ready' only in M6
assembly lifecycle states: pending, running, succeeded, failed
failure codes: invalid_input, invalid_output, output_too_large, goal_archived, source_missing, delivery_unavailable, internal_error, daemon_restart
boot reconciliation of stale pending/running context assemblies to failed with daemon_restart
one internal orca/session-preparation skill descriptor for diagnostics only
one daemon-local assembler interface
one deterministic production assembler
fake assembler support for tests
bounded input builder that reads only Goal row, latest refinement fields, attached workspace metadata already known from M3, M5 memory rows, M5 decision rows, and M5 sibling session summaries
static or unit test coverage proving M6 context assembly does not import/read raw M4 output tails or transcript modules
deterministic memory, decision, and sibling-summary selection rules
role-aware context for architect, engineer, reviewer, and generalist
sectioned plaintext renderer
adapter framing/helper logic where needed
zod validation of assembler input/output and HTTP request/response shapes
normalization, content caps, best-effort secret redaction, byte-budget enforcement, and advisory token estimate before persistence and adapter delivery
hard cap defaults: 32 KiB rendered context, 4 KiB objective, 8 KiB per section, 30 memory items, 20 decisions, 5 sibling summaries, 256 chars failure message
confirmation-required decisions pinned and labeled
output_too_large failure when required decision material cannot fit
idempotency by Goal, adapter, role, objective hash, workspace, source fingerprint, assembler version, and optional replacement package
POST /v1/goals/:goalId/context-packages
GET /v1/goals/:goalId/context-packages
GET /v1/context-packages/:id
POST /v1/sessions extension with optional contextPackageId
adapter delivery metadata with mode initial_input, context_file, or preview_only
shell/manual initial_input only where context remains visible and user-driven
context_file only for adapters with verified safe startup support
preview_only fallback for adapters without verified safe delivery
session-scoped context files with mode 0600 where used
Goal detail new-session controls for adapter/workspace/role/objective
prepare/skip buttons
context preview/status/source summary/budget usage/warnings
retry/regenerate action
session row context badge
desktop reconnect/refetch behavior using existing event subscription
documentation of endpoints, event payload rules, database retention/caps, assembly policy, adapter-delivery policy, restart policy, and non-goals

Milestone 6 excluded surface:

POST /v1/context-packages/:id/regenerate
GET /v1/sessions/:sessionId/context
inline assembleContext inside POST /v1/sessions
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
semantic search endpoints
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
context.assembly.started event
context.package.updated event
context.package.archived event
automatic context retry
AI-backed assembler implementations
model provider integration
background worker infrastructure
workspace indexing/scanning/file watching
context package source reverse-index tables
global context dashboards
package history/diff/editor UI
new top-level navigation/routing
new top-level packages

Implementation instructions:

Analyze the current repository structure first.
Read the specific M6 task before editing.
Check task dependencies and do not skip prerequisite validation.
Honor the mandatory review gates before continuing past gated tasks.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where wire contracts, assembler output, or request/response parsing require it.
Avoid unnecessary abstractions.
Prefer deterministic/simple logic.
Preserve existing M1/M2/M3/M4/M5 behavior unless the M6 task explicitly changes it.
Keep public API changes limited to the task's declared endpoints/contracts.
Keep assembly daemon-local in M6.
Keep the deterministic assembler conservative; unsupported synthesis is not allowed.
Keep the DaemonContext seam explicit; add dependencies to context instead of using module globals.
Do not add AI provider SDKs, prompt management, model calls, provider config, or model selection.
Do not add git libraries such as simple-git, isomorphic-git, nodegit, or dugite.
Do not add file watchers such as chokidar or fs.watch.
Do not invent unverified CLI flags for Claude Code, opencode, codex, or any other adapter.
Do not log rendered context, raw source text, memory content, decision text, summary text, prompts, raw responses, tokens, secrets, or adapter context-file paths.
Use content-free event payloads and REST projection reads for detailed state.
Ensure the assigned task validation steps pass.

M6 event set:

context.assembly.requested
context.assembly.completed
context.assembly.failed
context.package.created

No other M6 context events are allowed unless the assigned task explicitly amends the milestone plan.

M6 table/column set:

context_packages
context_assemblies
sessions.context_package_id

No other M6 persistence tables are allowed unless the assigned task explicitly amends the milestone plan.

Context package rules:

Packages are Goal-scoped.
Packages are immutable in M6.
Packages have status='ready' only.
Regeneration creates a new package with supersedesPackageId/supersedes_package_id.
Old packages are not mutated by regeneration.
Rendered context is persisted only in context_packages.rendered_context.
Source attribution is compact JSON on context_packages.
Do not create context_package_sources in M6.
Do not persist raw assembler input, raw assembler output, prompts, raw model responses, or source text copies.

Assembly lifecycle rules:

pending -> running -> succeeded is the normal path.
pending -> running -> failed is the failure path.
Failed rows are terminal.
Retry is explicit through POST /v1/goals/:goalId/context-packages.
Retry after failure creates a new assembly row for the current request fingerprint.
If an active pending/running/succeeded row already exists for the current request fingerprint, create/regenerate/retry returns that row and does not duplicate work.
Boot reconciliation marks stale pending/running assemblies failed with daemon_restart before HTTP/WS listen.

Idempotency rule:

request_fingerprint = sha256(goal_id + ':' + adapter_id + ':' + role + ':' + objective_hash + ':' + (workspace_id ?? '') + ':' + source_fingerprint + ':' + assembler_version + ':' + (replace_package_id ?? ''))

The partial unique index on (goal_id, request_fingerprint) WHERE status IN ('pending','running','succeeded') prevents duplicate active assemblies. Failed rows are terminal and excluded from active idempotency so retry can create a new row.

Source fingerprint rule:

source_fingerprint = sha256(sorted compact source-id list with M5 row updated_at/content hashes + workspace metadata version + refinement id/version + role + adapter + objective_hash + assembler version)

Fingerprints must be deterministic across the same projection snapshot.

Context input rules:

Read only existing projections: Goal row, latest Goal refinement fields, attached workspace metadata, M5 Goal memory, M5 Goal decisions, and M5 sibling session summaries.
Do not scan workspace files.
Do not call git.
Do not require or create full transcripts.
Do not read M4 output tails.
Do not import M4 output-tail or transcript modules under apps/daemon/src/context.
Apply best-effort redaction before assembly.
Validate assembler input/output with zod.
Normalize and cap text before persistence and delivery.
Compute renderedBytes with UTF-8 byte length.
Compute estimatedTokens with Math.ceil(renderedBytes / 4).

Selection and rendering rules:

Use deterministic pure selection functions.
Memory cap is 30 items.
Decision cap is 20 decisions.
Sibling summary cap is 5 summaries.
Confirmation-required proposed decisions are pinned and labeled.
Confirmation-required decisions must not be dropped for budget.
If required decision material cannot fit, fail with output_too_large.
Role order differs for architect, engineer, reviewer, and generalist exactly as the task specifies.
Rendered context is sectioned plaintext.
Inline markers must map one-to-one with compact ContextSourceRef entries.
Set sparse=true when the package has no memory, no decisions, and no sibling summaries.
Set truncated=true when low-priority material is dropped to fit caps.

Adapter delivery rules:

mode='initial_input' writes rendered context to PTY stdin only for adapters where visible user-driven startup is intentional, such as shell/manual.
mode='context_file' writes rendered context to a session-scoped context file with mode 0600 and passes only the file path through a verified safe startup surface.
mode='preview_only' does not deliver rendered context to the adapter; the package remains visible in the UI and linked to the session.
If a safe context_file surface for an adapter is uncertain, use preview_only.
Never pass rendered context bytes in argv or env.
Never log rendered context or context-file paths.
Clean up session-scoped context files on terminal-state and best-effort on boot.

HTTP/API rules:

POST /v1/goals/:goalId/context-packages creates, retries, or regenerates context through optional replacePackageId.
GET /v1/goals/:goalId/context-packages lists recent packages and assemblies for a Goal.
GET /v1/context-packages/:id returns one package with rendered context and compact source refs.
POST /v1/sessions accepts optional contextPackageId only.
POST /v1/sessions must validate contextPackageId belongs to the same Goal, is ready, matches adapterId, and matches workspaceId when the package has one.
POST /v1/sessions must preserve the no-context M4 behavior when contextPackageId is absent.
No WebSocket commands are added in M6.
Desktop reacts to context events by refetching REST projections, not by patching detailed state from event payloads.

Review gates:

Gate 1: After M6-002, verify contracts and SQLite migration surface before daemon context use-case implementation.
Gate 2: After M6-005, verify projection helpers, atomic transaction boundaries, content-free events, idempotency, fake assembler lifecycle, and boot reconciliation.
Gate 3: After M6-008, verify bounded input, tail isolation, deterministic selection, renderer caps/redaction, sparse/truncated behavior, and marker/source-ref alignment.
Gate 4: After M6-010, run full-suite pnpm -r typecheck and pnpm -r test; verify route status codes, session link behavior, privacy invariants, and no M1-M5 regression.
Gate 5: After M6-011, verify adapter delivery safety: no rendered context bytes in argv/env/logs, mode 0600 files where supported, preview_only fallback, cleanup, and no invented CLI flags.
Gate 6: After M6-015, verify desktop prepare/preview/retry/regenerate/session badge/reconnect behavior with a human UX smoke.
Gate 7: After M6-016, verify final proof loop, final docs, M6 Definition of Done, and no non-goal scope.

Full-suite gates:

After M6-010: pnpm -r typecheck and pnpm -r test must be green.
After M6-016: pnpm -r typecheck and pnpm -r test must be green.

Baseline validation for M6-000:

Run pnpm install --frozen-lockfile.
Run pnpm -r typecheck.
Run pnpm -r test.
Record git rev-parse HEAD.
Record final test summary line counts.
Record pre-existing dirty paths from git status without attributing them to M6.
Confirm named M1-M5 regression anchors pass:
M1 Goal CRUD plus live events.
M2 plugin/skill registry.
M3 Goal-with-workspaces integration.
M4 session lifecycle integration.
M5 daemon proof-loop integration.

Before finishing:

verify all acceptance criteria
verify validation steps
verify task dependencies and review gates
verify M1/M2/M3/M4/M5 baseline behavior still works where relevant
verify no excluded M6 surface was introduced
verify events are content-free
verify rendered context, raw source text, prompts, raw assembler input/output, raw model responses, and source content are not logged
verify rendered context is not present in argv, env, logs, WebSocket events, or domain event payloads
verify projection rows and events commit atomically
verify broadcasts happen only after commit
verify retry/idempotency behavior does not duplicate active assemblies
verify stale pending/running assemblies reconcile on boot
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:

Commit changes
Run `/simplify`, then commit again if any changes made
Output changes from a product perspective

Do not implement unrelated future milestone functionality.
