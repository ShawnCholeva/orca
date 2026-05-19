You are acting as a principal engineer reviewing an MVP implementation plan for an AI orchestration platform.

I have attached:

the Product Brief
the Technical Design Document
the MVP Specification
the Level 4 and Level 5 specifications
the Milestone 1 implementation plan
the Milestone 2 implementation plan
the Milestone 3 implementation plan
the Milestone 4 implementation plan and final validation notes
the Milestone 5 architecture and execution plan: `docs/milestones/5.md`

Your task is NOT to redesign the system.

Your task is to:

tighten, simplify, and operationalize Milestone 5 execution.

The platform is:

local-first
Tauri v2 desktop app
Node.js/TypeScript daemon
event-driven
plugin-oriented
skill-oriented
Goal-scoped
Workspace-aware
PTY/session-based from Milestone 4
memory/reasoning-centric in this milestone
optimized for orchestration and token efficiency

The long-term vision is large, but:

Milestone 5 must remain aggressively MVP-focused.

Milestone 5 is:

Shared Memory

The intended proof point is:

```text
User opens a Goal with completed or stopped sessions
  -> daemon detects a session eligible for extraction
  -> daemon reads bounded session metadata and persisted output tail
  -> a memory extraction skill/job produces structured summary, memory candidates, and decision candidates
  -> daemon validates and normalizes extracted items
  -> daemon commits extraction state, Goal memory, decisions, and domain events atomically
  -> memory and decisions become visible in the Goal detail UI
  -> user can review, edit status, promote/archive items where appropriate
  -> extracted Goal memory survives daemon restart
```

Milestone 5 should build on the M1-M4 operational loop:

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

M5 adds one new product foundation:

durable Goal-scoped memory and decisions extracted from bounded existing evidence.

That makes the milestone strategically important, but it should still remain small.

Your review should identify:

1. Overengineering

Find:

abstractions introduced too early
unnecessary indirection
premature scalability
unnecessary flexibility
unnecessary infrastructure
things that can be hardcoded temporarily
systems that should remain internal-only for now
AI/model integration that is premature before deterministic extraction is proven
memory abstractions that are not needed before context assembly exists
decision abstractions that are not needed before recommendations or supervised execution exist
extraction infrastructure that is too broad for one Goal-scoped product loop
UI complexity that is not needed for Goal detail memory and decision review

Explain WHY each item is premature.

Pay special attention to:

generic skill invocation APIs
generic extraction engines
provider/model SDK integration
prompt-management frameworks
background queue systems
worker pools
schedulers
workflow engines
recommendation engines
task graph systems
context package assembly
prompt injection into new sessions
sibling-session awareness at session startup
cross-Goal memory
knowledge graphs
embedding/vector databases
semantic search
conflict-detection systems
memory consolidation engines
memory ranking/relevance systems
full transcript processing
transcript replay or analytics
storing raw extractor prompts/responses
provider configuration UI
policy/governance systems
autonomous execution features

2. Simplification Opportunities

Identify:

simpler implementations
reduced architecture surface area
shortcuts that preserve future evolution
places where deterministic logic is enough
places where AI reasoning is unnecessary
opportunities to reduce operational complexity
places where a daemon-local module is enough
places where an in-process job runner is enough
places where explicit retry is enough without a queue
places where SQLite projection reads are sufficient
places where bounded M4 output tails are sufficient
places where M3 Goal refinement fields can seed memory without a generalized import system
places where source attribution can be compact instead of transcript-scale
places where manual edit/archive/promote controls can replace complex ranking

For each simplification, explain:

why it improves MVP velocity
why it does not damage future M6/M7/Level 4 architecture
which future milestone should own the deferred complexity, if relevant

3. Execution Risks

Identify:

highest-risk implementation areas
likely integration problems
extraction quality risks
AI/provider dependency risks, if the plan includes them
token/cost/latency risks
hallucination and unsupported-memory risks
bounded-output/truncation risks
source-attribution risks
duplicate extraction and idempotency risks
automatic promotion risks
high-impact decision confirmation risks
SQLite migration and transaction pitfalls
event-system risks
daemon restart/reconciliation risks
session output privacy and secret leakage risks
logs accidentally containing terminal output, prompts, or extracted secrets
database growth risks
event payload growth risks
desktop state and live-refresh risks
M1/M2/M3/M4 regression risks

