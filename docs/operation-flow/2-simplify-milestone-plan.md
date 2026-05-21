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
the Milestone 6 architecture, implementation plan, and final validation notes
the Milestone 7 architecture and execution plan: `docs/milestones/7.md`

Your task is NOT to redesign the system.

Your task is to:

tighten, simplify, and operationalize Milestone 7 execution.

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
context-package-aware from Milestone 6
optimized for orchestration and token efficiency

The long-term vision is large, but:

Milestone 7 must remain aggressively MVP-focused.

Milestone 7 is:

Suggested Orchestration

The intended proof point is:

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

Milestone 7 should build on the M1-M6 operational loop:

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

M7 adds one new product foundation:

durable, bounded, Goal-scoped suggested work and next actions derived from existing evidence.

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
AI/model integration that is premature before deterministic orchestration is proven
recommendation abstractions that are broader than the supported M7 proof requires
task/work-unit abstractions that drift into workflow execution
conflict detection abstractions that drift into semantic reasoning
feedback abstractions that pretend to learn before Level 4 exists
UI complexity that is not needed for Goal-scoped tasks, recommendations, and conflict review

Explain WHY each item is premature.

Pay special attention to:

generic reasoning-job APIs
generic workflow/action execution APIs
generic skill invocation APIs
provider/model SDK integration
provider configuration UI
prompt-management frameworks
prompt template libraries
background queue systems
worker pools
schedulers
workflow engines
approval-gate engines
agent coordination systems
automatic session launching
automatic validation execution
continuous daemon reasoning loops
recommendation scoring engines
recommendation ranking/aging/decay systems
analytics dashboards
task dependency graphs beyond the smallest useful model
multi-step workflow planning
semantic conflict detection
semantic memory ranking
memory consolidation engines
cross-Goal recommendations
cross-Goal memory
workspace indexing or file watching
knowledge graphs
embedding/vector databases
semantic search
full transcript processing
transcript replay or analytics
storing raw prompts, raw model responses, recommendation bodies, conflict bodies, or terminal output in the event store
policy/governance systems
autonomous execution features

2. Simplification Opportunities

Identify:

simpler implementations
reduced architecture surface area
shortcuts that preserve future evolution
places where deterministic rules are enough
places where AI reasoning is unnecessary
opportunities to reduce operational complexity
places where a daemon-local module is enough
places where an in-process runner is enough
places where explicit retry is enough without a queue
places where SQLite projection reads are sufficient
places where M3 Goal refinement, M4 sessions, M5 memory/decisions/summaries, and M6 context packages are sufficient without semantic search
places where source attribution can be compact instead of copying source text
places where simple trigger maps can replace continuous planning
places where manual regenerate/re-evaluate controls can replace complex scheduler behavior
places where accepted recommendations can prefill existing flows instead of executing generic actions
places where simple panels on Goal detail are enough instead of a command center

For each simplification, explain:

why it improves MVP velocity
why it does not damage future Level 4/Level 5 architecture
which future milestone should own the deferred complexity, if relevant

3. Execution Risks

Identify:

highest-risk implementation areas
likely integration problems
recommendation quality risks
task quality risks
conflict false-positive risks
unsupported or stale source risks
AI/provider dependency risks, if the plan includes them
token/cost/latency risks, if the plan includes model calls
source-attribution risks
duplicate/regenerated recommendation risks
idempotency and superseding risks
feedback lifecycle risks
accepted-recommendation routing risks
validation recommendation risks
context package reuse/request risks
SQLite migration and transaction pitfalls
event-system risks
daemon restart/reconciliation risks
desktop state and live-refresh risks
M1/M2/M3/M4/M5/M6 regression risks
database growth risks
event payload growth risks

For each risk:

explain impact
recommend mitigation

Pay special attention to:

generating suggestions only from bounded Goal/refinement/workspace/session/memory/decision/summary/context-package projections
not requiring full transcripts
not reading raw M4 output tails during M7 orchestration unless the plan proves a concrete need
not persisting raw prompts, raw model responses, raw reasoning, recommendation bodies, conflict bodies, task descriptions, or large source text in the event store
validating generator input/output with zod before persistence
idempotency by Goal, trigger, proposed action, source fingerprint, provider version, and active row state
superseding stale recommendations without deleting audit history
duplicate prevention across retry/regenerate/re-evaluate behavior
clear task, recommendation, conflict, feedback, and generation lifecycle states
boot reconciliation for pending/running generation jobs
source references that remain useful without copying all source content
secret redaction before persistence and UI display where feasible
including confirmation-required decisions carefully
events and projection rows committed in the same transaction
broadcasting only after commit
manual retry/re-evaluate behavior that does not create confusing duplicate suggestions
desktop behavior for empty, pending, running, completed, failed, superseded, accepted, rejected, dismissed, conflict-resolved, source-archived, and sparse-source states

4. Milestone Boundary Violations

Find anything that accidentally drifts toward:

Level 4 supervised workflow execution
Level 5 autonomy
approval gates
workflow engines
autonomous session launch
automatic validation command execution
multi-agent scheduling
agent task assignment
automatic task execution
continuous background planning
cloud infrastructure
enterprise governance
distributed systems
advanced plugin ecosystems
generic skill execution
generic reasoning endpoints
generic action execution endpoints
workspace indexing or file watching
AI-backed continuous reasoning loops
cross-Goal knowledge systems
embedding/vector infrastructure
provider/model configuration
prompt experimentation platforms
recommendation analytics
recommendation training or learning loops

Clearly distinguish:

M7-required foundations
future-facing seams that are acceptable
future systems that must be deferred

5. Scope Review And Simplification

Review the proposed Milestone 7 scope and explicitly decide what should remain versus be deferred.

Evaluate specifically:

task/work-unit generation
initial task generation from Goal refinement
task creation from session summaries, memory, decisions, and context packages
task status model and lifecycle
task dependencies
task splitting and manual edits
associating tasks with sessions, workspaces, roles, context packages, memory, decisions, and recommendations
recommendation generation
recommendation types: `create_session`, `continue_session`, `review_output`, `refine_goal`, `split_task`, `run_validation`, `resolve_conflict`, `update_plan`, `ask_user`, `mark_complete`, `pause_work`
recommendations panel
recommendation detail drawer or expandable details
accept/reject/dismiss/modify feedback
supervision signal persistence
validation recommendation after implementation-like work
conservative conflict detection
conflict records and human resolution
conflict synthesis versus simple conflict rules
recommendation idempotency and superseding
recommendation deduplication
recommendation lifecycle state
recommendation source attribution
recommendation confidence
proposed action schema
integration with M3 Goal refinement
integration with M4 session creation
integration with M5 decision confirmation
integration with M6 context package preparation
accepted recommendation prefill behavior
automatic session launch after recommendation acceptance
automatic validation command execution
automatic task assignment to agents
multi-step workflow planning
background queues / workers
AI-backed recommendation provider
deterministic recommendation provider
provider/model SDK integration
prompt template libraries
user-editable task and recommendation text
recommendation history and analytics
recommendation ranking, scoring, aging, or decay
cross-Goal recommendations
workspace indexing / file watching
full transcript processing
embedding search / vector database
semantic conflict detection
advanced plan repair or autonomous replanning
Level 4 approval gates
Level 5 autonomous execution

Prefer the smallest product-complete M7 that satisfies the exit criteria.

6. Implementation Sequencing Improvements

Review the milestone task ordering in `docs/milestones/7.md`.

Suggest:

safer sequencing
earlier validation points
dependency simplifications
smaller executable increments
easier debugging paths
vertical slices that prove storage, generation, events, HTTP, UI, feedback, and restart behavior sooner

The revised order should make it easy to validate:

M1/M2/M3/M4/M5/M6 baseline still works
contracts compile before daemon code depends on them
SQLite migration applies cleanly before projections use new tables
empty task/recommendation/conflict reads work before generation writes them
generation lifecycle state works before any provider runs
the deterministic/fake provider contracts work before any AI-backed behavior is considered
bounded input assembly works before recommendation rendering depends on it
task generation rules are explicit before recommendation rules depend on tasks
recommendation proposed-action schemas are explicit before accept routes depend on them
conflict rules are conservative before conflict UI depends on them
idempotency, duplicate prevention, and superseding work before retry/re-evaluate behavior ships
event persistence and projection updates happen atomically before WebSocket live refresh is added
accepted recommendations route through existing M3/M4/M5/M6/M7 flows before UI polish
restart reconciliation works before final UI polish
the desktop reads persisted orchestration state before adding live status controls

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
the existing M1-M6 operational loop

Do not propose new top-level packages unless there is a concrete Milestone 7 need.

Evaluate specifically:

`packages/contracts`
`apps/daemon/src/tasks`
`apps/daemon/src/recommendations`
`apps/daemon/src/conflicts`
`apps/daemon/src/sessions`
`apps/daemon/src/context`
`apps/daemon/src/skills`
`apps/daemon/src/server.ts`
`apps/desktop/src/goal-detail`
daemon tests
desktop tests
implementation notes

8. API Surface Reduction

Identify:

endpoints that can wait
endpoints that can be folded into existing Goal/session/context endpoints
abstractions that can remain internal
areas where direct use-case calls are acceptable temporarily
places where WebSocket/domain events are sufficient for live refresh
places where HTTP routes should be preferred over WebSocket commands

Evaluate the proposed M7 API surface specifically:

`GET /v1/goals/:goalId/tasks`
`POST /v1/goals/:goalId/tasks`
`PATCH /v1/tasks/:id`
`POST /v1/tasks/:id/split`
`GET /v1/goals/:goalId/recommendations`
`POST /v1/goals/:goalId/recommendations/regenerate`
`POST /v1/recommendations/:id/accept`
`POST /v1/recommendations/:id/reject`
`POST /v1/recommendations/:id/dismiss`
`POST /v1/recommendations/:id/modify`
`GET /v1/goals/:goalId/conflicts`
`POST /v1/conflicts/:id/resolve`
`POST /v1/conflicts/:id/dismiss`
`POST /v1/sessions` changes needed to attach task/recommendation provenance
`POST /v1/goals/:goalId/context-packages` changes needed to attach task/recommendation provenance

Recommend the minimum public surface needed to prove:

Goal-scoped tasks, recommendations, conflicts, and feedback create/read/reload after restart
deterministic generation from selected memory, decisions, summaries, refinements, sessions, workspaces, tasks, and context packages
recommendation accept/reject/dismiss/modify supervision
accepted recommendation prefill or direct routing into existing flows
manual retry/re-evaluate, if retained
validation recommendations after implementation-like activity
conservative conflict surfacing and human resolution
UI refresh after committed events
clear failed-generation behavior

Reject generic skill invocation, generic reasoning-job invocation, generic workflow execution, generic action execution, autonomous launch, approval-gate, embedding search, provider/model, analytics, or cross-Goal recommendation endpoints unless a concrete M7 need remains after simplification.

9. Event System Scope Reduction

Recommend the minimum viable event additions needed for:

task generation request/start/completion/failure
task creation/update/split/status changes
recommendation generation request/start/completion/failure
recommendation feedback: accepted, rejected, dismissed, modified
conflict detection request/start/completion/failure
conflict resolution/dismissal
session/context provenance association, if represented as an event
future Level 4 compatibility
UI refresh after committed changes

Evaluate whether these events are sufficient:

`task.generation.requested`
`task.generation.started`
`task.generation.completed`
`task.generation.failed`
`task.created`
`task.updated`
`task.split`
`recommendation.generation.requested`
`recommendation.generation.started`
`recommendation.generation.completed`
`recommendation.generation.failed`
`recommendation.accepted`
`recommendation.rejected`
`recommendation.dismissed`
`recommendation.modified`
`conflict.detection.requested`
`conflict.detection.started`
`conflict.detection.completed`
`conflict.detection.failed`
`conflict.resolved`
`conflict.dismissed`

