You are acting as the lead principal engineer for this platform.

I have attached the following documents:

Product Brief
Technical Design Document
MVP Specification (Levels 1-3)
Level 4 Specification
Level 5 Specification
Milestone 1 implementation plan
Milestone 2 implementation plan
Milestone 3 implementation plan
Milestone 4 implementation plan and final validation notes
Milestone 5 architecture, implementation plan, and final validation notes
Milestone 6 architecture, implementation plan, and final validation notes

Your task is NOT to immediately generate code.

Your task is to produce:

an implementation architecture and milestone execution plan for Milestone 7 of the MVP.

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
memory/decision-aware from Milestone 5
context-package-aware from Milestone 6
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

## Milestone 7 - Suggested Orchestration

Build:

- task/work unit generation
- recommendation engine
- recommendations panel
- accept/reject/modify feedback
- validation recommendation
- conservative conflict detection

Exit criteria:

- the system recommends useful next actions after session activity

Milestone 7 builds on:

- Milestone 1: local Tauri app, Node daemon, SQLite, event store, Goal projection, Goal CRUD, live events
- Milestone 2: internal plugin registry, internal skill registry, default skill provider, Quick Goal skill, `skill.invoked` event, read-only plugin/skill diagnostics, adapter-capable plugin metadata
- Milestone 3: deterministic Goal refinement, Goal detail bundle, canonical workspace attachments, lazy workspace/git inspection, workspace attach/remove events and projections
- Milestone 4: daemon-managed PTY sessions, shell/manual + Claude Code + opencode + codex adapters, session lifecycle events, capped session output tail, embedded terminal UI, restart reconciliation
- Milestone 5: durable Goal-scoped memory, decisions, session summaries, extraction lifecycle state, bounded extraction from M4 session output tails, memory/decision views, explicit review/edit/promote/archive/confirm controls
- Milestone 6: durable bounded context packages, deterministic session preparation, role-aware context rendering, context preview/status UI, context package association with sessions, content-free context lifecycle events, restart-safe context persistence

The Milestone 7 plan should preserve the M1-M6 operational loop:

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

Milestone 7 should prove the next product loop:

```text
Meaningful Goal activity occurs:
  session completes, context package is used, memory/decision/summary changes, task changes, or user feedback is recorded
  -> daemon evaluates deterministic orchestration triggers
  -> daemon gathers bounded Goal, task, workspace, session, memory, decision, summary, and context-package inputs
  -> daemon runs explicit internal recommendation/task/conflict jobs only when needed
  -> daemon persists generated work units, recommendations, conflicts, and supervision feedback atomically with content-bounded lifecycle events
  -> desktop shows a Goal-scoped task/work panel and recommendations panel
  -> user accepts, rejects, dismisses, or modifies recommendations
  -> accepted recommendations can prefill existing M4/M6 flows, such as preparing context or starting a session, but do not auto-launch work
  -> validation recommendations appear after implementation-like activity
  -> conservative conflicts are surfaced for human resolution
  -> recommendation/task/conflict state survives daemon restart
  -> future Level 4 can consume accepted recommendations and tasks as explicit supervision signals
```

Keep Milestone 7 focused. It should not become the Level 4 workflow engine, autonomous launcher, continuous background planner, multi-agent scheduler, automatic approval system, workspace indexer, cross-Goal knowledge system, embedding/vector system, provider configuration layer, prompt-management platform, policy engine, enterprise audit system, or model-training system.

The implementation document should include:

1. Milestone Purpose

Explain why this milestone exists and what architectural foundation it establishes beyond M1-M6.

The explanation should clarify:

- why recommendations are the next foundation after shared memory and context assembly
- why M7 turns Goal state into suggested next actions without taking those actions automatically
- why work units are needed before Level 4 supervised execution can safely propose workflows
- why M5 memory/decisions/session summaries and M6 context packages are inputs, not raw material to dump into prompts
- why recommendation generation should use explicit job/provider boundaries instead of constant daemon reasoning loops
- why deterministic triggers and conservative rules are preferred for the MVP
- how M7 uses user accept/reject/modify feedback as supervision signals without pretending to learn yet
- how M7 prepares for Level 4 supervised execution without approving, launching, or sequencing workflows automatically
- which recommendation/task/conflict state must survive restart versus which generation jobs can be retried or marked failed

