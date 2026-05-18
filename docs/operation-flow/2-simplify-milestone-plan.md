You are acting as a principal engineer reviewing an MVP implementation plan for an AI orchestration platform.

I have attached:

the Product Brief
the Technical Design Document
the MVP Specification
the Level 4 and Level 5 specifications
the Milestone 1 implementation plan
the Milestone 2 implementation plan
the Milestone 3 implementation plan and review
the Milestone 4 architecture and execution plan: `docs/milestones/4.md`

Your task is NOT to redesign the system.

Your task is to:

tighten, simplify, and operationalize Milestone 4 execution.

The platform is:

local-first
Tauri v2 desktop app
Node.js/TypeScript daemon
event-driven
plugin-oriented
skill-oriented
PTY/session-based in this milestone
Goal/memory/reasoning-centric

The long-term vision is large, but:

Milestone 4 must remain aggressively MVP-focused.

Milestone 4 is:

Embedded Sessions

The intended proof point is:

```text
User opens a refined Goal with attached workspaces
  -> creates a manual session
  -> chooses a workspace and an agent adapter
  -> optionally chooses a role / short instruction
  -> daemon validates the Goal, workspace, and adapter
  -> daemon records a session and lifecycle events
  -> daemon launches a PTY in the selected workspace
  -> adapter starts shell / Claude Code / opencode / codex in the PTY
  -> desktop renders an embedded terminal
  -> user interacts with the agent normally
  -> daemon captures output and lifecycle transitions
  -> UI shows active/completed session state
  -> session metadata and useful output history survive daemon restart
```

Milestone 4 should build on the M1-M3 operational loop:

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

M4 adds one new kind of runtime behavior: the daemon starts and manages local PTY processes.

That makes the milestone higher risk than M1-M3, but it should still remain small.

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
UI framework complexity that is not needed for a single embedded session surface
session abstractions that are not needed before memory/context/task systems exist
terminal abstractions that are not needed before a real product need appears

Explain WHY each item is premature.

Pay special attention to:

generic adapter/plugin invocation APIs
workflow engines for session creation
session orchestration beyond create/start/stop/archive
adapter hook systems
adapter-owned PTY behavior
adapter output transformers
per-workspace command environments
role catalogs
context package injection
memory extraction or summary stubs
task assignment, recommendations, or auto-launching
terminal multiplexing, panes, tabs, sharing, or replay engines
binary WebSocket protocol rewrites
custom terminal themes/keymaps/settings
process re-parenting across daemon restart
cross-Goal global session management
adapter configuration UI
cloud, remote execution, or distributed runtime assumptions

2. Simplification Opportunities

Identify:

simpler implementations
reduced architecture surface area
shortcuts that preserve future evolution
places where deterministic logic is enough
places where AI reasoning is unnecessary
opportunities to reduce operational complexity
places where the existing WebSocket channel is sufficient
places where projection reads are sufficient without replay utilities
places where a single daemon-local module is enough
places where hardcoded adapter defaults are better than configuration

For each simplification, explain:

why it improves MVP velocity
why it does not damage future M5/M6/Level 4 architecture
which future milestone should own the deferred complexity, if relevant

3. Execution Risks

Identify:

highest-risk implementation areas
likely integration problems
native dependency and packaging risks
PTY lifecycle risks
cross-platform shell risks
adapter command resolution risks
filesystem/cwd validation risks
WebSocket throughput and ordering risks
terminal UI risks
output persistence risks
SQLite migration and transaction pitfalls
event-system risks
Tauri desktop flow risks
M1/M2/M3 regression risks

For each risk:

explain impact
recommend mitigation

Pay special attention to:

`node-pty` native module installation and sidecar packaging
prebuilt availability for the supported target triples
daemon dev mode versus bundled sidecar behavior
ensuring only the PTY wrapper imports `node-pty`
ensuring session state updates and domain events happen in the same transaction
broadcasting only after commit
not persisting terminal input or resize events
not writing high-volume output into the general event store
output chunk ordering, sequence numbers, and duplicate replay handling
output retention caps and SQLite growth
secrets in persisted output and logs
base64 overhead on the existing JSON WebSocket channel
slow WebSocket consumers and backpressure policy
adapter command-not-found behavior
env-var override behavior for CLI paths
argv handling without shell quoting
shell fallback behavior on macOS/Linux/Windows
detached, archived, or removed workspaces
archived Goals
sessions that were running when the daemon exits
daemon boot reconciliation order before accepting HTTP/WebSocket traffic
SIGTERM to SIGKILL stop behavior
PTY exit versus explicit user stop race conditions
xterm mount/unmount cleanup
terminal resize loops
desktop reconnect or stale-subscription behavior