Define what should NOT be added in M7, including:

raw terminal output events
rendered context payload events
recommendation body payload events
task description payload events
conflict body payload events
source memory text events
raw provider input events
raw provider response events
raw model reasoning events
workflow events
approval-gate events
autonomous-run events
cross-Goal recommendation events
embedding/indexing events
continuous reasoning events
agent coordination events
analytics events

Avoid event-system overengineering.

10. Database And Persistence Simplification

Review the proposed SQLite additions.

Assess whether Milestone 7 can remain limited to:

`tasks`
`task_generations`
`recommendations`
`recommendation_generations`
`recommendation_feedback`
`conflicts`
minimal column adds for session/context package provenance
minimal indexes required by Goal reads, status reads, source lookup, idempotent generation, superseding, and runner pickup

Identify schema fields that are premature.

Reject tables for:

workflows
approval gates
autonomous runs
workspace indexing
workspace scans
cross-Goal memory
cross-Goal recommendations
knowledge graphs
embeddings
vector indexes
provider configuration
prompt libraries
prompt experiments
recommendation analytics
recommendation ranking/relevance models
policy/governance systems
source reverse-index tables unless the plan proves M7 needs them

Confirm that persistence supports:

restart reload
Goal-scoped task/recommendation/conflict survival
accepted/rejected/dismissed/modified feedback survival
session-to-task/recommendation association survival
context-package-to-task/recommendation association survival
generation state reconciliation after daemon restart
idempotent retry/re-evaluate
superseding stale suggestions
source attribution to existing evidence
M1/M2/M3/M4/M5/M6 create/list/refine/workspace/session/memory/context compatibility

11. Provider / Generator Review

Review the proposed task, recommendation, and conflict generation design specifically.

Recommend the smallest implementation that proves M7:

one daemon-local generation boundary per domain or one small shared runner if it reduces duplication
deterministic production providers
fake providers for tests
bounded input assembled from Goal, latest refinement, workspace metadata, tasks, sessions, memory, decisions, summaries, and context packages
explicit byte/token-equivalent budgets where rendered text is involved
zod-validated output schemas
source-attributed output
normalization before persistence
idempotency keys by Goal/trigger/source fingerprint/proposed action/provider version
superseding without deleting audit history
retry/re-evaluate without external queue infrastructure
clear failed state with user-visible error
no raw prompt/response persistence unless deliberately redacted and bounded

Reject or defer:

model-provider SDK integration
provider configuration UI
prompt-management libraries
continuous daemon reasoning loops
background worker pools
distributed queues
multi-provider pipelines
semantic memory ranking
embedding-based relevance
memory consolidation engines
confidence calibration systems
cross-Goal recommendations
full transcript processing
automatic workflow planning
automatic session launch or approval
automatic validation command execution

12. Task / Work Unit Domain Review

Review the proposed task model.

Assess whether M7 can stay limited to:

Goal-scoped tasks
single-session-sized work units
simple status lifecycle
manual edits
manual split where it directly supports the proof
source attribution to Goal refinement, memory, decisions, session summaries, sessions, context packages, and recommendations
optional role/workspace/adapter hints
optional association to sessions and context packages
no automatic status transitions from daemon inference
simple retention/archive behavior

Reject or defer:

full dependency graph
workflow DAGs
task assignment to agents
capacity planning
automatic execution
automatic validation
global backlog
cross-Goal tasks
analytics
ranking/relevance systems
policy/governance review systems

13. Recommendation Domain Review

Review the proposed recommendation model.

Assess whether M7 can stay limited to:

Goal-scoped recommendations
bounded type set
structured `proposedAction`
source attribution
simple status lifecycle
accept/reject/dismiss/modify feedback
direct mapping from accepted actions into existing flows
confidence as metadata only
manual regenerate/re-evaluate controls only where they prove product value
no generic `execute(action)` endpoint

Reject or defer:

generic action execution
multi-step plan execution
approval-gate engine
autonomous session launch
automatic validation command execution
learning from feedback
recommendation ranking, aging, or decay
recommendation analytics
cross-Goal recommendations
provider/model configuration
prompt experimentation frameworks