2. Scope Review And Simplification

Review the natural interpretation of Milestone 7 and identify what should be included versus deferred.

Explicitly decide how MVP-appropriate the following are for M7:

- task/work unit generation
- initial task generation from Goal refinement
- task creation from session summaries, memory, decisions, and context packages
- task status model and lifecycle
- task dependencies
- task splitting and manual edits
- associating tasks with sessions, workspaces, roles, context packages, memory, and decisions
- recommendation generation
- recommendation types: `create_session`, `continue_session`, `review_output`, `refine_goal`, `split_task`, `run_validation`, `resolve_conflict`, `update_plan`, `ask_user`, `mark_complete`, `pause_work`
- recommendations panel
- recommendation detail drawer or expandable details
- accept/reject/dismiss/modify feedback
- supervision signal persistence
- validation recommendation after implementation-like work
- conservative conflict detection
- conflict records and human resolution
- conflict synthesis versus simple conflict rules
- recommendation idempotency and superseding
- recommendation deduplication
- recommendation lifecycle state
- recommendation source attribution
- recommendation confidence
- proposed action schema
- integration with M4 session creation
- integration with M6 context package preparation
- accepted recommendation prefill behavior
- automatic session launch after recommendation acceptance
- automatic validation command execution
- automatic task assignment to agents
- multi-step workflow planning
- background queues / workers
- AI-backed recommendation provider
- deterministic recommendation provider
- provider/model SDK integration
- prompt template libraries
- user-editable task and recommendation text
- recommendation history and analytics
- recommendation ranking, scoring, aging, or decay
- cross-Goal recommendations
- workspace indexing / file watching
- full transcript processing
- embedding search / vector database
- semantic conflict detection
- advanced plan repair or autonomous replanning
- Level 4 approval gates
- Level 5 autonomous execution

Prefer the smallest product-complete M7 that satisfies the exit criteria.

3. High-Level Runtime Architecture

Show how these pieces interact during Milestone 7:

- Tauri app
- React Goal detail task/work panel and recommendations panel
- existing session creation flow
- existing M6 context preparation and context preview flow
- Node daemon
- existing HTTP/WebSocket API layer
- existing plugin and skill registries
- existing session adapter registry and M4 PTY/session use cases
- existing Goal and Goal refinement projections
- existing workspace attachment and lazy inspection data
- existing M5 memory, decision, session summary, and extraction projections
- existing M6 context package and assembly projections
- new task/work-unit domain and projections
- new recommendation domain and provider/job boundary
- new supervision feedback domain
- new conservative conflict detection domain
- SQLite storage
- event system
- future Level 4 consumers, as read-only future consumers only

Describe the key flows:

- generate initial work units for a Goal after refinement or explicit user request
- update task state after session activity and user edits
- generate recommendations after meaningful state changes without reacting to every event
- recommend next session or continuation using existing M4 session adapters and M6 context packages
- recommend validation after implementation-like activity
- recommend review after substantial output or decision changes
- recommend Goal refinement when open questions or sparse Goal detail block progress
- detect conservative conflicts from active sessions, task/workspace overlap, contradictory decisions, reviewer rejection, blockers, and unresolved questions
- persist tasks, recommendations, conflicts, and feedback atomically
- broadcast committed events and refresh desktop panels
- accept a recommendation and prefill the relevant flow
- reject/dismiss/modify a recommendation and record feedback
- handle recommendation provider failure
- handle missing or sparse memory/decisions/summaries/context packages
- handle oversized recommendation inputs and outputs
- handle daemon restart while generation jobs were pending or running
- handle archived Goals, Workspaces, Sessions, tasks, recommendations, memory, decisions, summaries, and context packages

