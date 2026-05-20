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

Your task is NOT to immediately generate code.

Your task is to produce:

an implementation architecture and milestone execution plan for Milestone 6 of the MVP.

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
optimized for orchestration and token efficiency

The implementation plan must optimize for:

architectural correctness
clean boundaries
future extensibility
token efficiency
maintainability
operational simplicity
avoiding premature complexity
preserving future Milestone 7, Level 4, and Level 5 evolution

The implementation plan should NOT overengineer the MVP.

We are currently starting:

## Milestone 6 - Context Assembly

Build:

- session preparation skill
- relevant Goal memory injection
- sibling session summaries
- role-aware context package

Exit criteria:

- new session starts with useful, compact Goal context

Milestone 6 builds on:

- Milestone 1: local Tauri app, Node daemon, SQLite, event store, Goal projection, Goal CRUD, live events
- Milestone 2: internal plugin registry, internal skill registry, default skill provider, Quick Goal skill, `skill.invoked` event, read-only plugin/skill diagnostics, adapter-capable plugin metadata
- Milestone 3: deterministic Goal refinement, Goal detail bundle, canonical workspace attachments, lazy workspace/git inspection, workspace attach/remove events and projections
- Milestone 4: daemon-managed PTY sessions, shell/manual + Claude Code + opencode + codex adapters, session lifecycle events, capped session output tail, embedded terminal UI, restart reconciliation
- Milestone 5: durable Goal-scoped memory, decisions, session summaries, extraction lifecycle state, bounded extraction from M4 session output tails, memory/decision views, explicit review/edit/promote/archive/confirm controls

The Milestone 6 plan should preserve the M1-M5 operational loop:

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

Milestone 6 should prove the next product loop:

```text
User starts a new Goal session for a selected adapter and role
  -> daemon gathers bounded Goal, refinement, workspace, memory, decision, and sibling-session summary inputs
  -> daemon runs a session preparation skill/job through an explicit internal boundary
  -> the preparation job produces a compact role-aware context package
  -> daemon validates, caps, redacts, and persists context package metadata and rendered context atomically
  -> daemon records context assembly lifecycle events without storing raw terminal output or oversized payloads in the event store
  -> desktop shows the assembled context preview/status before or during session creation
  -> adapter startup receives the compact context as initial session instructions or prefilled input according to adapter capability
  -> the new session begins with useful Goal context and remains a normal M4-managed PTY session
  -> context package metadata survives daemon restart
  -> future milestones can use context packages for recommendations and supervised execution
```

Keep Milestone 6 focused. It should not become the recommendation engine, task graph, workflow engine, supervised execution engine, autonomous launcher, continuous reasoning loop, workspace indexer, cross-Goal knowledge system, embedding/vector system, provider configuration layer, prompt-management platform, or enterprise governance layer.

The implementation document should include:

1. Milestone Purpose

Explain why this milestone exists and what architectural foundation it establishes beyond M1-M5.

The explanation should clarify:

- why context assembly is the next foundation after shared Goal memory
- why context must be scoped to existing Goals, sessions, workspaces, memory, decisions, and summaries
- why M5 memory and decisions should be consumed selectively rather than dumped wholesale into every session
- why sibling-session summaries are useful context but raw transcripts and output tails are not session-start material
- why session preparation should use explicit skill/job boundaries instead of constant daemon reasoning loops
- how M6 prepares for Milestone 7 recommendations without generating recommendations yet
- how M6 prepares for Level 4 supervised execution without auto-launching or approving work
- which context package state must survive restart versus which assembly jobs can be retried or marked failed

2. Scope Review And Simplification

Review the natural interpretation of Milestone 6 and identify what should be included versus deferred.

Explicitly decide how MVP-appropriate the following are for M6:

- session preparation skill/job
- role-aware context package generation
- adapter-aware context delivery for shell/manual, Claude Code, opencode, and codex sessions
- relevant Goal memory selection
- relevant decision selection
- inclusion of confirmed versus proposed decisions
- inclusion of confirmation-required decisions
- sibling session summaries
- current Goal refinement fields
- attached workspace metadata
- lazy workspace/git inspection reuse from M3
- session role selection
- task objective or session objective input
- context preview before session launch
- context status display on created sessions
- manual regenerate context action
- retrying failed context assembly
- context package persistence
- context package event lifecycle
- context package idempotency
- context source attribution
- context byte and token-equivalent budgets
- deterministic context assembler versus AI-backed context assembler
- provider configuration or model SDK integration
- background queues / workers
- prompt template libraries
- user-editable context before launch
- context diffing between regenerations
- redaction / secret handling
- prompt injection into new sessions
- automatic session launch after context assembly
- task/work-unit generation
- recommendation generation
- validation recommendation
- conflict detection
- workflow automation
- cross-Goal memory
- workspace indexing / file watching
- full transcript processing
- embedding search / vector database
- memory ranking, aging, consolidation, or semantic relevance systems

