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
the Milestone 5 architecture, implementation plan, and final validation notes
the Milestone 6 architecture and execution plan: `docs/milestones/6.md`

Your task is NOT to redesign the system.

Your task is to:

tighten, simplify, and operationalize Milestone 6 execution.

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
memory/decision-aware from Milestone 5
optimized for orchestration and token efficiency

The long-term vision is large, but:

Milestone 6 must remain aggressively MVP-focused.

Milestone 6 is:

Context Assembly

The intended proof point is:

```text
User starts a new Goal session for a selected adapter and role
  -> daemon gathers bounded Goal, refinement, workspace, memory, decision, and sibling-session summary inputs
  -> daemon runs a session preparation skill/job through an explicit internal boundary
  -> preparation produces a compact role-aware context package
  -> daemon validates, caps, redacts, and persists context package metadata and rendered context atomically
  -> daemon records context assembly lifecycle events without large payloads
  -> desktop shows context preview/status before or during session creation
  -> adapter startup receives compact context through an adapter-safe path
  -> the new session begins as a normal M4-managed PTY session with useful Goal context
  -> context package metadata survives daemon restart
```

Milestone 6 should build on the M1-M5 operational loop:

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

M6 adds one new product foundation:

durable, bounded, Goal-scoped context packages that prepare new sessions with selected existing evidence.

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
AI/model integration that is premature before deterministic context assembly is proven
context abstractions that are not needed before recommendations exist
role abstractions that are too broad for MVP session startup
adapter abstractions that are broader than the supported M4 adapters require
source-selection infrastructure that is too broad for one Goal-scoped product loop
UI complexity that is not needed for session-start context preview and status

Explain WHY each item is premature.

Pay special attention to:

generic skill invocation APIs
generic context-builder APIs
generic prompt injection frameworks
provider/model SDK integration
provider configuration UI
prompt-management frameworks
prompt template libraries
background queue systems
worker pools
schedulers
workflow engines
recommendation engines
task graph systems
agent coordination systems
automatic session launching
continuous daemon reasoning loops
context scoring engines
semantic memory ranking
memory consolidation engines
cross-Goal memory
workspace indexing or file watching
knowledge graphs
embedding/vector databases
semantic search
conflict-detection systems
full transcript processing
transcript replay or analytics
storing raw prompts, raw model responses, or raw terminal output in the event store
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
places where M5 memory, decisions, and summaries are sufficient without semantic search
places where M3 Goal refinement fields and workspace metadata are sufficient without workspace scanning
places where source attribution can be compact instead of copying source text
places where manual preview/regenerate controls can replace complex context-ranking UI
places where adapter-specific code is clearer than a generic prompt-delivery framework

For each simplification, explain:

why it improves MVP velocity
why it does not damage future M7/Level 4/Level 5 architecture
which future milestone should own the deferred complexity, if relevant

3. Execution Risks

Identify:

highest-risk implementation areas
likely integration problems
context quality risks
unsupported or stale context risks
AI/provider dependency risks, if the plan includes them
token/cost/latency risks
source-attribution risks
duplicate/regenerated context risks
context idempotency risks
confirmation-required decision risks
adapter startup and prompt delivery risks
context leaking through process args, env vars, shell history, logs, or events
SQLite migration and transaction pitfalls
event-system risks
daemon restart/reconciliation risks
desktop state and live-refresh risks
M1/M2/M3/M4/M5 regression risks
database growth risks
event payload growth risks

For each risk:

explain impact
recommend mitigation

Pay special attention to:

assembling context only from bounded Goal/refinement/workspace metadata and M5 memory/decision/session-summary projections
not requiring full transcripts
not reading raw M4 output tails during M6 context assembly unless the plan proves a concrete need
not persisting raw prompts or raw model responses in the general event store
not writing rendered context or large source text as domain event payloads
validating assembler input/output with zod before persistence
idempotency by Goal/session objective/role/adapter/source fingerprint/assembler version
duplicate prevention across regenerate/retry behavior
clear context assembly lifecycle states
boot reconciliation for pending/running context assembly jobs
source references that remain useful without copying all source content
secret redaction before context persistence and adapter delivery where feasible
including confirmation-required decisions carefully
events and projection rows committed in the same transaction
broadcasting only after commit
manual retry/regenerate behavior that does not create confusing duplicate packages
desktop behavior for assembly failed, pending, running, completed, sparse-source, and truncated-context states

4. Milestone Boundary Violations

Find anything that accidentally drifts toward:

Milestone 7 recommendations
task/work-unit generation
validation recommendation
conflict detection
Level 4 supervised execution
Level 5 autonomy
cloud infrastructure
enterprise governance
distributed systems
advanced plugin ecosystems
generic skill execution
workflow engines
agent coordination systems
automatic session launch/approval
workspace indexing or file watching
AI-backed continuous reasoning loops
multi-agent automation
cross-Goal knowledge systems
embedding/vector infrastructure
provider/model configuration
prompt experimentation platforms

Clearly distinguish:

M6-required foundations
future-facing seams that are acceptable
future systems that must be deferred

5. Scope Review And Simplification

Review the proposed Milestone 6 scope and explicitly decide what should remain versus be deferred.

Evaluate specifically:

session preparation skill/job
role-aware context package generation
adapter-aware context delivery for shell/manual, Claude Code, opencode, and codex sessions
relevant Goal memory selection
relevant decision selection
confirmed versus proposed decision inclusion
confirmation-required decision handling
sibling session summaries
current Goal refinement fields
attached workspace metadata
lazy workspace/git inspection reuse from M3
session role selection
task objective or session objective input
context preview before session launch
context status display on created sessions
manual regenerate context action
retrying failed context assembly
context package persistence
context package event lifecycle
context package idempotency
context source attribution
context byte and token-equivalent budgets
deterministic context assembler versus AI-backed context assembler
provider configuration or model SDK integration
background queues / workers
prompt template libraries
user-editable context before launch
context diffing between regenerations
redaction / secret handling
prompt injection into new sessions
automatic session launch after context assembly
task/work-unit generation
recommendation generation
validation recommendation
conflict detection
workflow automation
cross-Goal memory
workspace indexing / file watching
full transcript processing
embedding search / vector database
memory ranking, aging, consolidation, or semantic relevance systems

Prefer the smallest product-complete M6 that satisfies the exit criteria.

6. Implementation Sequencing Improvements

Review the milestone task ordering in `docs/milestones/6.md`.

Suggest:

safer sequencing
earlier validation points
dependency simplifications
smaller executable increments
easier debugging paths
vertical slices that prove storage, assembly, events, adapter delivery, and UI behavior sooner

The revised order should make it easy to validate:

M1/M2/M3/M4/M5 baseline still works
contracts compile before daemon code depends on them
SQLite migration applies cleanly before projections use new tables
context package reads work before session creation writes them
context assembly state works before any assembler runs
the deterministic/fake assembler contract works before any AI-backed behavior is considered
bounded input assembly works before adapter delivery depends on it
memory and decision selection rules are explicit before context rendering depends on them
sibling session summaries are included without raw output access
idempotency and duplicate prevention work before retry/regenerate behavior ships
event persistence and projection updates happen atomically before WebSocket live refresh is added
adapter-specific delivery is tested before UI polish
restart reconciliation works before final UI polish
the desktop reads persisted context package state before adding live status controls

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
the existing M1-M5 operational loop

Do not propose new top-level packages unless there is a concrete Milestone 6 need.

Evaluate specifically:

`packages/contracts`
`apps/daemon/src/context`
`apps/daemon/src/sessions`
`apps/daemon/src/adapters`
`apps/daemon/src/skills`
`apps/daemon/src/server.ts`
`apps/desktop/src/goal-detail`
daemon tests
desktop tests
implementation notes