For each risk:

explain impact
recommend mitigation

Pay special attention to:

extracting only from bounded session metadata and capped output tail
not requiring full transcripts
not persisting raw prompts or full model responses in the general event store
not writing large summaries or output bytes as domain events
validating extractor JSON with zod before persistence
idempotency by session/source/extractor version
duplicate prevention across retries
clear extraction lifecycle states
boot reconciliation for pending/running extraction jobs
source references that remain useful without storing full transcripts
secret redaction before memory/decision persistence where feasible
automatic promotion only for routine, low-risk memory
confirmation-required state for high-impact or uncertain decisions
events and projection rows committed in the same transaction
broadcasting only after commit
manual retry behavior that does not duplicate memory
desktop behavior for extraction failed, pending, running, truncated, and unavailable-output states

4. Milestone Boundary Violations

Find anything that accidentally drifts toward:

Milestone 6 context assembly
Milestone 7 recommendations
Level 4 supervised execution
Level 5 autonomy
cloud infrastructure
enterprise governance
distributed systems
advanced plugin ecosystems
generic skill execution
workflow engines
agent coordination systems
task graphs
recommendation engines
workspace indexing or file watching
AI-backed continuous reasoning loops
multi-agent automation
cross-Goal knowledge systems
embedding/vector infrastructure

Clearly distinguish:

M5-required foundations
future-facing seams that are acceptable
future systems that must be deferred

5. Scope Review And Simplification

Review the proposed Milestone 5 scope and explicitly decide what should remain versus be deferred.

Evaluate specifically:

session summary extraction
memory extraction
decision extraction
automatic memory promotion
manual memory item creation
manual decision creation
memory list/detail views
decision list/detail views
edit/archive/promote/canonicalize controls
decision confirmation controls
extraction trigger on terminal session exit/stop/failure
manual "extract now" action for a session
retrying failed extractions
backfilling M3 Goal refinement fields into initial Goal memory
extracting from the capped M4 session output tail
extracting from full transcripts, if no full transcript exists
extraction status tracking
extraction error handling
extraction idempotency
extraction confidence scores
source attribution back to session/refinement/output offsets
memory type taxonomy
decision schema
local deterministic extractor versus AI-backed extractor
provider configuration or model SDK integration
background queues / workers
token budgeting and output truncation
redaction / secret handling
context package assembly
prompt injection into new sessions
sibling session awareness in new-session startup
task/work-unit generation
recommendation generation
conflict detection
workflow automation
cross-Goal memory
knowledge graph / embedding search / vector database

Prefer the smallest product-complete M5 that satisfies the exit criteria.

6. Implementation Sequencing Improvements

Review the milestone task ordering in `docs/milestones/5.md`.

Suggest:

safer sequencing
earlier validation points
dependency simplifications
smaller executable increments
easier debugging paths
vertical slices that prove storage, extraction, events, and UI behavior sooner

The revised order should make it easy to validate:

M1/M2/M3/M4 baseline still works
contracts compile before daemon code depends on them
SQLite migration applies cleanly before projections use new tables
Goal-scoped memory and decision reads work before extraction writes them
manual memory and decision APIs work before automatic extraction depends on them
the extraction state table works before any extractor runs
the deterministic/fake extractor contract works before any AI-backed behavior is considered
M3 refinement backfill works before session output extraction broadens input sources
session summary extraction works before memory and decision extraction depend on it
idempotency and duplicate prevention work before retry behavior ships
automatic promotion rules are explicit before UI exposes promoted/canonical states
event persistence and projection updates happen atomically before WebSocket live refresh is added
restart reconciliation works before final UI polish
the Goal detail UI reads persisted memory and decisions before adding live extraction controls

7. Repository Structure Review

Review the proposed repository structure.

Recommend:

simplifications
package reductions
fewer layers where appropriate
temporary MVP shortcuts
clearer test boundaries

while preserving:

clean boundaries
future extensibility
daemon-owned domain state
contract-driven HTTP responses
plugin-first direction
skill-first direction
the existing M1-M4 operational loop

Do not propose new top-level packages unless there is a concrete Milestone 5 need.

Evaluate specifically:

`packages/contracts`
`apps/daemon/src/memory`
`apps/daemon/src/decisions`
`apps/daemon/src/extractions`
`apps/daemon/src/skills`
`apps/daemon/src/sessions`
`apps/daemon/src/server.ts`
`apps/desktop/src/goal-detail`
daemon tests
desktop tests
implementation notes

8. API Surface Reduction

Identify:

endpoints that can wait
endpoints that can be folded into existing Goal detail bundle endpoints
abstractions that can remain internal
areas where direct use-case calls are acceptable temporarily
places where WebSocket/domain events are sufficient for live refresh
places where HTTP routes should be preferred over WebSocket commands

Evaluate the proposed M5 API surface specifically:

`GET /v1/goals/:goalId/memory`
`POST /v1/goals/:goalId/memory`
`PATCH /v1/memory/:id`
`POST /v1/memory/:id/promote`
`POST /v1/memory/:id/canonicalize`
`POST /v1/memory/:id/archive`
`GET /v1/goals/:goalId/decisions`
`POST /v1/goals/:goalId/decisions`
`PATCH /v1/decisions/:id`
`POST /v1/decisions/:id/confirm`
`POST /v1/decisions/:id/archive`
`GET /v1/sessions/:sessionId/summary`
`POST /v1/sessions/:sessionId/extract-memory`
`GET /v1/sessions/:sessionId/extractions`

Recommend the minimum public surface needed to prove:

Goal-scoped memory list/reload after restart
Goal-scoped decision list/reload after restart
manual memory creation/edit/archive, if retained
manual decision creation/edit/confirm/archive, if retained
session summary read
manual extraction trigger or retry, if retained
automatic extraction from completed/stopped sessions
memory/decision UI refresh after committed events
clear failed-extraction behavior

Reject generic skill invocation, generic extractor invocation, generic workflow execution, context assembly endpoints, recommendation endpoints, task endpoints, embedding search endpoints, or cross-Goal memory endpoints unless a concrete M5 need remains after simplification.

9. Event System Scope Reduction

Recommend the minimum viable event additions needed for:

extraction request/start/completion/failure
session summary creation/update, if represented as an event
memory item creation/update/promotion/canonicalization/archive
decision creation/update/confirmation/archive
future context assembly compatibility
UI refresh after committed changes

Evaluate whether these events are sufficient:

`memory.extraction.requested`
`memory.extraction.started`
`memory.extraction.completed`
`memory.extraction.failed`
`memory.item.created`
`memory.item.updated`
`memory.item.promoted`
`memory.item.canonicalized`
`memory.item.archived`
`decision.created`
`decision.updated`
`decision.confirmed`
`decision.archived`

Define what should NOT be added in M5, including:

raw terminal output events
extractor prompt events
extractor raw response events
context package events
prompt injection events
task events
recommendation events
workflow events
cross-Goal memory events
embedding/indexing events
continuous reasoning events
agent coordination events

Avoid event-system overengineering.

10. Database And Persistence Simplification

Review the proposed SQLite additions.

Assess whether Milestone 5 can remain limited to:

`goal_memory_items`
`goal_decisions`
`session_summaries`
`memory_extractions`
minimal indexes required by Goal detail reads, source lookup, and idempotent extraction

Identify schema fields that are premature.

Reject tables for:

context packages
prompt bundles
tasks
recommendations
workflows
workspace indexing
workspace scans
cross-Goal memory
knowledge graphs
embeddings
vector indexes
provider configuration
memory ranking/relevance models
policy/governance systems

Confirm that persistence supports:

restart reload
Goal-scoped memory survival
Goal-scoped decision survival
session summary survival
extraction state reconciliation after daemon restart
idempotent retry
source attribution to existing evidence
M1/M2/M3/M4 create/list/refine/workspace/session compatibility

11. Extraction Skill / Job Review

Review the proposed extraction design specifically.