4. Repository Structure

Design the M7 repository changes on top of the existing M1-M6 monorepo.

Cover likely additions under:

- `packages/contracts`
- `apps/daemon/src/tasks*` or equivalent
- `apps/daemon/src/recommendations*` or equivalent
- `apps/daemon/src/conflicts*` or equivalent
- `apps/daemon/src/supervision*` or equivalent
- `apps/daemon/src/orchestrator*` or equivalent trigger/rule layer
- `apps/daemon/src/sessions*`
- `apps/daemon/src/context*`
- `apps/daemon/src/skills*` or provider registry areas
- `apps/daemon/src/server.ts`
- `apps/desktop/src`
- daemon tests
- desktop tests or smoke coverage
- docs / implementation notes

Do not propose large package extraction unless there is a concrete M7 need.

5. Technology Decisions

Recommend M7-specific technology choices and explain why:

- whether the first recommendation provider should be deterministic, AI-backed, or an interface with deterministic default
- whether to introduce an AI provider SDK in M7 or keep model calls behind internal skill/provider boundaries for later
- how to generate tasks without semantic search or embeddings
- how to generate recommendations from bounded projections rather than raw transcripts
- how to use M6 context packages as compact recommendation inputs
- how to represent recommendation proposed actions without coupling them to direct execution
- how to represent source attribution without copying all source content
- how to store recommendation/task/conflict metadata and selected source ids
- how to model task, recommendation, feedback, and conflict lifecycle state
- how to ensure recommendation idempotency and deduplication
- how to supersede stale recommendations
- how to handle retries without a queue system
- how to keep event payloads content-bounded and privacy-safe
- how to validate provider input/output with zod
- how to keep byte and token-equivalent budgets explicit
- how to test recommendation behavior deterministically

Avoid adding heavy dependencies unless they materially reduce risk.

6. Runtime Lifecycle

Describe how M7 changes daemon and desktop lifecycle behavior.

Include:

- daemon boot migrations for tasks, recommendations, feedback, conflicts, and generation state
- boot reconciliation for generation jobs that were pending/running during daemon shutdown
- which committed events trigger orchestration evaluation
- why M7 should evaluate after meaningful state changes, not every output chunk or every WebSocket frame
- whether generation runs synchronously in API requests, through explicit endpoints, or through a simple in-process job runner
- whether users can manually request recommendation regeneration
- behavior when the desktop disconnects while generation is running
- behavior when the daemon receives shutdown while generation is running
- behavior on daemon restart with open tasks, recommendations, conflicts, and accepted feedback
- how the UI handles pending/running/failed/completed generation states
- how task/recommendation/conflict changes are broadcast live
- what happens if memory, decisions, summaries, context packages, or workspace metadata are missing
- what happens if the selected Goal, Workspace, Session, Task, Recommendation, or Conflict was archived

7. Event System Design

Design the M7 event additions.

Include concrete event names and payload guidance for:

- `task.generated`
- `task.created`
- `task.updated`
- `task.split`
- `task.status_changed`
- `task.associated_with_session`
- `recommendation.generation.requested`
- `recommendation.generated`
- `recommendation.accepted`
- `recommendation.rejected`
- `recommendation.dismissed`
- `recommendation.modified`
- `recommendation.superseded`
- `recommendation.generation.failed`
- `conflict.detected`
- `conflict.resolved`
- `user.feedback.recorded`

Define:

- event interfaces
- event persistence rules
- event ordering rules
- which events update which projections
- which events are broadcast live
- which recommendation/task/conflict internals should NOT become domain events
- payload size limits
- source references to Goals, refinements, tasks, recommendations, conflicts, memory items, decisions, session summaries, context packages, workspaces, and sessions
- how generation state remains idempotent and restart-safe

Keep the event design MVP-appropriate and append-only. Be explicit about why raw terminal output, full transcripts, full prompts, full source memory text, rendered context packages, raw recommendation inputs/outputs, and model responses do not belong in the general event store.

8. Database Design

