You are acting as a principal engineer performing an architectural, privacy, and implementation quality review for the Orca AI-native orchestration platform.

In the `docs/` directory, review the relevant source material before judging the implementation:

- `docs/PRODUCT.md` - product vision and operating principles
- `docs/MVP.md` - MVP scope for Levels 1-3
- `docs/TECHNICAL.md` - target architecture
- `docs/LEVEL_4.md` - future supervised execution boundaries
- `docs/milestones/5.md` - simplified Milestone 5 scope and guardrails
- `docs/implementation-plans/milestone-5.md` - executable Milestone 5 task plan
- `docs/implementation-plans/notes/m5-000-baseline.md` - baseline verification record
- any M5 completion notes appended to `docs/implementation-plans/milestone-5.md`
- the current implementation state in the repository

Your task is to review the Milestone 5 implementation quality and detect architecture drift.

Milestone 5 is:

```text
Shared Memory
```

The intended M5 proof point is:

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

The platform remains:

- local-first
- Tauri v2 desktop app
- Node.js/TypeScript daemon
- event-driven
- plugin-oriented
- skill-oriented
- Goal-centric
- SQLite-backed for the MVP
- orchestration-focused

Milestone 5 adds one runtime capability: durable Goal-scoped memory, decisions, session summaries, and extraction lifecycle state from bounded existing evidence. It must not become context assembly, prompt injection, recommendation generation, task/workflow automation, transcript analytics, generic skill execution, provider/model configuration, or cross-Goal memory.

## Review Focus

### 1. M5 Scope Compliance

Identify any implementation that exceeds the Milestone 5 boundary.

M5 must include only:

- contract schemas for memory items, decisions, session summaries, extraction rows, extractor input/output, and M5 event literals
- `goal_memory_items`, `goal_decisions`, `session_summaries`, and `memory_extractions`
- minimal indexes for Goal reads, duplicate prevention, active extraction idempotency, source lookup, and runner pickup
- Goal-scoped memory list/create/patch use cases
- Goal-scoped decision list/create/patch use cases
- memory statuses: `candidate`, `promoted`, `archived`
- decision statuses: `proposed`, `confirmed`, `archived`
- manual memory creation, edit, promote, and archive through the bounded API surface
- manual decision creation, edit, confirm, and archive through the bounded API surface
- compact source attribution to refinement, session/output byte window, or manual source
- one daemon-local extractor interface
- one deterministic extractor implementation
- fake extractor support for tests
- bounded extractor input assembled from Goal/refinement/session metadata and capped M4 output tail
- ANSI/control stripping before extraction
- input byte caps, output text caps, candidate count caps, and truncation flags
- zod validation of extractor output
- normalization, content hashing, duplicate prevention, and best-effort secret redaction before persistence
- in-process serial extraction runner
- extraction lifecycle states: `pending`, `running`, `succeeded`, `failed`
- boot reconciliation of stale `pending`/`running` extractions to `failed` with `daemon_restart`
- terminal-session hook that enqueues after M4 terminal state commits
- Goal-open detection that enqueues eligible terminal sessions for that Goal only
- M3 refinement seed memory for constraints and success criteria
- the following REST endpoints:
  - `GET /v1/goals/:goalId/memory`
  - `POST /v1/goals/:goalId/memory`
  - `PATCH /v1/memory/:id`
  - `GET /v1/goals/:goalId/decisions`
  - `POST /v1/goals/:goalId/decisions`
  - `PATCH /v1/decisions/:id`
  - `GET /v1/sessions/:sessionId/summary`
  - `POST /v1/sessions/:sessionId/extract-memory`
- latest extraction status and summary headline fields on existing Goal/session reads where useful
- Goal detail memory panel
- Goal detail decisions panel
- session extraction badge, manual extract/retry button, and summary display in the existing sessions area
- desktop reconnect/refetch behavior using the existing event subscription
- documentation of endpoints, event payload rules, caps, extraction policy, restart policy, and non-goals
- M1/M2/M3/M4 create/list/refine/workspace/session/restart behavior preserved

Flag any of the following as drift unless explicitly justified by a documented defect:

- `POST /v1/memory/:id/promote`
- `POST /v1/memory/:id/canonicalize`
- `POST /v1/memory/:id/archive`
- `POST /v1/decisions/:id/confirm`
- `POST /v1/decisions/:id/archive`
- `GET /v1/sessions/:sessionId/extractions`
- generic skill invocation endpoints
- generic extractor invocation endpoints
- context assembly endpoints
- prompt injection endpoints
- recommendation endpoints
- task endpoints
- workflow endpoints
- memory search endpoints
- embedding/vector endpoints
- cross-Goal memory endpoints
- provider/model configuration endpoints
- WebSocket commands for memory edits or extraction triggers
- raw terminal output events
- extractor prompt events
- raw extractor response events
- context package events
- recommendation, task, or workflow events
- continuous reasoning events
- canonical memory state
- automatic decision confirmation
- full transcript processing or transcript persistence
- AI-backed extractor implementation
- model provider integration
- background worker infrastructure, queues, schedulers, or worker pools
- global memory UI, command center, or new top-level navigation
- workspace indexing, workspace scanning, or file watching
- knowledge graph, embedding, vector search, semantic search, ranking, or memory consolidation systems
- new top-level package
- cloud sync

### 2. Architecture Drift Detection

Identify where the implementation has drifted from:

- the architecture docs
- `docs/milestones/5.md`
- `docs/implementation-plans/milestone-5.md`
- the product philosophy
- the event-driven model
- daemon-owned orchestration and runtime state
- the Goal-scoped and SQLite-backed storage boundary
- the M1/M2/M3/M4 operational baseline

Examples of drift:

- UI owning memory, decision, summary, or extraction truth instead of rendering daemon state
- business logic leaking into React components instead of daemon use cases, API helpers, or focused hooks
- extractor selection, provider config, prompt templates, or model calls introduced before the deterministic M5 loop is proven
- a generic plugin/skill/extractor invocation surface introduced instead of the single daemon-local extractor seam
- extraction triggered by workspace scans, file watchers, global boot scans, or cross-Goal searches
- memory or decisions not scoped by `goal_id`
- memory sourced from raw files, full transcripts, prompts, model reasoning, or sibling-session context
- event payloads containing memory content, decision text, summaries, raw terminal output, prompts, raw extractor responses, or candidate text
- terminal output copied into the general domain event store or any M5 table except compact byte-window pointers
- daemon write paths that emit events but do not update projection rows and insert events inside the same SQLite transaction
- WebSocket broadcasts happening before commit
- extraction runner state managed by globals instead of the explicit `DaemonContext` seam
- background queues, worker pools, schedulers, retry services, or workflow engines introduced for a serial local-first extraction loop
- M5 changes that repurpose or break M1/M2/M3/M4 endpoint shapes, event names, WebSocket frames, or session behavior

### 3. Contract And API Discipline

Verify the public surface is minimal and contract-driven.

Check that:

- `@orca/contracts` contains only M5-needed public wire schemas plus the internal extractor I/O schemas needed by daemon tests
- no context package, recommendation, task, workflow, embedding, provider/model, generic skill, generic extractor, cross-Goal memory, or canonical memory schemas were added
- M5 row schemas match the four persistence tables and cap text fields as specified
- request schemas are strict and reject unknown fields
- event payload schemas are strict and reject content/text fields
- `DomainEventType` adds only the M5 event set:
  - `memory.extraction.requested`
  - `memory.extraction.started`
  - `memory.extraction.completed`
  - `memory.extraction.failed`
  - `memory.item.created`
  - `memory.item.updated`
  - `memory.item.promoted`
  - `memory.item.archived`
  - `decision.created`
  - `decision.updated`
  - `decision.confirmed`
  - `decision.archived`
- `MemoryExtractionStatus`, `GoalMemoryStatus`, and `GoalDecisionStatus` values match persistence and route behavior
- `MemoryExtractionFailureCode` values are narrow and useful
- extractor input/output schemas enforce candidate count caps and text length caps
- existing session read schemas remain backward compatible and add only optional `latestExtraction` / `latestSummaryHeadline` style fields
- M5 HTTP routes inherit existing local auth/CORS behavior
- memory and decision PATCH routes implement allowed transitions without adding excluded action endpoints
- `POST /v1/sessions/:sessionId/extract-memory` handles retry/idempotency without exposing a generic extractor API
- no breaking change was introduced for M1/M2/M3/M4 callers

### 4. Database And Projection Discipline

Review the M5 persistence shape.

Verify that:

- migration `0005_memory.sql` creates exactly:
  - `goal_memory_items`
  - `goal_decisions`
  - `session_summaries`
  - `memory_extractions`