Prefer the smallest product-complete M6 that satisfies the exit criteria.

3. High-Level Runtime Architecture

Show how these pieces interact during Milestone 6:

- Tauri app
- React Goal detail / session creation UI / context preview surface
- Node daemon
- existing HTTP/WebSocket API layer
- existing plugin and skill registries
- existing session adapter registry and M4 PTY/session usecases
- new session preparation skill/job contract
- existing Goal and Goal refinement projections
- existing workspace attachment and lazy inspection data
- existing M5 memory, decision, session summary, and extraction projections
- new context assembly domain/usecases
- SQLite storage
- event system
- context package projection
- future M7 recommendation consumers, as read-only future consumers only

Describe the key flows:

- assemble context when a user starts a new session
- gather bounded Goal/refinement/workspace inputs
- select relevant memory and decisions from M5 projections
- include sibling session summaries without loading raw output tails
- run a deterministic or fakeable session preparation job
- validate and cap assembled context
- persist context package rows and lifecycle events atomically
- deliver context to each supported adapter at session startup
- show context preview and status in the UI
- regenerate or retry context assembly
- handle preparation skill failure
- handle missing or sparse memory/decisions/summaries
- handle oversized context inputs and outputs
- handle daemon restart while context assembly was pending or running
- handle session creation if context assembly fails

4. Repository Structure

Design the M6 repository changes on top of the existing M1-M5 monorepo.

Cover likely additions under:

- `packages/contracts`
- `apps/daemon/src/context*` or equivalent
- `apps/daemon/src/sessions*`
- `apps/daemon/src/adapters*`
- `apps/daemon/src/skills*`
- `apps/daemon/src/server.ts`
- `apps/desktop/src`
- daemon tests
- desktop tests or smoke coverage
- docs / implementation notes

Do not propose large package extraction unless there is a concrete M6 need.

5. Technology Decisions

Recommend M6-specific technology choices and explain why:

- whether the first context assembler should be deterministic, AI-backed, or an interface with deterministic default
- whether to introduce an AI provider SDK in M6 or keep model calls behind an internal skill boundary for later
- how to select memory and decisions without semantic search or embeddings
- how to include sibling session summaries without reading full transcripts
- how to build adapter-specific startup context without fragmenting session behavior
- how to represent source attribution without copying all source content
- how to store rendered context versus metadata and selected source ids
- how to model context package lifecycle state
- how to ensure context assembly idempotency
- how to handle retries without a queue system
- how to avoid leaking secrets in persisted context, events, logs, and adapter startup text
- how to validate assembler input/output with zod
- how to keep byte and token-equivalent budgets explicit
- how to test context assembly behavior deterministically

Avoid adding heavy dependencies unless they materially reduce risk.

6. Runtime Lifecycle

Describe how M6 changes daemon and desktop lifecycle behavior.

Include:

- daemon boot migrations for context packages and assembly state
- boot reconciliation for context assembly jobs that were pending/running during daemon shutdown
- when context assembly triggers fire relative to session creation
- whether assembly runs synchronously in the session-create HTTP request, through a preflight endpoint, or through a simple in-process job runner
- whether users can start a session without context if assembly fails
- behavior when the desktop disconnects while context assembly is running
- behavior when the daemon receives shutdown while context assembly is running
- behavior on daemon restart with sessions that already have associated context packages
- how the UI handles assembly pending/running/failed/completed states
- how context package changes are broadcast live
- what happens if memory, decisions, summaries, or workspace metadata are missing
- what happens if the selected Goal, Workspace, or Session was archived

7. Event System Design

Design the M6 event additions.

Include concrete event names and payload guidance for:

- `context.assembly.requested`
- `context.assembly.started`
- `context.assembly.completed`
- `context.assembly.failed`
- `context.package.created`
- `context.package.updated`
- any session-start context attachment event, if included separately

Define:

- event interfaces
- event persistence rules
- event ordering rules
- which events update which projections
- which events are broadcast live
- which context internals should NOT become domain events
- payload size limits
- source references to Goals, refinements, memory items, decisions, session summaries, workspaces, and sessions
- how context assembly state remains idempotent and restart-safe