Design the SQLite schema changes for M7.

Cover:

- `tasks` or equivalent work-unit table
- `recommendations` table
- recommendation generation lifecycle table, if needed
- `recommendation_feedback` or supervision signal table
- `conflicts` table
- task goal id, parent task id, workspace id, role, status, dependencies, acceptance criteria, validation steps, source refs, timestamps
- recommendation goal id, task id if relevant, session id if relevant, context package id if relevant, type, title, rationale, proposed action JSON, confidence, status, source refs, timestamps
- conflict goal id, conflict type, status, severity, source refs, resolution notes, timestamps
- rendered/stored text versus compact selected-source references
- indexes needed for Goal detail reads, task reads, recommendation reads, deduplication, runner pickup, and feedback lookup
- migration strategy from the M1-M6 schema
- retention, superseding, and archive strategy

Avoid premature tables for workflows, approval gates, autonomous runs, policy enforcement, prompt libraries, prompt experiments, embeddings, vector indexes, cross-Goal memory, provider configuration, or workspace scans.

9. API Contract Design

Define the M7 API surface with concrete endpoint examples.

At minimum, evaluate:

- `POST /v1/goals/:goalId/tasks/generate`
- `GET /v1/goals/:goalId/tasks`
- `POST /v1/goals/:goalId/tasks`
- `PATCH /v1/tasks/:id`
- `POST /v1/tasks/:id/split`
- `POST /v1/tasks/:id/associate-session`
- `POST /v1/goals/:goalId/recommendations/generate`
- `GET /v1/goals/:goalId/recommendations`
- `GET /v1/recommendations/:id`
- `POST /v1/recommendations/:id/accept`
- `POST /v1/recommendations/:id/reject`
- `POST /v1/recommendations/:id/dismiss`
- `PATCH /v1/recommendations/:id`
- `GET /v1/goals/:goalId/conflicts`
- `POST /v1/conflicts/:id/resolve`
- `POST /v1/sessions` changes needed to optionally associate a task or accepted recommendation
- WebSocket/domain event behavior for tasks, recommendations, conflicts, and feedback

For each endpoint/message, specify:

- request shape
- response shape
- validation behavior
- authorization behavior inherited from M1
- emitted events
- whether it is idempotent
- whether it is required for M7 or should be deferred

Do not introduce workflow execution endpoints, approval-gate endpoints, autonomous launch endpoints, cross-Goal recommendation endpoints, embedding search endpoints, generic skill invocation endpoints, generic reasoning-job endpoints, provider/model configuration endpoints, or WebSocket commands unless the plan demonstrates a concrete M7 need.

10. Task / Work Unit Domain Design

Define how operational work units work in M7.

Cover:

- domain model fields
- lifecycle statuses
- parent/child and split behavior
- dependency behavior
- role and workspace assignment
- association with sessions and context packages
- relationship between tasks and M3 Goal refinements/workspaces
- relationship between tasks and M5 memory/decisions/session summaries
- relationship between tasks and M6 context packages
- task source attribution behavior
- acceptance criteria and validation step behavior
- task generation behavior
- task manual create/edit behavior
- blocked/resolved behavior
- archive/retention behavior
- behavior for archived Goals, Workspaces, Sessions, memory, decisions, summaries, and context packages
- security/privacy considerations

Keep the domain focused on Goal-scoped operational work units. Do not build workflow graphs, autonomous execution plans, multi-agent scheduling, cross-Goal tasking, or external project management sync.

11. Recommendation Provider / Job Design

Define the M7 recommendation behavior.

Cover:

- recommendation provider interface shape
- input data available to the provider
- output schema for recommendations
- deterministic default provider behavior, if chosen
- AI-backed provider behavior, if chosen
- recommendation types and proposed action schemas
- validation and normalization rules
- source selection rules
- source attribution rules
- duplicate and stale recommendation handling
- confidence behavior
- feedback handling
- confirmation-required decision handling
- validation recommendation rules
- review recommendation rules
- task update recommendation rules
- error handling and retry rules
- payload size and token-equivalent budget limits
- privacy rules for logs and persisted recommendation state
- how recommendation generation remains internal-first while preserving future plugin-first architecture

