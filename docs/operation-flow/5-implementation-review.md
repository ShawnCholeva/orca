You are acting as a principal engineer performing an architectural, privacy, and implementation quality review for the Orca AI-native orchestration platform.

In the `docs/` directory, review the relevant source material before judging the implementation:

- `docs/PRODUCT.md` - product vision and operating principles
- `docs/MVP.md` - MVP scope for Levels 1-3
- `docs/TECHNICAL.md` - target architecture
- `docs/LEVEL_4.md` - future supervised execution boundaries
- `docs/milestones/6.md` - simplified Milestone 6 scope and guardrails
- `docs/implementation-plans/milestone-6.md` - executable Milestone 6 task plan
- `docs/implementation-plans/notes/m6-000-baseline.md` - M6 baseline verification record
- any M6 completion notes appended to `docs/implementation-plans/milestone-6.md`
- `docs/milestones/7.md` - simplified Milestone 7 scope and guardrails
- `docs/implementation-plans/milestone-7.md` - executable Milestone 7 task plan
- `docs/implementation-plans/notes/m7-000-baseline.md` - M7 baseline verification record, if present
- any M7 completion notes appended to `docs/implementation-plans/milestone-7.md`
- the current implementation state in the repository

Your task is to review the Milestone 7 implementation quality and detect architecture drift.

Milestone 7 is:

```text
Suggested Orchestration
```

The intended M7 proof point is:

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

The platform remains:

- local-first
- Tauri v2 desktop app
- Node.js/TypeScript daemon
- event-driven
- plugin-oriented
- skill-oriented
- Goal-centric
- Workspace-aware
- SQLite-backed for the MVP
- orchestration-focused

Milestone 7 adds one runtime capability: durable, bounded, Goal-scoped suggested work and next actions derived from existing evidence. It must not become Level 4 supervised execution, Level 5 autonomy, an autonomous launcher, a workflow engine, a background scheduler, an AI-provider integration layer, a prompt-management framework, an embedding/vector system, a cross-Goal knowledge system, or a generic action execution platform.

## Review Focus

### 1. M7 Scope Compliance

Identify any implementation that exceeds the Milestone 7 boundary.

M7 must include only:

- contract schemas for tasks, task generations, recommendations, recommendation generations, recommendation feedback, conflicts, source refs, proposed actions, roles, statuses, failure codes, trigger kinds, and M7 event literals
- `CreateSessionRequest`, session response, and `session.created` extensions with optional `taskId` and `fromRecommendationId`
- `CreateContextPackageRequest`, context package response, and `context.package.created` extensions with optional `taskId` and `fromRecommendationId`
- `tasks`, `task_generations`, `recommendations`, `recommendation_generations`, `recommendation_feedback`, and `conflicts`
- `sessions.task_id`, `sessions.from_recommendation_id`, `context_packages.task_id`, and `context_packages.from_recommendation_id`
- minimal indexes for Goal reads, active generation idempotency, active task/recommendation/conflict dedupe, session/context task lookup, and terminal feedback idempotency
- Goal-scoped task create/list/update/split/generate use cases
- Goal-scoped recommendation generate/list/detail use cases
- recommendation accept/reject/dismiss/modify use cases
- conflict list/resolve/dismiss use cases
- manual regenerate/re-evaluate through `POST /v1/goals/:goalId/tasks/generate` and `POST /v1/goals/:goalId/recommendations/generate`
- generation lifecycle states: `pending`, `running`, `succeeded`, `failed`
- task statuses: `proposed`, `open`, `in_progress`, `blocked`, `done`, `cancelled`, `archived`
- recommendation statuses: `proposed`, `accepted`, `rejected`, `dismissed`, `modified`, `superseded`
- conflict statuses: `open`, `resolved`, `dismissed`
- failure codes: `invalid_input`, `invalid_output`, `provider_error`, `daemon_restart`, `goal_archived`, `sparse_input`, `internal_error`
- boot reconciliation of stale `pending`/`running` task and recommendation generation rows to `failed` with `daemon_restart`
- internal `orca/recommendation-generation`, `orca/task-generation`, and `orca/conflict-detection` skill descriptors for diagnostics only
- one daemon-local `RecommendationProvider` interface, one deterministic production provider, and fake provider support for tests
- one deterministic task generator
- one deterministic conflict detector set
- bounded input builders that read only existing Goal/refinement/workspace/session/memory/decision/session-summary/context-package projections and M7 task/recommendation/conflict rows
- static or unit test coverage proving M7 orchestration does not import/read raw M4 output tails or transcript modules
- deterministic task generation from Goal refinement and bounded M5/M6 evidence
- deterministic recommendation rules for `create_session`, `continue_session`, `review_output`, `refine_goal`, `split_task`, `run_validation`, `resolve_conflict`, `update_plan`, `ask_user`, `mark_complete`, and `pause_work`
- deterministic validation and review recommendation rules after implementation-like activity
- conservative conflict detectors for active workspace overlap, contradictory confirmed decisions, reviewer rejection, blockers, and unresolved task-blocking questions
- source attribution stored as compact JSON ids on task/recommendation/conflict rows
- zod validation of generator/provider input/output and HTTP request/response shapes
- normalization, content caps, best-effort secret redaction where persisted text is accepted, request fingerprinting, duplicate prevention, and supersede behavior before persistence
- hard cap defaults from the plan
- content-free events with ids/counts/statuses/changed field keys/failure codes only
- Goal detail Tasks panel
- Goal detail Recommendations panel
- Goal detail conflicts banner/drawer
- desktop accept/reject/dismiss/modify controls
- desktop prefill into existing M3/M4/M6/M7 flows without automatic downstream submission
- desktop reconnect/refetch behavior using the existing event subscription
- documentation of endpoints, event payload rules, caps, generation policy, suggestion-only policy, restart policy, retry/idempotency policy, and non-goals
- M1/M2/M3/M4/M5/M6 create/list/refine/workspace/session/memory/context/restart behavior preserved