4. Milestone Boundary Violations

Find anything that accidentally drifts toward:

Milestone 5 shared memory
Milestone 6 context assembly
Level 4 supervised execution
Level 5 autonomy
cloud infrastructure
enterprise architecture
distributed systems
advanced plugin ecosystems
workflow engines
agent coordination systems
task graphs
recommendation engines
workspace indexing or file watching
AI-backed summaries or extraction
multi-agent automation

Clearly distinguish:

M4-required foundations
future-facing seams that are acceptable
future systems that must be deferred

5. Implementation Sequencing Improvements

Review the milestone task ordering in `docs/milestones/4.md`.

Suggest:

safer sequencing
earlier validation points
dependency simplifications
smaller executable increments
easier debugging paths
vertical slices that prove persistence, PTY behavior, and UI behavior sooner

The revised order should make it easy to validate:

M1/M2/M3 baseline still works
contracts compile before daemon code depends on them
`node-pty` can install, load, and spawn before broader session work begins
sidecar packaging feasibility is known early
migration applies cleanly before projections use new tables
adapter command resolution works before session start depends on it
the PTY wrapper works behind a fake interface before usecases depend on it
session create/list/detail works before PTY start is added
output persistence works before live WebSocket streaming depends on it
WebSocket subscription/input/resize works before desktop terminal integration
the shell/manual adapter proves the full loop before Claude Code/opencode/codex polish
restart reconciliation works before final UI polish

6. Repository Structure Review

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
adapter descriptors from the plugin registry
the existing M1-M3 operational loop

Do not propose new top-level packages unless there is a concrete Milestone 4 need.

Evaluate specifically:

`packages/contracts`
`apps/daemon/src/pty`
`apps/daemon/src/adapters`
`apps/daemon/src/sessions`
`apps/daemon/src/registry`
`apps/daemon/src/server.ts`
`apps/desktop/src/goal-detail/sessions`
`apps/desktop/src-tauri`
daemon tests
desktop tests
sidecar build scripts

7. API Surface Reduction

Identify:

endpoints that can wait
endpoints that can be folded into existing endpoints
abstractions that can remain internal
areas where direct use-case calls are acceptable temporarily
places where WebSocket messages should be preferred over HTTP routes
places where HTTP routes should be preferred over WebSocket messages

Evaluate the proposed M4 API surface specifically:

`GET /v1/adapters`
`POST /v1/goals/:id/sessions`
`GET /v1/goals/:id/sessions`
`GET /v1/sessions/:id`
`POST /v1/sessions/:id/start`
`POST /v1/sessions/:id/stop`
`POST /v1/sessions/:id/archive`

Evaluate the proposed WebSocket message surface specifically:

`session.subscribe`
`session.unsubscribe`
`session.input`
`session.resize`
`session.output`
`session.error`

Recommend the minimum public surface needed to prove:

manual session creation for a refined Goal
adapter selection
PTY launch in an attached workspace
interactive terminal input/output/resize
session stop
session list/detail reload after restart
persisted output tail replay after restart
clear command-not-found behavior

Reject generic adapter invocation or generic plugin execution unless a concrete M4 need remains after simplification.

8. Event System Scope Reduction

Recommend the minimum viable event additions needed for:

session creation
session start
session normal exit
session failure
explicit user stop
session archive, if archive remains in scope
future memory extraction compatibility
UI refresh after committed changes

Evaluate whether these events are sufficient:

`session.created`
`session.started`
`session.exited`
`session.failed`
`session.stopped`
`session.archived`

Define what should NOT be added in M4, including:

`session.output.received`
`session.input.sent`
`session.resized`
memory events
summary events
context events
task events
recommendation events
workspace refresh events
workspace scan/index events
adapter hook events
workflow events

Avoid event-system overengineering.

9. Database And Persistence Simplification