14. Conflict Domain Review

Review the proposed conflict detection model.

Assess whether M7 can keep conflict detection conservative:

detect only deterministic, source-attributed conflicts
prefer false negatives over false positives
store human-readable conflict rows with compact source references
support resolve/dismiss feedback
auto-dismiss only when the exact conflict is no longer applicable and the rule is deterministic
keep conflict detection Goal-scoped

Reject or defer:

semantic conflict detection
cross-Goal conflict detection
policy/governance conflicts
AI synthesis of conflicts without deterministic evidence
automatic resolution
complex impact analysis
knowledge graphs

15. Accepted Action Routing Review

Review how accepted recommendations integrate with existing flows.

Assess whether M7 can keep routing explicit:

`create_session` preloads the existing M4 session creation flow
`continue_session` preloads the existing M4 session creation flow with session/task context
`run_validation` preloads the existing M4 flow with a validation objective but does not run commands
`refine_goal` preloads the existing M3 refinement flow
`ask_user` opens the existing M5 decision-confirmation flow
`update_plan` opens the M7 task edit flow
`split_task` calls the M7 split task endpoint only after user confirmation
`mark_complete` calls the M7 task status endpoint only after user confirmation
`resolve_conflict` opens the M7 conflict resolution flow
`pause_work` records acceptance only

Reject or defer:

generic execution engine
generic workflow runner
generic action dispatcher with hidden behavior
automatic adapter launch
automatic command execution
automatic approval
automatic task state changes without a user action

16. UI Scope Review

Review the proposed desktop changes.

Keep UI minimal but real.

Assess whether the UI can be limited to:

Goal detail task/work panel
Goal detail recommendations panel
Goal detail conflicts banner or compact panel
task create/edit/split/status controls
recommendation accept/reject/dismiss/modify controls
accepted recommendation routing into existing flows
conflict resolve/dismiss controls
empty/loading/error/superseded/source-archived states
live refresh through existing event subscription/refetch behavior
existing M4 terminal behavior intact
existing M5 memory and decision panels intact
existing M6 context preview/status behavior intact

Reject or defer:

global command center
workflow builder
autonomy dashboard
approval dashboard
cross-Goal recommendations view
global task backlog
analytics dashboard
provider/model configuration UI
prompt editor
recommendation scoring/ranking UI
complex filtering or search
new routing or deep-linking unless already required by the app

17. MVP-Appropriate Recommendations

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
Goal-scoped suggestions over global knowledge systems
simple lifecycle states over policy engines
manual controls over autonomous automation
explicit accepted-action routing over generic execution frameworks

unless future architecture would be severely damaged.

18. Revised Milestone 7

At the end, produce:

a revised, simplified Milestone 7 plan (update the plan you reviewed)

Include:

revised scope
revised task order
revised architecture boundaries
revised API surface
revised event list
revised database surface
revised provider/generator boundaries
revised task/work-unit domain boundaries
revised recommendation domain boundaries
revised conflict domain boundaries
revised accepted-action routing boundaries
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
prove the suggested-orchestration loop
consume Milestone 5 memory/decisions/summaries without becoming semantic memory
consume Milestone 6 context packages without becoming context assembly
prepare cleanly for Level 4 supervised execution without implementing supervised execution
prepare cleanly for Level 5 autonomy without implementing autonomy

Most important instruction:

Optimize for proving the M7 product loop quickly.

Do not optimize for hypothetical future scale.

Do not let Suggested Orchestration become supervised execution.

Do not let recommendations become workflow execution.

Do not let tasks become an autonomous work scheduler.

Do not let accepted actions become automatic session launch or command execution.

Do not let validation recommendations run validation commands automatically.

Do not let conflict detection become semantic governance.

Do not let recommendation generation become continuous reasoning.

Do not let provider boundaries become provider/model configuration.

Do not let source selection become semantic search or a knowledge graph.

Do not let feedback persistence pretend to be learning.

Do not let UI become a command center or autonomy dashboard.
