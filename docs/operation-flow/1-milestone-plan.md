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
Milestone 4 implementation plan

Your task is NOT to immediately generate code.

Your task is to produce:

an implementation architecture and milestone execution plan for Milestone 5 of the MVP.

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

## Milestone 5 — Shared Memory

Build:

- session summary extraction
- memory extraction
- decision extraction
- automatic memory promotion
- memory and decisions views

Exit criteria:

- completed session creates useful Goal memory automatically

Milestone 5 builds on:

- Milestone 1: local Tauri app, Node daemon, SQLite, event store, Goal projection, Goal CRUD, live events
- Milestone 2: internal plugin registry, internal skill registry, default skill provider, Quick Goal skill, `skill.invoked` event, read-only plugin/skill diagnostics, adapter-capable plugin metadata
- Milestone 3: deterministic Goal refinement, Goal detail bundle, canonical workspace attachments, lazy workspace/git inspection, workspace attach/remove events and projections
- Milestone 4: daemon-managed PTY sessions, shell/manual + Claude Code + opencode + codex adapters, session lifecycle events, capped session output tail, embedded terminal UI, restart reconciliation

The Milestone 5 plan should preserve the M1-M4 operational loop:

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

Milestone 5 should prove the next product loop:

```text
User opens a Goal with completed or stopped sessions
  -> daemon detects a session is eligible for extraction
  -> daemon reads bounded session metadata and persisted output tail
  -> a memory extraction skill/job produces structured summary, memory candidates, and decision candidates
  -> daemon validates and normalizes extracted items
  -> daemon commits extraction state, Goal memory, decisions, and domain events atomically
  -> memory and decisions become visible in the Goal detail UI
  -> user can review, edit status, promote/archive items where appropriate
  -> extracted Goal memory survives daemon restart
  -> future milestones can use this memory for context assembly and recommendations
```

Keep Milestone 5 focused. It should not become the context assembly engine, prompt construction system, task graph, recommendation engine, workflow engine, supervised execution engine, autonomous launcher, cross-Goal knowledge graph, or enterprise governance layer.

The implementation document should include:

1. Milestone Purpose

Explain why this milestone exists and what architectural foundation it establishes beyond M1-M4.

The explanation should clarify:

- why shared Goal memory is the next foundation after embedded sessions
- why memory must be scoped to existing Goals and sourced from existing sessions / refinements
- why session output from M4 should be consumed carefully and boundedly
- why memory extraction should use explicit skill/job boundaries instead of constant daemon reasoning loops
- how M5 prepares for Milestone 6 context assembly without injecting context into sessions yet
- how M5 prepares for Milestone 7 recommendations without generating next-action recommendations yet
- which memory state must survive restart versus which extraction jobs can be retried or marked failed

2. Scope Review And Simplification

Review the natural interpretation of Milestone 5 and identify what should be included versus deferred.

Explicitly decide how MVP-appropriate the following are for M5:

- session summary extraction
- memory extraction
- decision extraction
- automatic memory promotion
- manual memory item creation
- manual decision creation
- memory and decision list/detail views
- edit/archive/promote/canonicalize controls
- extraction trigger on terminal session exit/stop/failure
- manual "extract now" action for a session
- retrying failed extractions
- backfilling M3 Goal refinement fields into initial Goal memory
- extracting from the capped M4 session output tail
- extracting from full transcripts, if no full transcript exists
- extraction status tracking
- extraction error handling
- extraction idempotency
- extraction confidence scores
- confirmation-required flags for high-impact decisions
- source attribution back to session/refinement/output offsets
- memory type taxonomy
- decision schema
- local deterministic extractor versus AI-backed extractor
- provider configuration or model SDK integration
- background queues / workers
- token budgeting and output truncation
- redaction / secret handling
- context package assembly
- prompt injection into new sessions
- sibling session awareness in new-session startup
- task/work-unit generation
- recommendation generation
- conflict detection
- workflow automation
- cross-Goal memory
- knowledge graph / embedding search / vector database

Prefer the smallest product-complete M5 that satisfies the exit criteria.