Keep recommendations focused on suggesting human-supervised next actions. Do not build Level 4 workflow execution, automatic approvals, continuous planning, or autonomous session launching.

12. Conflict Detection Design

Define conservative conflict detection for M7.

Cover:

- conflict domain model fields
- conflict lifecycle statuses
- conflict types
- two active sessions touching same workspace/task
- two decisions with contradictory wording
- reviewer rejection
- session output or summary indicating blocker
- unresolved question blocking task
- source attribution for conflicts
- false-positive handling
- human resolution behavior
- relationship between conflicts and recommendations
- conflict resolution recommendation behavior
- conflict event payload limits
- why semantic or AI-heavy conflict detection should be deferred unless deterministic and testable

Keep conflict detection conservative. Surface likely problems to humans; do not block sessions, rewrite tasks automatically, or resolve conflicts without user action.

13. Adapter, Session, and Context Integration

Define how M7 integrates with M4 sessions and M6 context packages.

Cover:

- how accepted `create_session` recommendations prefill adapter, workspace, role, task, objective, and context preparation
- how accepted `continue_session` recommendations reopen or focus an existing session without altering M4 PTY behavior
- how `run_validation` recommendations create a task/session suggestion rather than executing commands automatically
- how recommendations can reference existing context packages or request a fresh context package
- how session creation stores task/recommendation association, if included
- how session restart/reconciliation treats task and recommendation associations
- how M7 keeps M4 PTY streaming/input/resize behavior intact
- how M7 keeps M6 context preparation and delivery behavior intact

Prefer simple, explicit integration over a generic action execution framework.

14. UI Architecture

Define the M7 UI changes.

Cover:

- where task/work units appear in the existing Goal detail experience
- where recommendations appear in the existing Goal detail experience
- recommendation cards, details, confidence, rationale, proposed action, and related context
- accept/reject/dismiss/modify controls
- task create/edit/split/status controls
- task association with sessions and workspaces
- conflict surfacing and resolve controls
- validation recommendation display
- handling no recommendations, no tasks, sparse memory, sparse decisions, no summaries, or no context packages
- handling failed generation
- live event refresh behavior
- keeping existing M4 terminal behavior, M5 memory/decision panels, and M6 context preview/status intact

Keep UI minimal but real. Avoid global command centers, workflow builders, autonomy dashboards, provider/model settings, analytics dashboards, prompt editors, or cross-Goal recommendation views unless backed by M7 data and required for the exit criterion.

15. Milestone Task Breakdown

Break Milestone 7 into sequential implementation tasks.

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

- baseline verification of M1-M6
- contract updates
- database migration
- task/work-unit projection helpers
- recommendation projection helpers
- conflict projection helpers
- generation lifecycle model
- deterministic recommendation provider/job contract
- bounded input builder from Goal/refinement/workspace/task/session/memory/decision/session-summary/context-package sources
- task generation rules
- recommendation generation rules
- validation recommendation rules
- conservative conflict detection rules
- recommendation idempotency and superseding
- feedback persistence
- session creation and context-flow integration
- task APIs
- recommendation APIs
- conflict APIs
- Goal detail task panel UI
- Goal detail recommendations panel UI
- conflict and feedback UI
- integration tests
- restart/reconciliation behavior tests
- documentation

16. Validation Strategy

Define how we validate:

- M1-M6 regression safety
- daemon startup after migration
- contract parsing
- migration from existing DBs
- task generation from Goal refinement and M5/M6 sources
- recommendation generation from session completion and memory/decision/context changes
- validation recommendation after implementation-like activity
- conservative conflict detection from deterministic fixtures
- exclusion of raw terminal output and full transcripts
- recommendation idempotency and duplicate prevention
- superseding stale recommendations
- accept/reject/dismiss/modify feedback persistence
- proposed action validation without direct execution
- event persistence and ordering
- projection correctness
- WebSocket/UI refresh behavior
- daemon restart behavior for pending/running generation jobs
- provider failure and retry behavior
- secret/output logging safeguards
- desktop task/recommendation/conflict flow