8. API Surface Reduction

Identify:

endpoints that can wait
endpoints that can be folded into existing Goal/session endpoints
abstractions that can remain internal
areas where direct use-case calls are acceptable temporarily
places where WebSocket/domain events are sufficient for live refresh
places where HTTP routes should be preferred over WebSocket commands

Evaluate the proposed M6 API surface specifically:

`POST /v1/goals/:goalId/context-packages`
`GET /v1/goals/:goalId/context-packages`
`GET /v1/context-packages/:id`
`POST /v1/context-packages/:id/regenerate`
`POST /v1/sessions` changes needed to attach or request context
`GET /v1/sessions/:sessionId/context`

Recommend the minimum public surface needed to prove:

Goal-scoped context package create/read/reload after restart
role/objective/adapter-aware context assembly
selected memory, decisions, summaries, refinements, and workspace metadata are represented in context
context preview before or during session creation
manual retry/regenerate, if retained
context delivery into new sessions
context UI refresh after committed events
clear failed-assembly behavior

Reject generic skill invocation, generic context-builder invocation, generic prompt injection, generic workflow execution, recommendation endpoints, task endpoints, conflict endpoints, embedding search endpoints, provider/model endpoints, or cross-Goal memory endpoints unless a concrete M6 need remains after simplification.

9. Event System Scope Reduction

Recommend the minimum viable event additions needed for:

context assembly request/start/completion/failure
context package creation/update
session/context association, if represented as an event
future recommendation compatibility
UI refresh after committed changes

Evaluate whether these events are sufficient:

`context.assembly.requested`
`context.assembly.started`
`context.assembly.completed`
`context.assembly.failed`
`context.package.created`
`context.package.updated`

Define what should NOT be added in M6, including:

raw terminal output events
rendered context payload events
source memory text events
prompt injection framework events
raw assembler input events
raw assembler response events
task events
recommendation events
workflow events
conflict events
cross-Goal memory events
embedding/indexing events
continuous reasoning events
agent coordination events

Avoid event-system overengineering.

10. Database And Persistence Simplification

Review the proposed SQLite additions.

Assess whether Milestone 6 can remain limited to:

`context_packages`
`context_assemblies`
minimal indexes required by Goal reads, session reads, source lookup, idempotent assembly, and runner pickup

Identify schema fields that are premature.

Reject tables for:

recommendations
tasks
workflows
conflicts
workspace indexing
workspace scans
cross-Goal memory
knowledge graphs
embeddings
vector indexes
provider configuration
prompt libraries
prompt experiments
memory ranking/relevance models
policy/governance systems

Confirm that persistence supports:

restart reload
Goal-scoped context package survival
session-to-context association survival
context assembly state reconciliation after daemon restart
idempotent retry/regenerate
source attribution to existing evidence
M1/M2/M3/M4/M5 create/list/refine/workspace/session/memory compatibility

11. Session Preparation Skill / Job Review

Review the proposed context assembly design specifically.

Recommend the smallest implementation that proves M6:

one daemon-local assembler interface
deterministic/fake assembler for tests
bounded input assembled from Goal, latest refinement, workspace metadata, memory, decisions, and session summaries
explicit byte/token-equivalent budgets
zod-validated output schema
role-aware sections
adapter-specific rendered text
normalization before persistence
idempotency key by Goal/objective/role/adapter/source fingerprint plus assembler version
retry/regenerate without external queue infrastructure
clear failed state with user-visible error
no raw prompt/response persistence unless deliberately redacted and bounded

Reject or defer:

model-provider SDK integration
provider configuration UI
prompt-management libraries
continuous daemon reasoning loops
background worker pools
distributed queues
multi-assembler pipelines
semantic memory ranking
embedding-based relevance
memory consolidation engines
confidence calibration systems
cross-Goal context
full transcript processing
automatic recommendation or task generation
automatic session launch or approval