3. High-Level Runtime Architecture

Show how these pieces interact during Milestone 5:

- Tauri app
- React Goal detail / memory panel / decisions panel
- Node daemon
- existing HTTP/WebSocket API layer
- existing plugin and skill registries
- new memory extraction skill/job contract
- existing session domain/usecases
- existing session output store
- existing Goal refinement projection
- new memory domain/usecases
- new decision domain/usecases
- SQLite storage
- event system
- memory and decision projections
- future M6 context assembly consumers, as read-only future consumers only

Describe the key flows:

- backfill refined Goal fields into seed memory
- detect a session that is eligible for extraction
- run extraction from a completed/stopped session
- validate extractor output
- persist session summary, memory items, decisions, and lifecycle events
- promote routine extracted memory automatically
- mark high-impact or uncertain items as requiring confirmation
- show memory and decisions in Goal detail
- manually add memory or a decision
- edit, archive, promote, and mark canonical memory / decisions
- retry a failed extraction
- handle extraction skill failure
- handle missing or truncated session output
- handle daemon restart while extraction was pending or running

4. Repository Structure

Design the M5 repository changes on top of the existing M1-M4 monorepo.

Cover likely additions under:

- `packages/contracts`
- `apps/daemon/src/memory*`
- `apps/daemon/src/decisions*`
- `apps/daemon/src/extractions*` or equivalent
- `apps/daemon/src/skills*`
- `apps/daemon/src/sessions*`
- `apps/daemon/src/server.ts`
- `apps/desktop/src`
- daemon tests
- desktop tests or smoke coverage
- docs / implementation notes

Do not propose large package extraction unless there is a concrete M5 need.

5. Technology Decisions

Recommend M5-specific technology choices and explain why:

- whether the first extractor should be deterministic, AI-backed, or an interface with deterministic default
- whether to introduce an AI provider SDK in M5 or keep model calls behind an internal skill boundary for later
- how to read and truncate session output safely
- how to represent source attribution without storing full transcripts
- how to store summary text versus structured memory items
- how to model memory status, promotion, canonical state, and archive state
- how to model decisions as first-class records or specialized memory items
- how to ensure extraction idempotency
- how to handle extraction retries without a queue system
- how to avoid leaking secrets in persisted memory, decisions, events, and logs
- how to validate extractor JSON with zod
- how to keep token and byte budgets explicit
- how to test extraction behavior deterministically

Avoid adding heavy dependencies unless they materially reduce risk.

6. Runtime Lifecycle

Describe how M5 changes daemon and desktop lifecycle behavior.

Include:

- daemon boot migrations for memory, decisions, summaries, and extraction state
- boot reconciliation for extraction jobs that were pending/running during daemon shutdown
- when extraction triggers fire relative to session lifecycle events
- whether extraction runs synchronously in the HTTP request, after committed session events, or through a simple in-process job runner
- behavior when the desktop disconnects while extraction is running
- behavior when the daemon receives shutdown while extraction is running
- behavior on daemon restart with sessions already eligible for extraction
- how the UI handles extraction pending/running/failed/completed states
- how memory and decision changes are broadcast live
- what happens if session output was truncated or unavailable
- what happens if the selected Goal or Session was archived

7. Event System Design

Design the M5 event additions.

Include concrete event names and payload guidance for:

- `memory.extraction.requested`
- `memory.extraction.started`
- `memory.extraction.completed`
- `memory.extraction.failed`
- `memory.item.created`
- `memory.item.updated`
- `memory.item.promoted`
- `memory.item.canonicalized`
- `memory.item.archived`
- `decision.created`
- `decision.updated`
- `decision.confirmed`
- `decision.archived`
- any session-summary event, if included separately

Define:

- event interfaces
- event persistence rules
- event ordering rules
- which events update which projections
- which events are broadcast live
- which extraction internals should NOT become domain events
- payload size limits
- source references to sessions, refinements, and output chunks
- how extraction state changes remain idempotent and restart-safe

Keep the event design MVP-appropriate and append-only. Be explicit about why raw terminal output and large extraction prompts/responses do not belong in the general event store.