Flag any of the following as drift unless explicitly justified by a documented defect:

- Level 4 supervised execution
- Level 5 autonomy
- approval gates
- automatic session launch
- automatic context preparation
- automatic validation command execution
- automatic task status transitions from session activity without user action
- automatic retry/backoff
- automatic recommendation execution
- AI-backed recommendation provider implementations
- model provider SDKs
- provider/model configuration UI
- prompt template libraries
- prompt experiments
- token-accurate accounting
- provider cost tracking
- generic skill invocation endpoints
- generic reasoning-job endpoints
- generic action execution endpoints
- generic workflow endpoints
- `POST /v1/recommendations/:id/execute`
- `POST /v1/recommendations/:id/regenerate`
- cross-Goal `GET /v1/recommendations`
- `POST /v1/skills/:id/invoke`
- `POST /v1/tasks/:id/archive` as a separate endpoint
- manual conflict creation endpoint
- recommendation history/diff/editor pages
- task board/Gantt/dependency graph UI
- global task or recommendation dashboards
- command-center panels
- recommendation analytics
- multi-step workflow planning
- workflow engines
- distributed queues
- background workers
- schedulers
- continuous reasoning loops
- cloud infrastructure
- multi-agent scheduling
- agent task assignment endpoints
- cross-Goal memory
- cross-Goal recommendations
- workspace indexing/scanning/file watching
- knowledge graphs
- embeddings
- vector search
- semantic search
- global search
- memory consolidation
- semantic ranking
- relevance engines
- aging/decay systems
- analytics dashboards
- policy/governance systems
- audit engines
- full transcript capture/replay/export/analytics
- raw M4 output-tail reads during M7 orchestration
- source reverse-index join tables
- WebSocket commands for task/recommendation/conflict mutation
- rendered context payload events
- raw provider prompt/template events
- feedback comment events
- continuous reasoning events
- external PM integrations
- new top-level packages

### 2. Architecture Drift Detection

Identify where the implementation has drifted from:

- the architecture docs
- `docs/milestones/7.md`
- `docs/implementation-plans/milestone-7.md`
- the product philosophy
- the event-driven model
- daemon-owned orchestration and runtime state
- the Goal-scoped and SQLite-backed storage boundary
- the M1/M2/M3/M4/M5/M6 operational baseline

Examples of drift:

- UI owning task, recommendation, conflict, feedback, or generation truth instead of rendering daemon state
- business logic leaking into React components instead of daemon use cases, API helpers, or focused hooks
- provider/model selection, prompt templates, model calls, or AI-backed recommendation behavior introduced before deterministic M7 is proven
- a generic plugin/skill/reasoning/action invocation surface introduced instead of daemon-local task/recommendation/conflict seams
- orchestration triggered by workspace scans, file watchers, global boot scans, raw transcripts, or raw M4 output tails
- tasks, recommendations, conflicts, feedback, or generation rows not scoped by `goal_id`
- event payloads containing task text, recommendation rationale, proposedAction bodies, feedback comments, conflict descriptions, memory/decision/summary text, raw terminal output, prompts, provider input/output, model responses, or model reasoning
- terminal output copied into the general domain event store or M7 tables
- daemon write paths that emit events but do not update projection rows and insert events inside the same SQLite transaction
- WebSocket broadcasts happening before commit
- runner state managed by globals instead of the explicit `DaemonContext` seam
- background queues, worker pools, schedulers, retry services, or workflow engines introduced for the M7 in-process deterministic loop
- recommendation acceptance calling downstream M3/M4/M6/M7 endpoints automatically instead of returning a proposedAction and letting the user submit the existing flow
- M7 changes that repurpose or break M1/M2/M3/M4/M5/M6 endpoint shapes, event names, WebSocket frames, or session/context behavior

### 3. Contract And API Discipline

Verify the public surface is minimal and contract-driven.

Check that:

- `@orca/contracts` contains only M7-needed public wire schemas plus internal provider/generator I/O schemas needed by daemon tests
- no workflow, approval, autonomous run, embedding, provider/model configuration, prompt-management, generic skill, generic reasoning-job, generic action, cross-Goal recommendation, or cross-Goal memory schemas were added
- row schemas match the six M7 persistence tables and cap text fields as specified
- request schemas are strict and reject unknown fields
- event payload schemas are strict and reject content/text fields that are not explicitly allowed
- `DomainEventType` adds only the M7 event set:
  - `task.generation.requested`
  - `task.generated`
  - `task.generation.failed`
  - `task.created`
  - `task.updated`
  - `task.split`
  - `task.status_changed`
  - `task.associated_with_session`
  - `task.associated_with_context_package`
  - `recommendation.generation.requested`
  - `recommendation.generated`
  - `recommendation.generation.failed`
  - `recommendation.accepted`
  - `recommendation.rejected`
  - `recommendation.dismissed`
  - `recommendation.modified`
  - `recommendation.superseded`
  - `conflict.detected`
  - `conflict.resolved`
  - `conflict.dismissed`
  - `user.feedback.recorded`
- `ProposedAction` is a zod discriminated union on `kind` with only M7 kinds
- task/recommendation/conflict/generation status values match persistence and route behavior
- provider/generator input/output schemas enforce count and text caps
- existing session/context package schemas remain backward compatible and add only optional `taskId` / `fromRecommendationId` fields
- M7 HTTP routes inherit existing local auth/CORS behavior
- task archive is implemented through `PATCH /v1/tasks/:id` with `status='archived'`, not a separate action endpoint
- recommendation accept/reject/dismiss routes are idempotent and do not call downstream action endpoints
- `POST /v1/goals/:goalId/*/generate` handles retry/idempotency without exposing a generic reasoning API
- no breaking change was introduced for M1/M2/M3/M4/M5/M6 callers

### 4. Database And Projection Discipline

Review the M7 persistence shape.

Verify that the M7 migration creates exactly:

- `tasks`
- `task_generations`
- `recommendations`
- `recommendation_generations`
- `recommendation_feedback`
- `conflicts`

Verify that it adds only:

- `sessions.task_id`
- `sessions.from_recommendation_id`
- `context_packages.task_id`
- `context_packages.from_recommendation_id`

Check that:

- no extra M7 tables were added
- earlier migrations are not rewritten for M7
- foreign keys preserve the Goal/session/context boundary and restart durability
- `tasks` has `goal_id`, optional `parent_task_id`, optional `workspace_id`, role, status, origin, title, description, acceptance criteria JSON, validation steps JSON, dependencies JSON, source refs JSON, generation id, fingerprint, timestamps, and archive timestamp
- `task_generations` stores trigger, generator id/version, input/request fingerprints, lifecycle, failure info, generated ids, sparse flag, and timestamps
- `recommendations` stores type, status, source, bounded title/rationale, proposedAction JSON, confidence, compact source refs, related ids, fingerprint, supersede metadata, timestamps, and terminal timestamp
- `recommendation_generations` stores trigger, provider id/version, input/request fingerprints, lifecycle, failure info, recommendation ids, superseded ids, sparse flag, and timestamps
- `recommendation_feedback` stores recommendation id, goal id, action, capped optional note, compact modified payload snapshot where applicable, and timestamp
- `conflicts` stores goal id, conflict type, severity, status, bounded title/description, compact source refs, fingerprint, optional resolution note, and timestamps
- required indexes exist for Goal reads, active generation idempotency, active task/recommendation/conflict dedupe, runner pickup/reconciliation, feedback lookup, terminal feedback idempotency, and session/context task lookup
- generator-origin task dedupe uses `(goal_id, fingerprint)` for non-terminal generator tasks only
- recommendation dedupe uses `(goal_id, fingerprint)` for active proposed recommendations only
- conflict dedupe uses `(goal_id, fingerprint)` for open conflicts only
- active generation idempotency uses `(goal_id, request_fingerprint)` for `pending`/`running`/`succeeded` rows only
- failed generation rows are terminal and do not block explicit retry
- projection helpers accept explicit database/transaction handles and do not publish events
- projection helpers serialize SQLite rows into contract-shaped responses deterministically
- restart behavior reads projection tables rather than relying on event replay
- raw terminal output, raw provider input/output, prompts, raw model responses, source text copies, and model reasoning are not persisted

### 5. Event And Transaction Integrity

Review every M7 write path that emits events:

- task generation request/success/failure
- task create/update/split/status change
- task association with session/context package
- recommendation generation request/success/failure
- recommendation accept/reject/dismiss/modify/supersede
- feedback record creation
- conflict detection/resolve/dismiss
- conflict-resolution auto-dismiss of linked recommendation
- session create with optional task/recommendation association
- context package create with optional task/recommendation association
- boot reconciliation failure marking
- orchestrator trigger enqueue

Verify that:

- projection rows and associated events are inserted or updated inside one SQLite transaction
- broadcasts happen only after `COMMIT` succeeds
- event payloads are content-free and include only ids/counts/statuses/type/source pointers/changed field keys/failure codes
- event payloads never include recommendation rationale, task title/description/acceptance criteria/validation steps, proposedAction bodies, feedback notes, conflict descriptions/resolution notes, memory content, decision text, summary text, terminal output, prompts, provider input/output, candidate content, model responses, or model reasoning
- serialized event payloads are capped at 4 KiB and covered by tests
- committed event order matches the transaction order expected by live refresh
- failed transactions leave no partial projection rows or event rows
- generation success commits generated rows, generation status/counts, superseded rows where applicable, and completion event atomically
- generation failure commits failure state and failure event atomically
- duplicate task/recommendation/conflict candidates do not abort an entire generation unless the task explicitly requires it
- manual status transitions emit the specific lifecycle event where required, not only generic update events
- no output append, terminal input, terminal resize, provider operation, prompt operation, or raw rule-evaluation trace creates a domain event
- M1/M2/M3/M4/M5/M6 event sequences remain unchanged for non-M7 flows

### 6. Generation Lifecycle, Idempotency, And Orchestrator Triggers

Review the generation state machine and runner.

Verify that:

- normal lifecycle is `pending -> running -> succeeded`
- failure lifecycle is `pending -> running -> failed`
- failed rows are terminal
- boot reconciliation marks stale `pending`/`running` rows failed with `daemon_restart` before HTTP/WS listen
- reconciliation leaves `succeeded` and already `failed` rows untouched
- retry is explicit through Goal-scoped generate endpoints
- retry after failure creates a new generation row for the current request fingerprint
- active `pending`/`running`/`succeeded` rows for the current request fingerprint are returned instead of duplicated
- request fingerprint includes Goal, trigger kind, trigger source id, provider/generator id, version, and input fingerprint
- input fingerprint is deterministic over bounded projection state
- triggers run only from committed events or explicit user requests
- triggers are table-driven and tested
- meaningful trigger events include refinement applied, session completed, session summary changes, memory/decision changes, context package creation, task changes, conflict detection, and relevant feedback changes
- runner is in-process and bounded; no background queue, scheduler, worker pool, automatic backoff, or continuous reasoning loop was added
- runner shutdown does not leave in-memory-only state needed for correctness
- failure codes are deterministic and do not leak sensitive content
- provider/generator errors become bounded failure rows without logging raw input/output or candidate content

