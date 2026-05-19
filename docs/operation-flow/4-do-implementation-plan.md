You are implementing a bounded Milestone 5 task for the Orca orchestration platform from the generated implementation task list in `docs/implementation-plans/milestone-5.md`.

Follow the assigned implementation task exactly.

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
preserving future extensibility

Current task:

M5-006

Prerequisite:

M5-000 baseline verification must already be complete and green before any implementation task after M5-000 begins. If the baseline is not recorded, stop and run M5-000 first.

Important architectural constraints:

local-first
event-driven
Goal-scoped
daemon owns state
SQLite remains the internal storage boundary
existing M1/M2/M3/M4 wire shapes remain valid unless the assigned M5 task explicitly extends them
M1 Goal creation and live event behavior must remain valid
M2 plugin and skill registry behavior must remain valid
M3 refined Goal and workspace behavior must remain valid
M4 PTY sessions, adapters, lifecycle events, capped output tails, restart reconciliation, and embedded terminal behavior must remain valid
daemon write paths that emit events must persist events and projection rows atomically
event bus broadcasts happen only after COMMIT succeeds
M5 events are control-plane signals with ids/counts/status only
M5 events must not include memory content, decision text, summaries, raw terminal output, prompts, raw extractor responses, or model reasoning
M5 consumes the M4 capped output tail but does not change M4 terminal streaming or output retention behavior
terminal output remains outside the general event store
terminal input and resize remain outside domain events
no full transcript capture or extraction
no context assembly
no prompt injection
no sibling-session startup awareness
no task generation
no recommendation engine
no workflow engine
no conflict detection
no cross-Goal memory
no workspace indexing
no workspace file watching
no embedding or vector search
no knowledge graph
no AI provider SDKs
no provider/model configuration UI
no prompt-management framework
no generic skill invocation endpoint
no generic extractor invocation endpoint
no background queues, workers, schedulers, or worker pools
no provider configuration tables
no context package tables
no recommendation, task, workflow, embedding, vector, or cross-Goal memory tables
no global memory dashboard
no command center
no new top-level package
no cloud sync

Milestone 5 proof point:

User opens a Goal with completed or stopped sessions
daemon detects eligible sessions without scanning the workspace
daemon reads Goal/refinement/session metadata and capped M4 output tail
daemon runs one daemon-local extraction job
extractor returns summary, memory candidates, and decision candidates
daemon validates output with zod and normalizes/redacts candidate text
daemon commits summary, memory, decisions, extraction state, and events in one SQLite transaction
daemon broadcasts committed events only after commit
Goal detail UI refetches memory, decisions, sessions, and summaries
user can review, edit, promote/archive memory, and confirm/archive decisions
all committed rows survive daemon restart

Milestone 5 included surface:

contract schemas for memory items, decisions, session summaries, extraction rows, extractor input/output, and M5 event literals
goal_memory_items table
goal_decisions table
session_summaries table
memory_extractions table
minimal indexes for Goal reads, duplicate prevention, active extraction idempotency, source lookup, and runner pickup
Goal-scoped memory list/create/patch use cases
Goal-scoped decision list/create/patch use cases
memory statuses: candidate, promoted, archived
decision statuses: proposed, confirmed, archived
automatic promotion only for deterministic low-risk memory
manual memory creation, edit, promote, archive
manual decision creation, edit, confirm, archive
compact source attribution to refinement, session/output byte window, or manual source
one daemon-local extractor interface
one deterministic extractor implementation
fake extractor support for tests
bounded extractor input assembled from Goal/refinement/session metadata and capped M4 output tail
ANSI/control stripping before extraction
input byte caps, output text caps, candidate count caps, and truncation flags
zod validation of extractor output
normalization, content hashing, duplicate prevention, and best-effort secret redaction before persistence
in-process serial extraction runner
extraction lifecycle states: pending, running, succeeded, failed
boot reconciliation of stale pending/running extractions to failed with daemon_restart
terminal-session hook that enqueues after M4 terminal state commits
Goal-open detection that enqueues eligible terminal sessions for that Goal only
M3 refinement seed memory for constraints and success criteria
GET /v1/goals/:goalId/memory
POST /v1/goals/:goalId/memory
PATCH /v1/memory/:id
GET /v1/goals/:goalId/decisions
POST /v1/goals/:goalId/decisions
PATCH /v1/decisions/:id
GET /v1/sessions/:sessionId/summary
POST /v1/sessions/:sessionId/extract-memory
latest extraction status and summary fields on existing Goal/session reads where useful
Goal detail memory panel
Goal detail decisions panel
session extraction badge, manual extract/retry button, and summary display in the existing sessions area
desktop reconnect/refetch behavior using existing event subscription
documentation of endpoints, event payload rules, caps, extraction policy, restart policy, and non-goals

Milestone 5 excluded surface:

POST /v1/memory/:id/promote
POST /v1/memory/:id/canonicalize
POST /v1/memory/:id/archive
POST /v1/decisions/:id/confirm
POST /v1/decisions/:id/archive
GET /v1/sessions/:sessionId/extractions
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
raw terminal output events
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

Implementation instructions:

Analyze the current repository structure first.
Read the specific M5 task before editing.
Check task dependencies and do not skip prerequisite validation.
Honor the mandatory review gates before continuing past gated tasks.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where wire contracts, extractor output, or request/response parsing require it.
Avoid unnecessary abstractions.
Prefer deterministic/simple logic.
Preserve existing M1/M2/M3/M4 behavior unless the M5 task explicitly changes it.
Keep public API changes limited to the task's declared endpoints/contracts.
Keep extraction daemon-local in M5.
Keep the deterministic extractor conservative; false negatives are acceptable, unsupported synthesis is not.
Keep the DaemonContext seam explicit; add dependencies to context instead of using module globals.
Do not add AI provider SDKs, prompt management, model calls, provider config, or model selection.
Do not add git libraries such as simple-git, isomorphic-git, nodegit, or dugite.
Do not add file watchers such as chokidar or fs.watch.
Do not log terminal output, extracted candidate content, summaries, decision text, prompts, raw responses, tokens, or secrets.
Use content-free event payloads and REST projection reads for detailed state.
Ensure the assigned task validation steps pass.

M5 event set:

memory.extraction.requested
memory.extraction.started
memory.extraction.completed
memory.extraction.failed
memory.item.created
memory.item.updated
memory.item.promoted
memory.item.archived
decision.created
decision.updated
decision.confirmed
decision.archived

M5 table set:

goal_memory_items
goal_decisions
session_summaries
memory_extractions

No other M5 persistence tables are allowed unless the assigned task explicitly amends the milestone plan.

Extraction rules:

Read only existing evidence: Goal row, latest Goal refinement fields, attached workspace metadata, session metadata, and capped M4 output tail.
Do not scan workspace files.
Do not require or create full transcripts.
Read at most the configured M5 input byte cap from the M4 tail.
Prefer the most recent bytes when the tail exceeds the cap.
Decode as UTF-8 with replacement.
Strip ANSI/control sequences before extraction.
Record source output byte windows.
Mark truncated when M4 or M5 caps were hit.
Validate extractor output with zod before persistence.
Normalize and cap text fields before persistence.
Apply best-effort redaction for obvious secret assignments such as password=, token=, api_key=, and authorization: bearer.
Compute content_hash after normalization/redaction.
Deduplicate live memory rows by goal_id, type, and content_hash.
Do not persist raw output, prompts, or raw extractor responses.

Automatic promotion rules:

Auto-promote only refinement-sourced constraints and success criteria.
Auto-promote only high-confidence session blockers derived from exit/failure metadata.
Auto-promote only high-confidence validation results derived from clean terminal session completion.
Do not auto-confirm decisions.
Extracted decisions remain proposed, and high-impact or uncertain decisions must set confirmation_required=true.

Extraction lifecycle rules:

pending -> running -> succeeded is the normal path.
pending -> running -> failed is the failure path.
Failed rows are terminal.
Retry is explicit through POST /v1/sessions/:sessionId/extract-memory.
A retry after failure creates a new extraction row for the current source fingerprint.
If an active pending/running/succeeded row already exists for the current source fingerprint, enqueue/manual extract returns that row and does not duplicate work.
Boot reconciliation marks stale pending/running rows failed with daemon_restart before HTTP/WS listen.

Review gates:

Gate 1: After M5-002, verify contracts and SQLite migration surface before daemon memory/decision implementation.
Gate 2: After M5-006, verify projection helpers, manual APIs, extraction state, fake extractor commit, atomic transaction boundaries, and content-free events.
Gate 3: After M5-010, verify bounded input, deterministic extraction, refinement seed memory, runner behavior, terminal hook, Goal-open detection, and restart reconciliation.
Gate 4: After M5-012, run `pnpm -r typecheck` and `pnpm -r test`; review daemon API, event, persistence, idempotency, restart, privacy, and M1-M4 regression behavior.
Gate 5: After M5-016, run desktop manual smoke with one refined Goal, one attached workspace, one completed/stopped session, extraction retry, memory promote/archive, decision confirm/archive, reload, and daemon restart.
Gate 6: After M5-017, verify Definition of Done, final docs, and non-goals.

Before finishing:

verify all acceptance criteria
verify validation steps
verify task dependencies and review gates
verify M1/M2/M3/M4 baseline behavior still works where relevant
verify no excluded M5 surface was introduced
verify events are content-free
verify raw output, prompts, raw responses, and candidate content are not logged
verify projection rows and events commit atomically
verify broadcasts happen only after commit
verify retry/idempotency behavior does not duplicate live memory
verify stale pending/running extractions reconcile on boot
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:

Commit changes
Run `/simplify`, then commit again if any changes made
Output changes from a product perspective

Do not implement unrelated future milestone functionality.