8. Database Design

Design the SQLite schema changes for M5.

Cover:

- `goal_memory_items` or equivalent
- `goal_decisions` or equivalent
- `session_summaries` or equivalent
- `memory_extractions` or equivalent extraction state table
- memory type, status, importance, confidence, source type, source id, timestamps
- decision title, decision text, reasoning, alternatives, tradeoffs, impact area, confidence, confirmation state
- source attribution to Goal refinement fields, session ids, and output byte offsets if useful
- indexes needed for Goal detail memory and decisions views
- migration strategy from the M1-M4 schema
- backfill strategy for M3 `goal_refinements` into initial memory
- retention and archive strategy

Avoid premature tables for context packages, recommendations, tasks, workflows, embeddings, vector indexes, cross-Goal memory, or knowledge graphs.

9. API Contract Design

Define the M5 API surface with concrete endpoint examples.

At minimum, evaluate:

- `GET /v1/goals/:goalId/memory`
- `POST /v1/goals/:goalId/memory`
- `PATCH /v1/memory/:id`
- `POST /v1/memory/:id/promote`
- `POST /v1/memory/:id/canonicalize`
- `POST /v1/memory/:id/archive`
- `GET /v1/goals/:goalId/decisions`
- `POST /v1/goals/:goalId/decisions`
- `PATCH /v1/decisions/:id`
- `POST /v1/decisions/:id/confirm`
- `POST /v1/decisions/:id/archive`
- `GET /v1/sessions/:sessionId/summary`
- `POST /v1/sessions/:sessionId/extract-memory`
- `GET /v1/sessions/:sessionId/extractions`
- WebSocket/domain event behavior for memory, decisions, summaries, and extraction states

For each endpoint/message, specify:

- request shape
- response shape
- validation behavior
- authorization behavior inherited from M1
- emitted events
- whether it is idempotent
- whether it is required for M5 or should be deferred

Do not introduce context assembly endpoints, recommendation endpoints, task endpoints, workflow endpoints, cross-Goal memory endpoints, embedding search endpoints, or generic skill invocation endpoints unless the plan demonstrates a concrete M5 need.

10. Extraction Skill / Job Design

Define the M5 extraction behavior.

Cover:

- extractor interface shape
- input data available to the extractor
- output schema for session summary, memory candidates, and decision candidates
- deterministic default extractor behavior, if chosen
- AI-backed extractor behavior, if chosen
- validation and normalization rules
- confidence and importance calculation
- confirmation-required rules
- automatic promotion rules
- duplicate detection / idempotency rules
- source attribution rules
- error handling and retry rules
- payload size and token-budget limits
- privacy rules for logs and persisted prompts/responses
- how extraction remains internal-first while preserving future plugin-first architecture

Keep extraction focused on converting existing Goal/session/refinement evidence into durable Goal memory. Do not build M6 context assembly or M7 recommendations in this milestone.

11. Memory And Decision Domain Design

Define how memory and decisions work in M5.

Include:

- domain model fields
- status lifecycle
- allowed type taxonomy
- manual creation behavior
- automatic extraction behavior
- automatic promotion behavior
- user confirmation behavior
- edit/archive behavior
- source attribution behavior
- ordering and grouping in Goal detail
- relationship between decisions and memory items
- relationship between session summaries and memory items
- behavior for archived Goals, archived sessions, or missing source sessions
- security/privacy considerations

Keep the domain focused on Goal-scoped shared memory. Do not build cross-Goal memory, graph traversal, semantic search, embeddings, or organizational learning.

12. UI Architecture

Define the M5 UI changes.

Cover:

- where memory and decisions appear in the existing Goal detail view
- memory list grouping and filtering
- decision list grouping and filtering
- session summary display
- extraction status on sessions
- manual "extract now" / retry action, if included
- manual memory item creation
- manual decision creation
- edit/archive/promote/canonicalize controls
- confirmation-required affordance for decisions
- empty, loading, failed, and truncated-output states
- live event refresh behavior
- keeping existing M4 session terminal behavior intact