Recommend the smallest implementation that proves M5:

one daemon-local extractor interface
deterministic/fake extractor for tests
bounded input assembled from Goal, refinement, session metadata, and capped output tail
explicit byte/token budgets
zod-validated output schema
session summary output
memory candidates output
decision candidates output
normalization before persistence
idempotency key by source session/refinement plus extractor version
retry without external queue infrastructure
clear failed state with user-visible error
no raw prompt/response persistence unless deliberately redacted and bounded

Reject or defer:

model-provider SDK integration
provider configuration UI
prompt-management libraries
continuous daemon reasoning loops
background worker pools
distributed queues
multi-extractor pipelines
semantic deduplication
embedding-based relevance
memory consolidation engines
confidence calibration systems
cross-Goal extraction
full transcript extraction
adapter-specific extraction
automatic context injection
recommendation or task generation

12. Memory And Decision Domain Review

Review the proposed memory and decision model.

Assess whether M5 can stay limited to:

Goal-scoped memory items
Goal-scoped decisions
routine automatic promotion for low-risk extracted memory
confirmation-required state for high-impact or uncertain decisions
manual edit/archive/promote/canonicalize controls only where they prove product value
source attribution to Goal refinement, session, summary, or bounded output range
simple type taxonomy
simple status lifecycle

Reject or defer:

cross-Goal memory
organizational memory
knowledge graph relationships
embedding search
conflict resolution
memory ranking/relevance algorithms
memory aging/decay systems
automatic canonicalization beyond explicit rules
policy/governance review systems
decision impact analysis engines
recommendation generation from memory
context package assembly from memory

13. UI Scope Review

Review the proposed desktop changes.

Keep UI minimal but real.

Assess whether the UI can be limited to:

Goal detail memory panel
Goal detail decisions panel
session summary display inside the existing sessions area
extraction status on eligible sessions
manual extract/retry action, if retained
memory list with simple status/type/source metadata
decision list with confirmation state
create/edit/archive/promote/canonicalize controls only where backed by M5 APIs
empty/loading/error/truncated-output states
live refresh through existing event subscription/refetch behavior

Reject or defer:

global memory dashboard
cross-Goal search
knowledge graph UI
recommendations panel
task panel
workflow UI
command center
autonomy controls
context package viewer
prompt package editor
provider/model configuration UI
complex filtering, ranking, or analytics
new routing or deep-linking unless already required by the app

14. MVP-Appropriate Recommendations

For every recommendation:

explain why it improves MVP velocity
explain why it does NOT damage future architecture
explain which future milestone should own the deferred complexity, if relevant

Prefer:

hardcoded over abstracted
internal over extensible
deterministic over intelligent
bounded evidence over full transcripts
explicit source attribution over unsupported synthesis
SQLite projection reads over replay engines
in-process retry over queue systems
Goal-scoped memory over global knowledge systems
simple status lifecycles over policy engines
manual controls over autonomous automation

unless future architecture would be severely damaged.

15. Revised Milestone 5

At the end, produce:

a revised, simplified Milestone 5 plan (update the plan you reviewed)

Include:

revised scope
revised task order
revised architecture boundaries
revised API surface
revised event list
revised database surface
revised extraction boundaries
revised memory/decision domain boundaries
revised UI scope
revised validation strategy
revised definition of done

The revised milestone should:

preserve the platform vision
preserve future extensibility
preserve clean architecture
dramatically improve implementation velocity
reduce unnecessary complexity
maximize learnings per engineering hour
prove the shared memory loop
prepare cleanly for Milestone 6 context assembly without implementing context assembly
prepare cleanly for Milestone 7 recommendations without implementing recommendations

Most important instruction:

Optimize for proving the M5 product loop quickly.

Do not optimize for hypothetical future scale.

Do not let Shared Memory become the context assembly engine.

Do not let extraction become a continuous reasoning system.

Do not let memory become a cross-Goal knowledge graph.

Do not let decisions become a recommendation engine.

Do not let summaries become transcript analytics.

Do not let skills become a generic public invocation API.

Do not let retry behavior become a queue system.

Do not let UI become a command center or autonomy dashboard.