Review the proposed SQLite additions.

Assess whether Milestone 4 can remain limited to:

`sessions`
`session_output_chunks`
minimal indexes required by Goal-scoped list/detail reads and output replay

Identify schema fields that are premature.

Reject tables for:

memory
summaries
context bundles
tasks
recommendations
workflows
workspace indexing
workspace scans
adapter configuration
role catalogs
terminal panes/tabs

Confirm that persistence supports:

restart reload
session metadata survival
recent output tail survival
running-session reconciliation after daemon restart
session list/detail reads from projections
M1/M2/M3 create/list/restart compatibility

10. PTY And Terminal Review

Review PTY and embedded terminal behavior specifically.

Recommend the smallest implementation that proves M4:

`node-pty` behind one daemon-local wrapper
one PTY per session
one desktop terminal view per selected session
xterm.js with default behavior
terminal input over WebSocket only
terminal resize over WebSocket only
terminal output over WebSocket only
chunked output persistence with a retention cap
recent output replay through session detail
explicit stop with SIGTERM then SIGKILL
running sessions marked failed on daemon restart

Reject or defer:

terminal tabs
terminal panes
multi-viewer synchronization
process re-parenting
tmux/screen integration
custom terminal themes
custom keymaps
full transcript export
search inside terminal output
binary WebSocket migration
terminal command palettes
terminal session sharing

11. Adapter Review

Review the proposed shell/manual, Claude Code, opencode, and codex adapters.

Assess:

whether adapters should remain pure spawn factories
whether command resolution can be hardcoded plus env-var overrides
whether availability detection should remain lazy
whether adapter descriptors should stay internal-only
whether role and instruction should remain opaque strings
whether CLI-specific arguments should be avoided in M4
whether shell/manual should be the first full-loop validation target

Reject or defer:

adapter configuration UI
adapter marketplace loading
adapter hook systems
adapter-owned process management
adapter-owned streaming
adapter-specific output parsing
adapter-specific summaries
adapter-specific memory extraction
adapter-generated context injection
automatic prompt construction
model-provider SDK integration

12. UI Scope Review

Review the proposed desktop changes.

Keep UI minimal but real.

Assess whether the UI can be limited to:

Goal detail sessions panel
create session dialog
workspace selector using M3 attached workspaces
adapter selector using `GET /v1/adapters`
opaque role and instruction fields
session list with statuses
embedded xterm terminal view
stop/archive controls
inline command-not-found and unavailable-adapter errors
existing diagnostics preserved, with optional read-only adapter availability

Reject or defer:

global sessions dashboard
command center
memory panel
tasks panel
recommendations panel
workflow UI
URL deep-linking unless already present and necessary
terminal settings UI
adapter configuration UI
multi-pane/multi-tab terminal UI
complex state management beyond local reducer/hooks

13. MVP-Appropriate Recommendations

For every recommendation:

explain why it improves MVP velocity
explain why it does NOT damage future architecture
explain which future milestone should own the deferred complexity, if relevant

Prefer:

hardcoded over abstracted
internal over extensible
deterministic over intelligent
single-client over multi-client
projection reads over replay engines
JSON WebSocket frames over protocol rewrites
simple output retention over transcript systems
operational over theoretical

unless future architecture would be severely damaged.

14. Revised Milestone 4

At the end, produce:

a revised, simplified Milestone 4 plan (update the plan you reviewed)

Include:

revised scope
revised task order
revised architecture boundaries
revised API surface
revised WebSocket surface
revised event list
revised database surface
revised PTY/adapter boundaries
revised validation strategy
revised definition of done

The revised milestone should:

preserve the platform vision
preserve future extensibility
preserve clean architecture
dramatically improve implementation velocity
reduce unnecessary complexity
maximize learnings per engineering hour
prove the embedded session operating loop
prepare cleanly for Milestone 5 shared memory without implementing memory extraction

Most important instruction:

Optimize for proving the M4 product loop quickly.

Do not optimize for hypothetical future scale.

Do not let Sessions become the memory engine.

Do not let adapters become an orchestration framework.

Do not let the PTY wrapper become a terminal multiplexer.

Do not let output persistence become a transcript analytics system.

Do not let role/instruction fields become context assembly.

Do not let restart handling become process resumption.