12. Context Package Domain Review

Review the proposed context package model.

Assess whether M6 can stay limited to:

Goal-scoped context packages
session-associated context packages where a session has been created
simple role/objective fields
selected source ids and compact source metadata
bounded rendered context sections
clear lifecycle statuses
manual regenerate/retry controls only where they prove product value
source attribution to Goal refinement, memory, decisions, session summaries, workspaces, and sessions
simple retention/archive behavior

Reject or defer:

cross-Goal context
organizational memory
knowledge graph relationships
embedding search
conflict resolution
context ranking/relevance algorithms
memory aging/decay systems
prompt experimentation frameworks
policy/governance review systems
decision impact analysis engines
recommendation generation from context
task/work-unit generation from context

13. Adapter And Session Startup Review

Review the proposed adapter integration.

Assess whether M6 can keep adapter delivery explicit and safe:

shell/manual sessions may show or prefill context without hiding it from the user
Claude Code sessions receive context through the safest supported startup path
opencode sessions receive context through the safest supported startup path
codex sessions receive context through the safest supported startup path
context is not passed through process args or environment variables if that leaks secrets
context delivery failure has an explicit fallback
M4 PTY lifecycle, input, resize, output tail, and restart reconciliation remain intact
session creation remains user-driven

Reject or defer:

generic prompt injection framework
adapter marketplace routing
provider/model-specific prompt optimization
hidden autonomous startup actions
multi-agent coordination
automatic tool execution based on context

14. UI Scope Review

Review the proposed desktop changes.

Keep UI minimal but real.

Assess whether the UI can be limited to:

session role/objective controls in the existing Goal detail session creation flow
context preview before launch
context status on sessions
context source summary display
manual regenerate/retry action, if retained
empty/sparse-source/loading/error/truncated-context states
live refresh through existing event subscription/refetch behavior
existing M4 terminal behavior intact
existing M5 memory and decision panels intact

Reject or defer:

global context dashboard
cross-Goal search
knowledge graph UI
recommendations panel
task panel
workflow UI
command center
autonomy controls
prompt package editor
provider/model configuration UI
context analytics
complex filtering, ranking, or diffing
new routing or deep-linking unless already required by the app

15. MVP-Appropriate Recommendations

For every recommendation:

explain why it improves MVP velocity
explain why it does NOT damage future architecture
explain which future milestone should own the deferred complexity, if relevant

Prefer:

hardcoded over abstracted
internal over extensible
deterministic over intelligent
bounded sources over full transcripts
explicit source attribution over unsupported synthesis
SQLite projection reads over replay engines
in-process retry over queue systems
Goal-scoped context over global knowledge systems
simple status lifecycles over policy engines
manual controls over autonomous automation
explicit adapter paths over generic prompt frameworks

unless future architecture would be severely damaged.

16. Revised Milestone 6

At the end, produce:

a revised, simplified Milestone 6 plan (update the plan you reviewed)

Include:

revised scope
revised task order
revised architecture boundaries
revised API surface
revised event list
revised database surface
revised session preparation boundaries
revised context package domain boundaries
revised adapter/session startup boundaries
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
prove the context assembly loop
prepare cleanly for Milestone 7 recommendations without implementing recommendations
prepare cleanly for Level 4 supervised execution without implementing supervised execution

Most important instruction:

Optimize for proving the M6 product loop quickly.

Do not optimize for hypothetical future scale.

Do not let Context Assembly become the recommendation engine.

Do not let context become a task graph.

Do not let session preparation become continuous reasoning.

Do not let adapter delivery become a generic prompt-injection platform.

Do not let memory selection become semantic search or a knowledge graph.

Do not let sibling summaries become transcript analytics.

Do not let skills become a generic public invocation API.

Do not let retry/regenerate behavior become a queue system.

Do not let UI become a command center or autonomy dashboard.