Keep the event design MVP-appropriate and append-only. Be explicit about why rendered context, raw terminal output, full prompts, full source memory text, and large assembler inputs/outputs do not belong in the general event store.

8. Database Design

Design the SQLite schema changes for M6.

Cover:

- `context_packages` or equivalent
- `context_assemblies` or equivalent assembly lifecycle table
- package goal id, session id if created, adapter id, role, objective, status, byte counts, source counts, timestamps
- rendered context storage versus compact selected-source references
- source attribution to memory item ids, decision ids, session summary ids, refinement ids, workspace ids, and Goal ids
- indexes needed for Goal detail reads, session reads, retry/idempotency, and runner pickup
- migration strategy from the M1-M5 schema
- retention and archive strategy

Avoid premature tables for recommendations, tasks, workflows, conflicts, embeddings, vector indexes, cross-Goal memory, provider prompts, prompt libraries, or agent policies.

9. API Contract Design

Define the M6 API surface with concrete endpoint examples.

At minimum, evaluate:

- `POST /v1/goals/:goalId/context-packages`
- `GET /v1/goals/:goalId/context-packages`
- `GET /v1/context-packages/:id`
- `POST /v1/context-packages/:id/regenerate`
- `POST /v1/sessions` changes needed to attach or request context
- `GET /v1/sessions/:sessionId/context`
- WebSocket/domain event behavior for context packages and assembly states

For each endpoint/message, specify:

- request shape
- response shape
- validation behavior
- authorization behavior inherited from M1
- emitted events
- whether it is idempotent
- whether it is required for M6 or should be deferred

Do not introduce recommendation endpoints, task endpoints, workflow endpoints, conflict endpoints, cross-Goal memory endpoints, embedding search endpoints, generic skill invocation endpoints, generic context-builder endpoints, provider/model configuration endpoints, or WebSocket commands unless the plan demonstrates a concrete M6 need.

10. Session Preparation Skill / Job Design

Define the M6 session preparation behavior.

Cover:

- assembler interface shape
- input data available to the assembler
- output schema for context package sections
- deterministic default assembler behavior, if chosen
- AI-backed assembler behavior, if chosen
- role-aware context sections
- adapter-specific rendering rules
- validation and normalization rules
- source selection rules
- source attribution rules
- duplicate and stale source handling
- confidence/importance use from M5, if any
- confirmation-required decision handling
- error handling and retry rules
- payload size and token-equivalent budget limits
- privacy rules for logs and persisted context
- how assembly remains internal-first while preserving future plugin-first architecture

Keep preparation focused on converting existing Goal evidence into compact startup context. Do not build M7 recommendations, task/work-unit generation, or Level 4 supervised execution in this milestone.

11. Context Package Domain Design

Define how context packages work in M6.

Include:

- domain model fields
- lifecycle statuses
- allowed role taxonomy, or why roles should remain a small string enum for now
- relationship between context package and session creation
- relationship between context package and M5 memory/decisions/session summaries
- relationship between context package and workspace metadata
- source attribution behavior
- rendered context section ordering
- byte/token-equivalent budget behavior
- regeneration behavior
- archive/retention behavior
- behavior for archived Goals, Workspaces, Sessions, memory, decisions, or summaries
- security/privacy considerations

Keep the domain focused on Goal-scoped session startup context. Do not build cross-Goal context, context search, semantic ranking, embeddings, prompt experimentation frameworks, or organizational learning.

12. Adapter And Session Startup Design

Define how M6 integrates context with M4 session adapters.

Cover:

- how shell/manual sessions receive context
- how Claude Code sessions receive context
- how opencode sessions receive context
- how codex sessions receive context
- what adapter capability metadata is needed, if any
- whether context is written as initial terminal input, startup args, temp file content, environment variable, or pre-session preview only
- how to avoid leaking secrets through process args, environment, shell history, logs, or events
- how context delivery failure affects session creation
- how context package id is associated with session id
- how session restart/reconciliation treats existing context packages
- how to keep M4 PTY streaming/input/resize behavior intact

Prefer simple, explicit adapter integration over a generic prompt-injection framework.

13. UI Architecture

Define the M6 UI changes.

Cover:

- where session role/objective/context controls appear in the existing Goal detail session creation flow
- context preview before launch
- context package status on sessions
- context source summary display
- regenerate/retry controls, if included
- handling no memory, no decisions, no summaries, or sparse Goal data
- handling oversized/truncated context
- handling failed assembly
- live event refresh behavior
- keeping existing M4 terminal behavior and M5 memory/decision panels intact