Keep UI minimal but real. Avoid placeholder panels for context packages, tasks, recommendations, workflows, command center, global dashboards, or autonomy controls unless backed by M5 data.

13. Milestone Task Breakdown

Break Milestone 5 into sequential implementation tasks.

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

- baseline verification of M1-M4
- contract updates
- database migration
- memory/decision projection helpers
- extraction state model
- deterministic extraction skill/job contract
- refinement backfill into Goal memory
- session summary extraction
- memory extraction
- decision extraction
- automatic promotion rules
- manual memory and decision APIs
- extraction trigger / retry behavior
- Goal detail memory and decisions UI
- integration tests
- restart/reconciliation behavior tests
- documentation

14. Validation Strategy

Define how we validate:

- M1-M4 regression safety
- daemon startup after migration
- memory and decision contract parsing
- migration from existing DBs
- M3 refinement backfill
- session summary creation from M4 session output
- memory extraction from bounded output tail
- decision extraction from bounded output tail
- extraction idempotency and duplicate prevention
- automatic promotion rules
- manual memory create/edit/archive
- manual decision create/edit/confirm/archive
- event persistence and ordering
- projection correctness
- WebSocket/UI refresh behavior
- daemon restart behavior for pending/running extraction jobs
- extraction failure and retry behavior
- secret/output logging safeguards
- desktop Goal detail memory and decisions flow

Prefer deterministic tests using fixture session output and a fake extraction skill/job. Use AI/model-backed behavior only if it can be tested deterministically behind an interface.

15. Risks and Simplifications

Identify:

- biggest technical risks
- AI/provider dependency risks, if any
- token/cost/latency risks
- extraction quality risks
- hallucination and unsupported-memory risks
- source-attribution risks
- duplicate extraction risks
- privacy/security risks around terminal output and extracted memory
- database growth risks
- event payload growth risks
- daemon restart/recovery risks
- UI complexity risks
- overengineering traps to avoid
- things intentionally deferred

16. Definition of Done

Provide a precise "Milestone 5 complete" definition.

The definition should make clear that M5 is complete only when:

- completed or stopped M4 sessions can produce a bounded structured summary
- useful Goal memory is automatically created from eligible session output
- useful Goal decisions are automatically created when supported by session output
- routine extracted memory can be automatically promoted according to explicit rules
- high-impact or uncertain decisions can require user confirmation
- memory and decisions are visible in the Goal detail UI
- users can manually add/edit/archive memory and decisions, if included in scope
- extraction state survives daemon restart or is safely reconciled
- extraction failures are visible and retryable, if retry is included in scope
- M3 refinement fields are preserved and either backfilled into memory or explicitly deferred with rationale
- M1-M4 functionality still works
- no context assembly engine, prompt injection, recommendation engine, workflow engine, task graph, cross-Goal memory, embedding/vector system, or Level 4/5 automation has been introduced

Very important constraints:

Preserve plugin-first architecture
Preserve skill-first architecture
Preserve event-driven design
Build on the existing M1-M4 runtime instead of replacing it
Use M4 Sessions and capped output tails as the primary automatic extraction source
Use M3 Goal refinements as seed memory input where appropriate
Do NOT build cloud infrastructure
Do NOT build Level 4/5 autonomous systems yet
Do NOT build M6 context assembly in M5
Do NOT inject memory into new sessions in M5
Do NOT build task graph/recommendation systems in M5
Do NOT build workflow automation in M5
Do NOT build auto-launching sessions in M5
Do NOT build workspace indexing or file watching in M5
Do NOT build cross-Goal memory in M5
Do NOT add embeddings/vector search/knowledge graph infrastructure in M5
Do NOT add generic skill invocation endpoints in M5
Avoid premature microservices
Avoid overengineering
Favor clean boundaries over feature quantity
Favor deterministic systems over excessive AI reasoning
Favor bounded extraction over full transcript processing
Favor explicit source attribution over unsupported synthesis
Favor local-first behavior and explicit user control

Output the implementation plan as a professional engineering design document with clear sections, rationale, and implementation sequencing.
