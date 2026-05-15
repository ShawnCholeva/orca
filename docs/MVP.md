# MVP Specification — Levels 1, 2, and 3

## 1. Purpose

This document defines the MVP needed to prove the core product loop for the AI Multi-Agent Orchestration Platform.

The MVP should deliver Levels 1, 2, and 3 of the autonomy model:

- Level 1: Manual Coordination
- Level 2: Shared Context
- Level 3: Suggested Orchestration

The MVP should not attempt full supervised automation or autonomous execution yet. The goal is to prove that the platform can make AI execution less chaotic by coordinating sessions, preserving reasoning, sharing Goal memory, and recommending useful next actions.

---

## 2. MVP Product Goal

Enable a senior engineer or tech lead to create a Goal, attach multiple workspaces, launch AI agent sessions, preserve shared operational reasoning, and receive useful orchestration recommendations about what should happen next.

The MVP should answer one core question:

> Given everything that has happened in this Goal, what should happen next and why?

---

## 3. MVP Success Criteria

The MVP is successful when a user can run a real engineering Goal through the app and feel that:

- AI execution is less chaotic
- agent sessions are coordinated
- important reasoning is preserved
- decisions are not lost
- sibling sessions have useful shared context
- the system recommends useful next actions
- the user remains in control
- the app feels easier and more valuable than manually managing terminal sessions

---

## 4. Autonomy Level Definitions

## 4.1 Level 1 — Manual Coordination

At Level 1, the app provides a central place to manage Goals, workspaces, sessions, and manual orchestration.

The user is still the primary orchestrator.

Capabilities:

- create Goal
- attach workspaces
- create sessions
- launch sessions in embedded terminals
- manually assign roles/tasks
- manually add notes, decisions, and memory
- view all active sessions in one place

The value of Level 1 is consolidation.

The user no longer has scattered terminal windows and disconnected context.

---

## 4.2 Level 2 — Shared Context

At Level 2, the platform begins preserving and injecting shared Goal context into sessions.

The system becomes a shared memory layer.

Capabilities:

- automatic session summaries
- automatic memory extraction
- automatic decision extraction
- Goal-scoped memory
- context assembly for new sessions
- sibling session summaries
- persistent role context
- shared constraints and reasoning

The value of Level 2 is continuity.

Each session begins with relevant context from the Goal instead of starting from scratch.

---

## 4.3 Level 3 — Suggested Orchestration

At Level 3, the orchestrator recommends what should happen next.

The user remains the supervisor.

Capabilities:

- recommend next sessions
- recommend task decomposition
- recommend reviews/validation
- detect blockers
- detect conflicts
- suggest workflow steps
- provide concise rationale
- accept/reject recommendations
- learn from supervision signals

The value of Level 3 is operational coherence.

The system begins coordinating execution rather than only recording it.

---

## 5. MVP Scope Summary

The MVP should include:

- Tauri v2 desktop shell
- Node.js local daemon
- SQLite storage provider
- event store and projections
- internal plugin registry
- internal skill registry
- Goal creation and refinement
- multiple workspace support
- embedded PTY terminal sessions
- Claude Code adapter
- opencode adapter
- shell/manual adapter
- Goal memory system
- session summary extraction
- decision extraction
- automatic memory promotion
- task/work unit model
- recommendation engine
- Goal command center UI
- live agent workspace UI

---

## 6. Explicit MVP Non-Goals

Do not build in the MVP:

- cloud sync
- team collaboration
- external plugins
- plugin marketplace
- Level 4 automated execution
- Level 5 autonomous execution
- cross-Goal memory
- advanced graph memory
- enterprise permissions
- full IDE replacement
- custom model hosting
- complex analytics dashboards

---

## 7. Primary MVP User Flow

## 7.1 Create Goal

User clicks Create Goal.

Inputs:

- rough natural language Goal
- optional initial workspaces
- selected Goal creation skill

Example:

> Build Stripe Connect marketplace payouts for CrowdBeam.

The system creates a Goal in `created` or `refining` state.

---

## 7.2 Select Goal Creation Skill

The user chooses how to refine the Goal.

MVP skill options:

- Quick Goal
- Guided Goal Refinement
- Brainstorm Goal
- Superpowers-inspired Brainstorm

The selected skill drives the Goal refinement experience.

---

## 7.3 Refine Goal

The system converts the rough Goal into structured operational state.

Outputs:

- Goal summary
- objective
- constraints
- success criteria
- risks
- initial workstreams
- recommended workflows
- initial memory items
- initial recommended tasks/sessions

The user can approve or revise the refined Goal.

---

## 7.4 Attach Workspaces

The user attaches one or more workspaces.

Examples:

- frontend repo
- backend repo
- docs repo
- infrastructure repo
- local tools folder