Keep UI minimal but real. Avoid placeholder panels for recommendations, tasks, workflows, command center, autonomy controls, global dashboards, context analytics, or provider/model settings unless backed by M6 data.

14. Milestone Task Breakdown

Break Milestone 6 into sequential implementation tasks.

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

- baseline verification of M1-M5
- contract updates
- database migration
- context package projection helpers
- context assembly lifecycle model
- deterministic session preparation job contract
- bounded input builder from Goal/refinement/workspace/memory/decision/session-summary sources
- memory and decision selection rules
- sibling session summary inclusion
- adapter-specific context rendering
- session creation integration
- context package APIs
- Goal detail session creation UI changes
- context preview/status UI
- integration tests
- restart/reconciliation behavior tests
- documentation

15. Validation Strategy

Define how we validate:

- M1-M5 regression safety
- daemon startup after migration
- context contract parsing
- migration from existing DBs
- context source selection from M5 memory and decisions
- sibling session summary inclusion
- exclusion of raw terminal output and full transcripts
- role-aware section rendering
- adapter-specific context delivery
- context package idempotency and duplicate prevention
- manual regenerate/retry behavior
- event persistence and ordering
- projection correctness
- WebSocket/UI refresh behavior
- daemon restart behavior for pending/running assembly jobs
- assembly failure and retry behavior
- secret/output logging safeguards
- desktop session-start context flow

Prefer deterministic tests using fixture memory, decisions, summaries, workspaces, and fake preparation jobs. Use AI/model-backed behavior only if it can be tested deterministically behind an interface.

16. Risks and Simplifications

Identify:

- biggest technical risks
- AI/provider dependency risks, if any
- token/cost/latency risks
- context quality risks
- unsupported or stale context risks
- source-attribution risks
- duplicate/regenerated context risks
- confirmation-required decision risks
- adapter startup and prompt delivery risks
- SQLite migration and transaction pitfalls
- event-system risks
- daemon restart/recovery risks
- privacy/security risks around memory, summaries, terminal output, and startup context
- logs accidentally containing rendered context, raw memory text, terminal output, prompts, or secrets
- database growth risks
- event payload growth risks
- desktop state and live-refresh risks
- M1/M2/M3/M4/M5 regression risks
- overengineering traps to avoid
- things intentionally deferred

17. Definition of Done

Provide a precise "Milestone 6 complete" definition.

The definition should make clear that M6 is complete only when:

- a new Goal session can be started with an associated compact context package
- context packages can include bounded Goal objective/refinement/workspace context
- context packages can include selected M5 memory and decisions
- context packages can include sibling session summaries without reading raw transcripts
- role-aware rendering is implemented for the supported MVP roles
- adapter startup receives context through explicit adapter-safe delivery paths
- context assembly state survives daemon restart or is safely reconciled
- context assembly failures are visible and retryable, if retry is included in scope
- context preview/status is visible in the desktop session creation or session detail flow
- source attribution is retained compactly
- rendered context and source selection are capped, validated, and redacted where feasible
- M1-M5 functionality still works
- no recommendations, task graph, workflow engine, supervised execution, auto-launching, cross-Goal memory, embedding/vector system, provider configuration, prompt-management platform, or Level 4/5 automation has been introduced

Very important constraints:

Preserve plugin-first architecture
Preserve skill-first architecture
Preserve event-driven design
Build on the existing M1-M5 runtime instead of replacing it
Use M5 memory, decisions, and session summaries as primary context sources
Use M3 Goal refinements and workspace attachments as bounded context sources where appropriate
Do NOT build recommendation generation in M6
Do NOT build task/work-unit generation in M6
Do NOT build workflow automation in M6
Do NOT build supervised execution in M6
Do NOT build autonomous session launching in M6
Do NOT build continuous reasoning loops in M6
Do NOT build workspace indexing or file watching in M6
Do NOT build cross-Goal memory or cross-Goal context in M6
Do NOT add embeddings/vector search/knowledge graph infrastructure in M6
Do NOT add provider/model configuration UI in M6
Do NOT add generic skill invocation endpoints in M6
Do NOT store raw terminal output, full transcripts, raw prompts, or raw model responses in the event store
Avoid premature microservices
Avoid overengineering
Favor clean boundaries over feature quantity
Favor deterministic systems over excessive AI reasoning
Favor bounded context over exhaustive context
Favor explicit source attribution over unsupported synthesis
Favor local-first behavior and explicit user control

Output the implementation plan as a professional engineering design document with clear sections, rationale, and implementation sequencing.