### 7. Input Builders, Output Validation, Redaction, And Privacy

Review the M7 provider/generator boundaries carefully.

Verify that M7 generation reads only:

- Goal row
- latest Goal refinement fields
- attached workspace metadata already known from M3
- session row/lifecycle/status fields
- M5 memory items
- M5 decisions
- M5 session summaries
- M6 context package ids and small metadata
- M7 tasks
- M7 recommendations
- M7 conflicts
- M7 feedback rows

Verify that M7 generation does not read:

- workspace file contents
- git history
- full transcripts
- raw M4 output tails
- raw terminal history
- cross-Goal memory
- prompts or model responses
- provider/model configuration
- rendered context bytes

Check that:

- provider/generator output is zod-validated before persistence
- task/recommendation/conflict text is normalized and capped before persistence
- best-effort secret redaction handles obvious assignments such as `password=`, `token=`, `api_key=`, and `authorization: bearer`
- content hashes/fingerprints are computed after canonicalization
- recommendation rationale, task descriptions, conflict descriptions, proposedAction JSON, and feedback notes are never logged
- raw provider outputs are not persisted
- deterministic providers are conservative; false negatives are acceptable, unsupported synthesis is not
- sparse input produces a bounded sparse generation outcome or a `refine_goal` recommendation rather than hallucinated work
- confirmation-required decisions from M5 are treated carefully and never auto-confirmed

### 8. Task Behavior

Review the user-controlled and generated task surface.

Verify that:

- task list is Goal-scoped and hides archived rows by default unless documented otherwise
- task create supports only allowed roles/statuses/origins and caps all text fields
- task patch supports only allowed fields and transitions
- task split creates child tasks in the same Goal and can optionally move the parent to `blocked`
- task dependencies are same-Goal ids only
- task workspace association validates the workspace belongs to the same Goal
- generator-origin active duplicate tasks are prevented by fingerprint
- manual tasks are not blocked by generator dedupe
- association with sessions/context packages validates same Goal
- M7 never auto-transitions task status from session activity without user action or accepted recommendation routing
- missing Goal, archived Goal, wrong Goal, malformed id, invalid enum, invalid dependency, and invalid transition cases return clear errors
- task APIs do not trigger context assembly, session launch, validation execution, prompts, workflows, or cross-Goal behavior

### 9. Recommendation And Feedback Behavior

Review the recommendation lifecycle and supervision signal.

Verify that:

- recommendation list is Goal-scoped and defaults to active proposed recommendations unless documented otherwise
- generation creates bounded recommendations with valid proposedAction payloads
- all 11 proposedAction kinds are covered by deterministic rules or explicit no-fire behavior
- accept/reject/dismiss are one-shot terminal actions, idempotent on repeat, and write feedback rows
- modify is non-terminal, snapshots pre-modify payload compactly, and writes feedback
- supersede preserves old rows and links to the replacing recommendation where applicable
- accepted recommendations return the proposedAction but do not execute it
- accepted recommendations may prefill existing desktop flows only
- recommendation source refs are compact ids, not copied source text
- stale/archived source behavior is explicit and does not crash list/detail reads
- no generic execute endpoint, generic action runner, recommendation scheduler, AI provider, model call, or prompt framework exists

### 10. Conflict Behavior

Review conservative conflict detection.

Verify that:

- conflict list is Goal-scoped and defaults to open conflicts
- detector families are limited to active workspace overlap, contradictory confirmed decisions, reviewer rejection, blocker reported, and unresolved task-blocking questions
- conflict fingerprints prevent duplicate open conflicts for the same source set
- each detected conflict creates a linked `resolve_conflict` recommendation in the same transaction
- resolve/dismiss updates conflict state and auto-dismisses the linked recommendation in the same transaction
- conflict descriptions and resolution notes are capped, redacted, and never emitted in events
- false positives can be dismissed cleanly
- no semantic conflict engine, AI-backed synthesis, manual conflict creation endpoint, or workflow gate was introduced

### 11. Session And Context Extension Behavior

Review the optional association extensions.

Verify that:

- `POST /v1/sessions` preserves byte-identical M4 behavior when `taskId` and `fromRecommendationId` are absent
- `POST /v1/sessions` validates task/recommendation belong to the same Goal when present
- recommendation must be accepted before it can be used as `fromRecommendationId`
- session row persists both optional ids
- `session.created` event includes only optional ids, not recommendation or task bodies
- `POST /v1/goals/:goalId/context-packages` preserves M6 behavior when optional ids are absent
- context package creation validates same Goal and accepted recommendation when present
- context package row persists both optional ids
- `context.package.created` event includes only optional ids, not rendered context or recommendation/task bodies
- no adapter delivery behavior regresses
- no rendered context appears in argv, env, logs, WebSocket events, or domain event payloads

### 12. Desktop Integration Quality

Review the UI as the minimum product loop for suggested orchestration.

Verify that:

- existing M1/M2/M3 Goal list, Create Goal flow, Goal detail refinement, workspace behavior, M4 sessions, M5 memory/decisions/summaries, and M6 context package flows remain usable
- Tasks, Recommendations, and Conflicts live under Goal detail, not a global dashboard
- Tasks panel supports loading, empty, generating, failed, loaded, generate, edit, split, status, and refetch states
- Recommendations panel supports loading, empty, generating, failed, proposed, accepted, rejected, dismissed, modified, superseded, accept, reject, dismiss, modify, detail, and refetch states
- Conflicts banner/drawer supports open/resolved/dismissed states
- Accept handlers call only the recommendation accept endpoint and open prefilled downstream UI without submitting it
- reject/dismiss/modify controls record feedback through daemon APIs
- desktop does not patch local task/recommendation/conflict state directly from event payloads; REST remains source of truth
- M7 events for the currently open Goal refetch only affected resources
- M7 events for other Goals are ignored
- WebSocket reconnect refetches tasks, recommendations, conflicts, sessions, and context packages relevant to the open Goal
- event listeners are cleaned up on unmount and Goal changes
- UI does not expose provider/model settings, prompt editors, workflow controls, global dashboards, command-center panels, analytics, or dependency graph views
- content displays avoid leaking raw terminal output, raw provider input/output, or source bodies where compact refs are sufficient
- the visual addition remains small, maintainable, and consistent with the existing desktop app

### 13. Documentation And Completion Record

Verify the final documentation is accurate.

Check that:

- `docs/milestones/7.md` has a clear completed status and brief outcome notes
- `docs/implementation-plans/milestone-7.md` has a completion record with:
  - final commit SHA or an explicit pending placeholder if not yet committed
  - full-suite typecheck summary
  - full-suite test summary
  - new endpoints
  - new events
  - new tables/columns
  - non-goals reaffirmed
- documentation describes endpoint behavior, event payload rules, caps, deterministic generation policy, suggestion-only policy, restart policy, retry/idempotency policy, and non-goals
- completion notes do not claim a manual smoke or restart behavior that was not actually run
- baseline notes from M7-000 exist and show a green M1/M2/M3/M4/M5/M6 starting point
- review gates were honored or deviations are explicitly recorded

### 14. Test And Validation Coverage

Assess whether validation proves the M7 loop without overbuilding a test matrix.

Expected coverage:

- M7-000 baseline verification recorded and green
- M1 baseline integration still passes
- M2 loop still passes
- M3 create/refine/workspace integration still passes
- M4 session lifecycle, PTY, output tail, restart, and WebSocket tests still pass
- M5 memory/decision/session-summary extraction loop still passes
- M6 context package/session preparation loop still passes
- contracts parse happy paths and reject invalid M7 wire shapes
- proposedAction union tests cover every kind
- event payload contract tests reject unknown and forbidden content/text fields
- migration tests cover fresh DB, six tables, four added columns, required indexes, FK behavior, active generation idempotency, active dedupe, and M6 fixture upgrade
- projection tests cover insert/read/list/update for tasks, task generations, recommendations, recommendation generations, feedback, and conflicts
- task API tests cover generate/list/create/patch/split/associate/error cases and content-free events
- recommendation API tests cover generate/list/detail/accept/reject/dismiss/modify/error cases and content-free events
- conflict API tests cover list/resolve/dismiss/error cases and linked recommendation auto-dismiss
- generation lifecycle tests cover request/start/succeeded/failed, boot reconciliation, idempotency, retry, and duplicate handling
- input builder tests cover source selection, caps, deterministic fingerprints, archived source behavior, and no raw output-tail/transcript imports
- deterministic task generator tests cover refinement parsing, role selection, workspace defaulting, sparse behavior, dedupe, and false-positive guard cases
- deterministic recommendation provider tests cover all 11 proposedAction kinds, fire/no-fire fixtures, source refs, confidence, caps, and sparse behavior
- validation/review recommendation tests cover implementation-like activity detection from M5 summaries without raw output tails
- conflict detector tests cover five detector families, dedupe, false-positive dismissal, and linked resolve_conflict recommendations
- orchestrator trigger tests cover committed-event triggers, manual triggers, table completeness, single-flight, and dirty-flag re-evaluation
- session/context extension tests prove absent optional ids preserve M4/M6 behavior and present ids validate same Goal/accepted recommendation
- daemon proof-loop integration proves state change -> generation -> tasks/recommendations/conflicts -> feedback -> restart durability
- desktop API wrapper tests cover new M7 endpoints
- desktop component tests cover task panel, recommendations panel, conflict banner, per-kind prefill, no-auto-launch, event-driven refetch, cross-Goal event ignore, and reconnect refetch
- `pnpm -r typecheck` passes
- `pnpm -r test` passes
- manual desktop smoke is recorded if claimed as part of shippability