Prefer deterministic tests using fixture Goals, tasks, memory, decisions, summaries, context packages, workspaces, sessions, and fake recommendation providers. Use AI/model-backed behavior only if it can be tested deterministically behind an interface.

17. Risks and Simplifications

Identify:

- biggest technical risks
- AI/provider dependency risks, if any
- token/cost/latency risks
- recommendation quality risks
- task quality risks
- stale or duplicate recommendation risks
- source-attribution risks
- feedback/supervision signal risks
- confirmation-required decision risks
- conflict false-positive and false-negative risks
- adapter/session/context integration risks
- SQLite migration and transaction pitfalls
- event-system risks
- daemon restart/recovery risks
- privacy/security risks around memory, summaries, context packages, terminal output, recommendations, and tasks
- logs accidentally containing raw terminal output, rendered context, raw memory text, prompts, model responses, or secrets
- database growth risks
- event payload growth risks
- desktop state and live-refresh risks
- M1/M2/M3/M4/M5/M6 regression risks
- overengineering traps to avoid
- things intentionally deferred

18. Definition of Done

Provide a precise "Milestone 7 complete" definition.

The definition should make clear that M7 is complete only when:

- Goal-scoped task/work units can be generated, viewed, edited, split, and associated with sessions where included in scope
- recommendations are generated after meaningful session or Goal activity
- recommendations include bounded title, rationale, proposed action, confidence, status, and compact source attribution
- users can accept, reject, dismiss, and modify recommendations
- user feedback is persisted as supervision signals
- accepted recommendations prefill existing M4/M6 flows without auto-launching work
- validation recommendations appear after implementation-like activity
- conservative conflicts are detected and visible for human resolution
- task/recommendation/conflict state survives daemon restart or is safely reconciled
- recommendation generation failures are visible and retryable, if retry is included in scope
- recommendations panel and task/work panel are visible in the desktop Goal detail flow
- rendered context, raw terminal output, full transcripts, prompts, model responses, and large source text are not stored in events
- M1-M6 functionality still works
- no Level 4 workflow engine, autonomous execution, automatic session launching, automatic validation execution, cross-Goal recommendations, embedding/vector system, provider configuration, prompt-management platform, or Level 5 automation has been introduced

Very important constraints:

Preserve plugin-first architecture
Preserve skill-first architecture
Preserve event-driven design
Build on the existing M1-M6 runtime instead of replacing it
Use M5 memory, decisions, and session summaries as primary orchestration signals
Use M6 context packages as compact context inputs and session-start artifacts
Use M3 Goal refinements and workspace attachments as bounded task/recommendation sources where appropriate
Build useful suggestions, not automatic execution
Do NOT build Level 4 supervised workflow execution in M7
Do NOT build autonomous session launching in M7
Do NOT build automatic approval gates in M7
Do NOT build continuous reasoning loops in M7
Do NOT build automatic validation command execution in M7
Do NOT build multi-agent scheduling in M7
Do NOT build workspace indexing or file watching in M7
Do NOT build cross-Goal memory, cross-Goal tasks, or cross-Goal recommendations in M7
Do NOT add embeddings/vector search/knowledge graph infrastructure in M7
Do NOT add provider/model configuration UI in M7
Do NOT add generic skill invocation endpoints in M7
Do NOT store raw terminal output, full transcripts, rendered context packages, raw prompts, raw provider inputs/outputs, or raw model responses in the event store
Avoid premature microservices
Avoid overengineering
Favor clean boundaries over feature quantity
Favor deterministic systems over excessive AI reasoning
Favor bounded inputs over exhaustive context
Favor explicit source attribution over unsupported synthesis
Favor local-first behavior and explicit user control

Output the implementation plan as a professional engineering design document with clear sections, rationale, and implementation sequencing.