- no extra M5 tables were added
- earlier migrations are not rewritten for M5
- foreign keys preserve the Goal/session boundary and restart durability
- `goal_memory_items` has `goal_id`, `type`, `status`, normalized/redacted `content`, `content_hash`, confidence, compact source fields, and timestamps
- `goal_decisions` has `goal_id`, title, normalized/redacted decision text/rationale, status, confirmation flag, confidence, compact source fields, and timestamps
- `session_summaries` stores bounded summary fields and compact source offsets, not raw output
- `memory_extractions` stores lifecycle, trigger, source fingerprint, counts, failure info, and source offsets
- required indexes exist for Goal reads, source lookup, runner pickup, active extraction idempotency, and live-memory dedupe
- memory dedupe uses `(goal_id, type, content_hash)` for non-archived rows only
- active extraction idempotency uses `(session_id, source_fingerprint)` for `pending`/`running`/`succeeded` rows only
- failed extraction rows are terminal and do not block explicit retry
- projection helpers accept explicit database/transaction handles and do not publish events
- projection helpers serialize SQLite rows into contract-shaped responses deterministically
- restart behavior reads projection tables rather than relying on event replay
- raw terminal output, prompts, raw extractor responses, and candidate pre-normalization text are not persisted

### 5. Event And Transaction Integrity

Review every M5 write path that emits events:

- manual memory create/update/promote/archive
- manual decision create/update/confirm/archive
- extraction request
- extraction start
- extraction success
- extraction failure
- refinement seed memory creation
- boot reconciliation failure marking
- terminal-state extraction enqueue
- Goal-open extraction enqueue

Verify that:

- projection rows and associated events are inserted or updated inside one SQLite transaction
- broadcasts happen only after `COMMIT` succeeds
- event payloads are content-free and include only ids/counts/status/type/source pointers
- event payloads never include memory content, decision text, summary text, rationale, terminal output, prompts, raw extractor output, candidate content, or model reasoning
- committed event order matches the transaction order expected by live refresh
- failed transactions leave no partial projection rows or event rows
- extraction success commits summary, memory rows, decision rows, extraction status/counts, and completion event atomically
- extraction failure commits failure state and failure event atomically
- duplicate memory candidates do not abort the entire extraction unless the spec explicitly says they should
- manual status transitions emit the specific lifecycle event where required, not only generic update events
- no output append, terminal input, terminal resize, or raw extractor operation creates a domain event
- M1/M2/M3/M4 event sequences remain unchanged for non-M5 flows

### 6. Extraction Lifecycle And Idempotency

Review the extraction state machine and runner.

Verify that:

- normal lifecycle is `pending -> running -> succeeded`
- failure lifecycle is `pending -> running -> failed`
- failed rows are terminal
- boot reconciliation marks stale `pending`/`running` rows failed with `daemon_restart` before HTTP/WS listen
- reconciliation leaves `succeeded` and already `failed` rows untouched
- retry is explicit through `POST /v1/sessions/:sessionId/extract-memory`
- retry after failure creates a new extraction row for the current source fingerprint
- active `pending`/`running`/`succeeded` rows for the current source fingerprint are returned instead of duplicated
- source fingerprint uses the current session id, source byte window, and extractor version
- terminal-state hook enqueues only after the M4 terminal state transaction commits
- Goal-open detection enqueues eligible terminal sessions for the currently opened Goal only
- Goal-open detection does not scan the workspace or all Goals globally
- only terminal or otherwise eligible sessions can be extracted
- session archive / Goal archive behavior matches the documented failure or skip policy
- runner is in-process and serial; no background queue, scheduler, or worker pool was added
- runner shutdown does not leave in-memory-only state needed for correctness
- failure codes are deterministic and do not leak sensitive content
- extractor timeouts or thrown errors become bounded failure rows without logging raw output or candidate content

### 7. Extraction Input, Output, Redaction, And Privacy

Review the extractor boundary carefully.

Verify that extraction reads only:

- Goal row
- latest Goal refinement fields
- attached workspace metadata
- session metadata
- capped M4 output tail

Verify that extraction does not read:

- workspace file contents
- git history
- full transcripts
- raw terminal history outside the M4 capped tail
- sibling-session context
- prior cross-Goal memory
- prompts or model responses
- provider/model configuration

Check that:

- at most the configured M5 input byte cap is read from the M4 tail
- the most recent bytes are preferred when the tail exceeds the cap
- byte offsets and truncation flags are recorded correctly
- UTF-8 decode uses replacement for invalid bytes
- ANSI and control sequences are stripped before extraction
- extractor output is zod-validated before persistence
- memory and decision candidate text is normalized before hashing and persistence
- content caps are enforced after normalization/redaction
- best-effort secret redaction handles obvious assignments such as `password=`, `token=`, `api_key=`, and `authorization: bearer`
- `content_hash` is computed after normalization/redaction
- summary text, memory content, decision text, and rationale are never logged
- raw extractor responses are not persisted
- deterministic extractor is conservative; false negatives are acceptable, unsupported synthesis is not
- automatic memory promotion is limited to deterministic low-risk cases:
  - refinement-sourced constraints
  - refinement-sourced success criteria
  - high-confidence session blockers derived from exit/failure metadata
  - high-confidence validation results derived from clean terminal completion
- extracted decisions remain proposed
- high-impact or uncertain decisions set `confirmation_required = true`
- no decision is auto-confirmed

### 8. Manual Memory And Decision Behavior

Review the user-controlled CRUD surface.

Verify that:

- memory list is Goal-scoped and hides archived rows by default unless documented otherwise
- memory create supports only allowed types and statuses
- memory patch supports only allowed fields and transitions
- memory promote/archive update timestamps correctly and emit the correct events
- manual memory source attribution is compact and does not pretend to have session byte offsets
- decision list is Goal-scoped and hides archived rows by default unless documented otherwise
- decision create supports only proposed/confirmed statuses as specified
- decision patch supports edit/confirm/archive through the bounded PATCH route
- decision confirm/archive update timestamps correctly and emit the correct events
- manual decisions default confirmation behavior matches the contract
- duplicate live memory rows are prevented by normalized/redacted content hash
- archived memory can be superseded without breaking the dedupe index
- missing Goal, archived Goal, wrong Goal, malformed id, invalid enum, and invalid transition cases return clear errors
- manual APIs do not trigger extraction, context assembly, prompts, tasks, or recommendations

### 9. Desktop Integration Quality

Review the UI as the minimum product loop for shared memory.

Verify that:

- existing M1/M2/M3 Goal list, Create Goal flow, Goal detail refinement, workspace behavior, and M4 sessions remain usable
- memory and decisions live under Goal detail, not a global dashboard
- session summary and extraction status live in the existing sessions area
- memory panel supports loading, empty, failed, create, edit, promote, archive, and refetch states
- decisions panel supports loading, empty, failed, create, edit, confirm, archive, and refetch states
- session badge displays pending/running/succeeded/failed/truncated/output-unavailable states simply
- manual extract/retry button calls only `POST /v1/sessions/:sessionId/extract-memory`
- summary display uses `GET /v1/sessions/:sessionId/summary`
- desktop does not patch local memory/decision state directly from event payloads; REST remains source of truth
- M5 events for the currently open Goal refetch only the affected resources
- M5 events for other Goals are ignored
- WebSocket reconnect refetches memory, decisions, sessions, and the latest summary for any open session detail
- event listeners are cleaned up on unmount and Goal changes
- UI does not expose provider/model settings, prompt editors, context package previews, recommendations, task panels, workflow controls, or global memory views
- content displays avoid leaking raw terminal output or raw extractor responses
- the visual addition remains small, maintainable, and consistent with the existing desktop app

### 10. Documentation And Completion Record

Verify the final documentation is accurate.

Check that:

- `docs/milestones/5.md` has a clear completed status and brief outcome notes
- `docs/implementation-plans/milestone-5.md` has a completion record with:
  - final commit SHA or an explicit pending placeholder if not yet committed
  - full-suite typecheck summary
  - full-suite test summary
  - new endpoints
  - new events
  - new tables
  - non-goals reaffirmed
- documentation describes endpoint behavior, event payload rules, caps, extraction policy, restart policy, retry/idempotency policy, and non-goals
- completion notes do not claim a manual smoke or restart behavior that was not actually run
- baseline notes from M5-000 exist and show a green M1/M2/M3/M4 starting point
- review gates were honored or deviations are explicitly recorded

### 11. Test And Validation Coverage

Assess whether validation proves the M5 loop without overbuilding a test matrix.

Expected coverage:

- M5-000 baseline verification recorded and green
- M1 baseline integration still passes
- M2 loop still passes
- M3 create/refine/workspace integration still passes
- M4 session lifecycle, PTY, output tail, restart, and WebSocket tests still pass
- contracts parse happy paths and reject invalid M5 wire shapes
- event payload contract tests reject unknown and forbidden content/text fields
- migration tests cover fresh DB, four tables, required indexes, FK behavior, memory dedupe, and active extraction idempotency
- projection tests cover insert/read/list/update for memory, decisions, summaries, and extractions
- manual memory API tests cover create/list/patch/promote/archive/error cases and content-free events
- manual decision API tests cover create/list/patch/confirm/archive/error cases and content-free events
- extraction state tests cover request/start/succeeded/failed, boot reconciliation, idempotency, and retry
- fake extractor commit tests cover atomic transaction boundaries, summary/memory/decision persistence, duplicate handling, and post-commit broadcasts
- input builder tests cover source selection, byte caps, most-recent-byte behavior, UTF-8 replacement, ANSI/control stripping, source offsets, and truncation flags
- deterministic extractor tests cover conservative summary/memory/decision candidates and false-positive guard cases
- refinement seed tests cover constraints/success criteria, auto-promotion, dedupe, and no generic import system
- runner tests cover serial processing, extractor failures, terminal hook enqueue, Goal-open enqueue, and restart reconciliation ordering
- endpoint tests cover `GET /v1/sessions/:sessionId/summary` and `POST /v1/sessions/:sessionId/extract-memory`
- daemon proof-loop integration proves terminal session tail -> extraction -> summary/memory/decision -> restart durability
- desktop API wrapper tests cover new M5 endpoints
- desktop component tests cover memory panel, decisions panel, session badges, summary display, manual retry, event-driven refetch, cross-Goal event ignore, and reconnect refetch
- `pnpm -r typecheck` passes
- `pnpm -r test` passes
- manual desktop smoke is recorded if claimed as part of shippability

Flag missing tests that create real regression risk. Do not demand tests for deferred systems such as context assembly, prompt injection, task graphs, recommendations, workflow engines, provider/model behavior, workspace indexing, file watching, embeddings, vector search, transcript replay, or cross-Goal search.

## Definition Of Done Cross-Check

Check `docs/milestones/5.md` section 17 line by line:

1. A terminal M4 session can produce a persisted `session_summary` plus zero-or-more memory items and decisions from bounded metadata and capped output tail.
2. Opening a Goal with eligible terminal sessions enqueues extraction without full transcripts or workspace scanning.
3. Terminal-state transitions enqueue extraction after the M4 event commit without destabilizing the PTY runtime.
4. Extractor output is zod-validated, normalized, capped, and best-effort redacted before persistence.
5. Extraction success/failure updates `memory_extractions` and domain events atomically with projection rows.
6. Broadcasts happen only after commit.
7. Retry is explicit and does not duplicate live memory items for the same content.
8. Boot reconciliation marks stale `pending`/`running` extractions failed and keeps already-committed memory visible.
9. Goal-scoped memory and decisions survive daemon restart.
10. Goal detail shows memory, decisions, session summary, extraction status including failed/retry/truncated/output-unavailable cases.
11. Users can create, edit, promote, and archive memory through the minimal API.
12. Users can create, edit, confirm, and archive decisions through the minimal API.
13. Automatic promotion is limited to deterministic low-risk rules.
14. High-impact or uncertain decisions remain proposed and user-confirmable.
15. M3 refinement fields seed Goal memory without a generalized import system.
16. Events are small and content-free.
17. No context assembly, prompt injection, recommendations, tasks, workflows, cross-Goal memory, embeddings, vector search, provider configuration, generic skill invocation API, or autonomous execution has been introduced.

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

- M1/M2/M3/M4 regression safety
- privacy and content-free event guarantees
- event/transaction correctness
- extraction lifecycle correctness
- retry/idempotency behavior
- restart reconciliation and durability
- daemon-owned state boundaries
- Goal scoping and SQLite storage boundaries
- M4 terminal output isolation
- future memory/context architecture
- future plugin/extractor architecture
- desktop cleanup, reconnect, and refetch correctness

If no findings are discovered, state that explicitly and list any residual risks or testing gaps.

Do not rewrite the implementation during the review. Produce a review report focused on defects, drift, missing validation, privacy risks, and targeted remediation.