Flag missing tests that create real regression risk. Do not demand tests for deferred systems such as workflow engines, approval gates, autonomous execution, provider/model behavior, workspace indexing, file watching, embeddings, vector search, transcript replay, cross-Goal search, recommendation analytics, or AI-backed providers.

## Definition Of Done Cross-Check

Check `docs/milestones/7.md` Definition of Done line by line:

1. A refined Goal can produce persisted generated tasks from deterministic bounded evidence.
2. Task rows include source refs, role/workspace fields, status, acceptance criteria, validation steps, and survive restart.
3. Recommendations support `proposed -> accepted | rejected | dismissed | modified | superseded`.
4. User feedback is persisted as supervision signal and emits content-free events.
5. Accepted recommendations prefill existing M4/M6/M3/M7 flows without auto-launching.
6. Validation recommendations appear after implementation-like activity.
7. Conservative conflicts are detected, visible, and resolvable/dismissible.
8. Task/recommendation/conflict state survives daemon restart, and in-flight generations reconcile to failed/daemon_restart.
9. Recommendation generation failures are visible and retryable.
10. Tasks panel, Recommendations panel, and Conflicts banner exist in Goal detail with live refresh.
11. Event payloads remain content-free and capped.
12. Deterministic provider is the only production recommendation provider; fake provider is test-only.
13. M7 storage stays inside the existing SQLite DB with only the approved tables/columns.
14. Session and context package optional association fields preserve old behavior when omitted.
15. Internal skill descriptors are diagnostic-only and no public skill invocation route exists.
16. M1-M6 behavior remains green.
17. No Level 4 workflow engine, autonomous execution, automatic session launching, automatic validation command execution, cross-Goal recommendations, embedding/vector system, provider configuration UI, prompt-management platform, Level 5 autonomy, manual conflict creation endpoint, AI-backed provider, or background queue/worker has been introduced.
18. The final proof loop demonstrates end-to-end suggestion behavior, conflict detection + auto-dismiss, mid-generation restart recovery, and a green full regression.

If any item is not satisfied, classify it as a finding unless the implementation notes explicitly mark it as an accepted outstanding manual gate.

## Findings Format

For each issue, provide:

- severity: `critical`, `high`, `medium`, or `low`
- file and line reference where possible
- the drift or defect
- why it matters long-term
- recommended correction
- correction timing: `immediate`, `soon`, or `acceptable for MVP`

Prioritize findings by risk to:

- M1/M2/M3/M4/M5/M6 regression safety
- privacy and content-free event guarantees
- event/transaction correctness
- suggestion-only behavior
- generation lifecycle correctness
- retry/idempotency behavior
- restart reconciliation and durability
- daemon-owned state boundaries
- Goal scoping and SQLite storage boundaries
- M4 terminal output isolation
- M6 context package safety
- future Level 4 approval-gate architecture
- future plugin/provider architecture
- desktop cleanup, reconnect, and refetch correctness

If no findings are discovered, state that explicitly and list any residual risks or testing gaps.

Do not rewrite the implementation during the review. Produce a review report focused on defects, drift, missing validation, privacy risks, and targeted remediation.