Each workspace has:

- name
- path
- type
- git status if applicable
- default command context

Memory remains Goal-scoped across all attached workspaces.

---

## 7.5 Generate Initial Work Units

The orchestrator generates dynamic operational work units.

Outputs:

- workstreams
- initial tasks
- suggested roles
- dependencies
- validation expectations
- candidate sessions

Tasks are allowed to evolve later.

---

## 7.6 Launch Agent Session

The user accepts a recommended session or manually creates one.

Inputs:

- agent adapter
- role
- task/work unit
- workspace
- skill/context strategy

The daemon launches the session through PTY.

The UI displays the embedded terminal.

The agent should feel native:

- Claude Code feels like Claude Code
- opencode feels like opencode
- shell feels like shell

---

## 7.7 Capture Session Activity

The daemon captures:

- session lifecycle
- terminal output stream
- hook events where available
- file/workspace activity where available
- user input
- completion signal

Events are persisted to the event store.

The UI receives live updates through WebSocket.

---

## 7.8 Extract Memory and Decisions

After meaningful session events or completion, the system extracts:

- session summary
- completed work
- reasoning
- decisions
- assumptions
- blockers
- risks
- validation results
- follow-up tasks
- recommended next steps

Memory is automatically promoted into Goal memory.

High-impact items may be marked as important or requiring confirmation before dangerous actions.

---

## 7.9 Recommend Next Action

The orchestrator reviews Goal state and generates recommendations.

Examples:

- Launch Reviewer session for Task 2
- Split implementation work into backend and frontend sessions
- Resolve conflict between two architecture decisions
- Run validation before marking work complete
- Ask user to clarify product constraint
- Continue Engineer session with updated context

Each recommendation includes:

- title
- proposed action
- concise rationale
- confidence
- related sessions/tasks/memory

User can accept, reject, or modify the recommendation.

---

## 7.10 Continue Iterating

The Goal evolves through cycles of:

```text
Goal State
  → Recommendation
  → Session
  → Output
  → Memory Extraction
  → Updated Goal State
  → Next Recommendation
```

This loop is the heart of the MVP.

---

## 8. Level 1 Requirements — Manual Coordination

## 8.1 Goal Management

Required:

- create Goal
- edit Goal title/description
- archive Goal
- mark Goal complete manually
- list Goals
- open Goal command center

Goal fields:

- id
- title
- description
- status
- autonomy level
- created at
- updated at

---

## 8.2 Workspace Management

Required:

- attach workspace to Goal
- remove workspace from Goal
- list attached workspaces
- store local path
- detect whether workspace is git repo
- display basic git branch/status

MVP does not need deep code indexing.

---

## 8.3 Manual Session Management

Required:

- create session manually
- choose agent adapter
- choose workspace
- choose role
- optionally assign task
- launch PTY session
- display embedded terminal
- stop session
- archive session

---

## 8.4 Session Dashboard

Required:

- list active sessions
- show agent type
- show role
- show workspace
- show status
- show assigned task if any
- open terminal view

---

## 8.5 Manual Memory and Decisions

Required:

- add manual memory item
- add manual decision
- view Goal memory
- view Goal decisions
- edit/archive memory item

This ensures the app has value before automatic extraction is perfect.

---

## 9. Level 2 Requirements — Shared Context

## 9.1 Session Summary Extraction

After a session ends or reaches a meaningful checkpoint, the system should generate a structured summary.

Output schema:

```json
{
  "summary": "",
  "completedWork": [],
  "openQuestions": [],
  "blockers": [],
  "filesMentioned": [],
  "followUpTasks": []
}
```

---

## 9.2 Memory Extraction

The system should extract structured memory items from session output.

Memory types:

- decision
- assumption
- constraint
- risk
- blocker
- architecture_note
- session_summary
- validation_result
- operational_update
- open_question

---

## 9.3 Decision Extraction

Decisions should be extracted as first-class objects.

Decision schema:

```json
{
  "title": "",
  "decision": "",
  "reasoning": "",
  "alternativesConsidered": [],
  "tradeoffs": [],
  "impactArea": "",
  "confidence": 0.0,
  "requiresConfirmation": false
}
```

---

## 9.4 Automatic Memory Promotion

Routine extracted memory should be promoted automatically.

The system should not require the user to curate every memory item.

Memory status lifecycle:

```text
observed → extracted → promoted → canonical
```

MVP can support:

- extracted
- promoted
- canonical
- archived

---

## 9.5 Context Assembly

When creating a session, the system should assemble a context package.

Always include:

- Goal objective
- assigned task
- role
- critical constraints
- relevant decisions
- acceptance criteria

Include when relevant:

- sibling session summaries
- recent memory
- architecture notes
- known blockers
- related workspaces
- validation expectations

Exclude by default:

- raw logs
- irrelevant memory
- stale notes
- unrelated decisions

---

## 9.6 Shared Sibling Awareness

New sessions should receive concise awareness of related sibling sessions.

Example:

```text
Related active/recent sessions:
- Architect session defined the storage provider boundary.
- Engineer session implemented initial SQLite event store.
- Reviewer session flagged migration naming concerns.
```

This is one of the core Level 2 differentiators.

---

## 10. Level 3 Requirements — Suggested Orchestration

## 10.1 Recommendation Engine

The system should generate orchestration recommendations.

Recommendation types:

- create_session
- continue_session
- review_output
- refine_goal
- split_task
- run_validation
- resolve_conflict
- update_plan
- ask_user
- mark_complete
- pause_work

---

## 10.2 Recommendation UX

Each recommendation should show:

- title
- concise rationale
- proposed action
- confidence
- related context

The user can:

- accept
- reject
- modify
- dismiss

User responses are stored as supervision signals.

---

## 10.3 Task/Work Unit Generation

The orchestrator should generate dynamic operational work units.

Work units should support:

- title
- description
- status
- role
- workspace
- dependencies
- acceptance criteria
- validation steps

Tasks may evolve during execution.

MVP should support:

- create
- edit
- split manually or by recommendation
- mark blocked
- mark resolved
- associate session

---

## 10.4 Basic Conflict Detection

MVP conflict detection should be conservative.

Detect:

- two active sessions touching same workspace/task
- two decisions with contradictory wording
- reviewer rejection
- session output indicating blocker
- unresolved question blocking task

At Level 3, conflict resolution is escalated to the human.

---

## 10.5 Validation Recommendation

After implementation-like work, the system should recommend validation.

Examples:

- run tests
- launch reviewer session
- launch QA session
- verify acceptance criteria
- inspect git diff

MVP does not need to run validation automatically unless the underlying agent does it.

---

## 10.6 Supervision Learning Signals

The MVP should record when users:

- accept recommendation
- reject recommendation
- edit recommendation
- manually create session instead
- resolve conflict
- mark task complete
- mark memory canonical

These signals are not used for advanced learning yet, but they should be stored for future Level 4/5 behavior.

---

## 11. Internal Plugin MVP

The MVP should include an internal plugin registry.

Required internal plugins:

- Claude Code agent adapter
- opencode agent adapter
- shell/manual adapter
- default workflow provider
- default skill provider
- SQLite storage provider
- default memory extractor
- default recommendation provider

External plugin loading is not required yet.

But first-party features should use plugin interfaces.

---

## 12. Skill MVP

The MVP should include internal skills.

Required skills:

## 12.1 Quick Goal Skill

Creates a basic structured Goal from user input.

## 12.2 Guided Goal Refinement Skill

Asks clarifying questions and produces structured Goal state.

## 12.3 Superpowers-Inspired Brainstorm Skill

Inspired by SDLC-oriented Superpowers-style workflows, but adapted for this platform.

Should produce:

- refined Goal
- key assumptions
- constraints
- risks
- workstreams
- initial tasks
- recommended workflows
- initial memory

## 12.4 Session Preparation Skill

Builds session prompt/context package.

## 12.5 Memory Extraction Skill

Extracts structured memory from session output.

## 12.6 Decision Extraction Skill

Extracts first-class decisions and reasoning.

## 12.7 Recommendation Skill

Generates next orchestration recommendations.

---

## 13. UI MVP

## 13.1 Goal Dashboard

Displays:

- Goal title
- Goal summary
- status
- attached workspaces
- active sessions
- current recommendations
- recent memory updates
- open blockers

---

## 13.2 Create Goal Flow

Steps:

1. Enter rough Goal
2. Select Goal creation skill
3. Attach workspaces
4. Review refined Goal
5. Accept initial recommendations

---

## 13.3 Live Agent Workspace

Displays:

- session tabs
- embedded terminal
- agent type
- role
- task
- workspace
- status

The terminal should preserve the native agent experience.

---

## 13.4 Recommendations Panel

Displays active recommendations.

Actions:

- accept
- reject
- modify
- dismiss

---

## 13.5 Memory View

Displays Goal memory items grouped by type.

Supports:

- search/filter
- mark canonical
- archive
- edit

---

## 13.6 Decisions View

Displays decisions with:

- decision
- reasoning
- alternatives
- tradeoffs
- source session
- confirmation status

---

## 13.7 Work Units View

Displays dynamic tasks/work units.

Supports:

- list view
- status filter
- assigned role
- assigned session
- dependencies

Graph view can be deferred.

---

## 14. Data Model MVP

Required tables/projections:

- goals
- workspaces
- sessions
- session_events
- tasks
- memory_items
- decisions
- recommendations
- events
- plugins
- skills
- workflow_instances
- user_feedback_signals

---

## 15. Event Types MVP

Minimum useful event set:

```text
goal.created
goal.refined
goal.updated
goal.completed
workspace.attached
workspace.removed
task.generated
task.updated
task.blocked
task.resolved
session.created
session.started
session.output.received
session.hook.received
session.completed
session.failed
memory.extracted
memory.promoted
memory.archived
decision.extracted
decision.confirmed
recommendation.generated
recommendation.accepted
recommendation.rejected
recommendation.modified
conflict.detected
user.feedback.recorded
```

---

## 16. Reasoning Job MVP

Required reasoning jobs:

- refine_goal
- generate_initial_tasks
- prepare_session_context
- summarize_session
- extract_memory
- extract_decisions
- generate_recommendations
- synthesize_conflict

Each reasoning job should return structured JSON.

Each job should have:

- input schema
- output schema
- max context budget
- model/provider configuration
- retry/error handling

---

## 17. Token Efficiency Requirements

The MVP must be designed to avoid unnecessary AI calls.

Rules:

- do not constantly reason over live terminal output
- prefer hooks and events over repeated summarization
- summarize at checkpoints
- use structured memory instead of raw transcripts
- assemble context selectively
- avoid injecting full Goal history into sessions
- store compact sibling summaries
- run recommendation generation after meaningful state changes, not every event

---

## 18. MVP Architecture Milestones

## Milestone 1 — Local Runtime Foundation

Build:

- Tauri shell
- Node daemon
- local API
- WebSocket events
- SQLite provider
- event store
- basic Goal CRUD

Exit criteria:

- app opens
- daemon starts
- UI can create and list Goals
- events persist

---

## Milestone 2 — Plugin and Skill Foundation

Build:

- internal plugin registry
- internal skill registry
- default skill provider
- default storage plugin
- shell/manual adapter plugin

Exit criteria:

- app can list available skills/adapters
- Goal creation can invoke a skill

---

## Milestone 3 — Goal Creation and Workspaces

Build:

- Create Goal flow
- skill-based refinement
- attach multiple workspaces
- basic git detection
- initial Goal memory

Exit criteria:

- user can create a refined Goal spanning multiple workspaces

---

## Milestone 4 — Embedded Sessions

Build:

- node-pty manager
- embedded terminal UI
- session lifecycle events
- shell/manual session
- Claude Code adapter
- opencode adapter

Exit criteria:

- user can launch Claude Code/opencode from inside the app and interact normally

---

## Milestone 5 — Shared Memory

Build:

- session summary extraction
- memory extraction
- decision extraction
- automatic memory promotion
- memory and decisions views

Exit criteria:

- completed session creates useful Goal memory automatically

---

## Milestone 6 — Context Assembly

Build:

- session preparation skill
- relevant Goal memory injection
- sibling session summaries
- role-aware context package

Exit criteria:

- new session starts with useful, compact Goal context

---

## Milestone 7 — Suggested Orchestration

Build:

- task/work unit generation
- recommendation engine
- recommendations panel
- accept/reject/modify feedback
- validation recommendation
- conservative conflict detection

Exit criteria:

- the system recommends useful next actions after session activity

---

## 19. MVP Demo Scenario

A good demo Goal:

> Add a plugin-first storage provider architecture to an existing app.

Demo steps:

1. Create Goal using brainstorm/refinement skill
2. Attach frontend and backend workspaces
3. System generates initial work units
4. User accepts Architect session recommendation
5. Claude Code launches in embedded terminal
6. Session completes architecture plan
7. System extracts decisions and reasoning
8. System recommends Engineer session
9. Engineer session starts with Architect reasoning included
10. Engineer completes implementation
11. System recommends Reviewer/Validation session
12. User sees Goal memory, decisions, and next recommendations

This proves Levels 1, 2, and 3.

---

## 20. MVP Acceptance Criteria

The MVP is accepted when:

- a Goal can span multiple workspaces
- Claude Code/opencode sessions can be launched and managed in-app
- sessions preserve native terminal feel
- session activity produces structured memory
- decisions and reasoning are preserved
- future sessions receive relevant Goal context
- the system recommends next actions
- user supervision is recorded
- the product feels easier than manually coordinating agent terminals

---

## 21. Final MVP Statement

The MVP should prove the transition from scattered AI sessions to coordinated AI execution.

Level 1 centralizes sessions.

Level 2 gives those sessions shared memory.

Level 3 makes the system recommend how work should proceed.

The goal is not full autonomy yet.

The goal is to make AI execution operationally coherent, context-aware, and supervised by default.

