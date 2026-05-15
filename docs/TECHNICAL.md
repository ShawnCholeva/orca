# Technical Design Document — AI Multi-Agent Orchestration Platform

## 1. Purpose

This document defines the technical architecture for a local-first multi-agent orchestration platform.

The platform coordinates AI agent sessions such as Claude Code, opencode, Codex, and future agent runtimes around long-running engineering Goals. It preserves operational reasoning, manages session lifecycle, coordinates shared context, supports adaptive workflows, and enables supervised progression from manual coordination toward autonomous execution.

The initial implementation target is Level 3 autonomy: suggested orchestration with human supervision.

---

## 2. Product Architecture Summary

The system is a local-first desktop application with a separate local orchestration daemon.

```text
Tauri v2 Desktop App
    ↓
Node.js Orchestrator Daemon
    ↓
Plugin Runtime / Skill Runtime
    ↓
Storage Provider / Event Store / Memory Engine
    ↓
Agent Adapters / PTY Sessions / Workspace Integrations
    ↓
Claude Code / opencode / Codex / Git / Local Workspaces
```

The desktop app provides the user interface.

The daemon owns orchestration, session management, memory, workflows, plugins, skills, event processing, and local execution.

The system must be plugin-first and skill-oriented from the beginning, even if MVP plugins are internal only.

---

## 3. Core Technical Principles

### 3.1 Local-First Execution

Source code, terminal execution, agent sessions, logs, and workspace access remain local by default.

The system should not require cloud infrastructure for the MVP.

Cloud sync, collaboration, billing, marketplace, and team features may be introduced later.

---

### 3.2 UI and Runtime Separation

The Tauri desktop app is not the orchestration runtime.

The local daemon is the source of truth for:

- Goals
- sessions
- tasks
- workflows
- memory
- decisions
- events
- agent lifecycle
- plugin execution
- skill execution

The UI communicates with the daemon through a local API or IPC bridge.

---

### 3.3 Event-Driven Core

The platform should be event-driven internally.

Events describe how the Goal evolves over time.

Examples:

```text
goal.created
goal.refined
workspace.attached
task.generated
task.updated
task.split
session.created
session.started
session.output.received
session.hook.received
session.completed
memory.extracted
memory.promoted
decision.recorded
conflict.detected
recommendation.generated
workflow.advanced
approval.requested
```

Events are persisted and used to update queryable projections.

---

### 3.4 Deterministic Core, Selective AI Reasoning

The system should not rely on constant AI reasoning loops.

Deterministic systems should handle:

- event routing
- lifecycle transitions
- workflow state
- dependency tracking
- session status
- task graph updates
- approval gate enforcement
- plugin registration
- memory lifecycle state

AI reasoning should be invoked selectively for:

- Goal refinement
- plan generation
- task decomposition
- session prompt assembly
- reasoning synthesis
- memory extraction
- decision extraction
- conflict synthesis
- recommendation generation

This preserves token efficiency while still allowing intelligent orchestration.

---

### 3.5 Plugin-First Architecture

The core platform should remain small and extensible.

First-party integrations should use the same extension interfaces as future third-party plugins.

Initial plugins may be internal only, but the architecture should support future user-installed plugins and eventually a marketplace.

---

### 3.6 Skill-Oriented UX

Skills are composable orchestration behavior modules.

Skills are not just prompts.

A skill can define:

- Goal creation behavior
- brainstorming behavior
- refinement flow
- task decomposition strategy
- memory extraction logic
- validation behavior
- context assembly behavior
- recommendation behavior
- conflict handling behavior
- workflow behavior
- UX steps

The platform should ship with default orchestration skills inspired by SDLC-focused systems such as Superpowers, adapted for multi-agent orchestration, Goal memory, token efficiency, and shared reasoning.

---

## 4. Runtime Architecture

### 4.1 Desktop Shell

Technology:

- Tauri v2
- React
- TypeScript

Responsibilities:

- render UI
- host embedded terminal views
- display Goal command center
- show active sessions
- show recommendations
- show tasks and workflows
- show memory and decisions
- send user actions to daemon
- receive live daemon events

The UI should not directly own orchestration logic.

---

### 4.2 Local Orchestrator Daemon

Technology:

- Node.js
- TypeScript

Responsibilities:

- Goal management
- session management
- PTY process management
- agent adapters
- event bus
- workflow engine
- skill runtime
- plugin runtime
- task graph engine
- memory engine
- storage provider abstraction
- workspace/repo integration
- orchestration recommendation engine
- AI reasoning jobs

The daemon is the system of record.

---

### 4.3 Process Model

The Tauri app launches or connects to the local daemon.

Preferred MVP model:

```text
Tauri App starts
    ↓
Daemon health check
    ↓
If daemon not running, start bundled daemon process
    ↓
UI connects to daemon over localhost or IPC
```

The daemon should support:

- clean startup
- health check
- graceful shutdown
- restart recovery
- session recovery where possible
- version reporting
- plugin discovery

---

## 5. Communication Model

### 5.1 UI to Daemon

The UI communicates with the daemon through a local API.

Options:

- HTTP + WebSocket
- gRPC
- Tauri IPC wrapper over local daemon API

Recommended MVP:

- HTTP for commands/query APIs
- WebSocket for live events and terminal streams

Example:

```text
POST /goals
POST /goals/:id/refine
POST /goals/:id/sessions
POST /sessions/:id/input
GET  /goals/:id/state
WS   /events
WS   /sessions/:id/terminal
```

---

### 5.2 Command Query Separation

Commands mutate state.

Queries read projections.

Events describe state changes.

Example:

```text
Command: CreateGoal
Event: goal.created
Projection: goals table updated
UI Query: GET /goals/:id
```

---

## 6. Core Domain Model

## 6.1 Goal

A Goal is the primary orchestration boundary.

A Goal represents a long-running operational intelligence space.

A Goal can span multiple workspaces and repos.

Fields:

```ts
type Goal = {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  autonomyLevel: 1 | 2 | 3 | 4 | 5;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};
```

Statuses:

```text
created
refining
planned
active
blocked
waiting_for_user
complete
archived
```

Goal completion is human-authoritative. The orchestrator may recommend completion, but the user decides.

---

## 6.2 Workspace

A Workspace is a local folder, repo, or execution context attached to a Goal.

A Goal may contain multiple Workspaces.

Fields:

```ts
type Workspace = {
  id: string;
  goalId: string;
  name: string;
  path: string;
  type: 'repo' | 'folder' | 'docs' | 'tooling';
  defaultBranch?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};
```

Memory is Goal-scoped, not workspace-scoped.

Workspaces provide execution and context boundaries, but Goal memory is shared across all workspaces attached to the Goal.

---

## 6.3 Task / Operational Work Unit

Tasks are dynamic operational work units.

They are not static Jira-style tickets.

Tasks may:

- split
- merge
- spawn child tasks
- change dependencies
- change assigned role
- trigger sessions
- attach reasoning
- evolve as the Goal evolves

Fields:

```ts
type Task = {
  id: string;
  goalId: string;
  parentTaskId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedRole?: RoleId;
  assignedSessionId?: string;
  workflowId?: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  validationSteps: string[];
  createdAt: Date;
  updatedAt: Date;
};
```

Statuses:

```text
generated
refined
ready
assigned
executing
blocked
needs_review
validated
resolved
cancelled
```

---

## 6.4 Session

A Session is a disposable agent execution environment.

Sessions are launched and managed by the daemon.

Fields:

```ts
type Session = {
  id: string;
  goalId: string;
  taskId?: string;
  workspaceId?: string;
  roleId: string;
  agentAdapterId: string;
  title: string;
  status: SessionStatus;
  command: string;
  cwd: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  summary?: string;
};
```

Statuses:

```text
created
starting
running
waiting_for_user
blocked
completed
failed
stopped
archived
```

Sessions preserve the native agent experience.

Claude Code should feel like Claude Code.
opencode should feel like opencode.

---

## 6.5 Role

Roles are persistent operational identities.

Examples:

```text
Architect
Engineer
Reviewer
QA
Debugger
Security Reviewer
Refactorer
Release Manager
Product Strategist
```

Roles influence:

- context assembly
- skill selection
- prompt style
- task ownership
- validation expectations
- memory relevance

Execution sessions are disposable, but roles persist across the Goal.

---

## 6.6 Memory Item

Memory is Goal-scoped and reasoning-first.

Fields:

```ts
type MemoryItem = {
  id: string;
  goalId: string;
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  sourceSessionId?: string;
  sourceTaskId?: string;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
};
```

Memory types:

```text
decision
assumption
constraint
risk
blocker
architecture_note
session_summary
validation_result
workflow_learning
operational_update
dependency
open_question
recommendation
```

Memory statuses:

```text
observed
extracted
promoted
canonical
archived
```

Memory promotion is automatic by default.

High-impact memory can be marked as requiring confirmation before it influences dangerous actions.

---

## 6.7 Decision

Decisions are first-class memory entities.

Fields:

```ts
type Decision = {
  id: string;
  goalId: string;
  title: string;
  decision: string;
  reasoning: string;
  alternativesConsidered: string[];
  tradeoffs: string[];
  sourceSessionId?: string;
  sourceTaskId?: string;
  confirmedByUser: boolean;
  impactArea?: string;
  createdAt: Date;
  updatedAt: Date;
};
```

The system should preserve why decisions happened, not just what was chosen.

---

## 6.8 Recommendation

Recommendations are orchestrator-generated next actions.

Fields:

```ts
type Recommendation = {
  id: string;
  goalId: string;
  type: RecommendationType;
  title: string;
  rationale: string;
  confidence: number;
  proposedAction: Record<string, unknown>;
  status: 'open' | 'accepted' | 'rejected' | 'superseded';
  createdAt: Date;
};
```

Recommendation types:

```text
create_session
continue_session
review_output
refine_goal
split_task
run_validation
resolve_conflict
update_plan
ask_user
mark_complete
pause_work
```

Default UX should show recommendation + concise rationale, with expandable details.

---

## 7. Event System

### 7.1 Event Store

All domain events should be persisted append-only.

Fields:

```ts
type DomainEvent = {
  id: string;
  goalId?: string;
  sessionId?: string;
  taskId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  causationId?: string;
  correlationId?: string;
};
```

Events allow reconstruction of operational history and support future reasoning over the Goal timeline.

---

### 7.2 Event Bus

The daemon should include an internal event bus.

Event consumers:

- projection builders
- workflow engine
- memory engine
- recommendation engine
- plugin runtime
- UI event stream
- observability logger

---

### 7.3 State Projections

Projection tables provide current queryable state.

Examples:

- goals
- workspaces
- tasks
- sessions
- memory_items
- decisions
- recommendations
- workflows
- approvals

The UI reads projections, not raw event streams.

---

## 8. Session Management

### 8.1 PTY-Based Execution

The daemon directly launches and manages agent sessions using PTY processes.

Recommended library:

- node-pty

Session flow:

```text
CreateSession command
    ↓
Build session context
    ↓
Resolve agent adapter
    ↓
Spawn PTY process
    ↓
Stream terminal output
    ↓
Emit session events
    ↓
Process hooks/output
    ↓
Extract reasoning/memory
    ↓
Update Goal state
```

---

### 8.2 Terminal Streams

The daemon should expose live terminal streams to the UI.

Terminal data should be stored selectively.

Recommended approach:

- stream raw output live to UI
- persist important session events
- persist summarized output
- optionally persist raw logs with retention policy

Raw logs can become large, so the MVP should avoid treating all raw output as canonical memory.

---

### 8.3 Agent Adapter Interface

Each agent integration implements the same adapter interface.

```ts
interface AgentAdapter {
  id: string;
  displayName: string;
  isAvailable(): Promise<boolean>;
  getDefaultCommand(input: AgentSessionInput): Promise<AgentCommand>;
  prepareEnvironment(input: AgentSessionInput): Promise<Record<string, string>>;
  parseHookEvent?(event: unknown): Promise<AgentHookEvent | null>;
  getCapabilities(): AgentCapabilities;
}
```

Initial adapters:

- Claude Code adapter
- opencode adapter
- Codex adapter
- shell/manual adapter

The shell/manual adapter is useful for testing and fallback behavior.

---

### 8.4 Agent Hooks

Agent-provided hooks should be first-class orchestration inputs.

Claude Code and opencode hooks can be used to observe:

- command start
- command finish
- tool usage
- file edits
- session milestones
- errors
- approvals
- completion signals

Hook events should become domain events.

```text
agent.hook.received
session.tool.started
session.tool.completed
session.file.changed
session.command.completed
```

The orchestrator should prefer hook/event signals over expensive constant AI inspection.

---

## 9. Orchestrator Engine

### 9.1 Responsibilities

The orchestrator is responsible for:

- refining Goals
- decomposing Goals into operational work units
- recommending sessions
- routing context
- applying workflows
- coordinating memory
- tracking dependencies
- detecting conflicts
- coordinating validation
- generating recommendations
- escalating uncertainty to the human

---

### 9.2 Orchestrator Loop

The orchestrator loop is hybrid.

```text
Events / Hooks / User Actions
        ↓
Event Bus
        ↓
Projection Updates
        ↓
Rule-Based Triggers
        ↓
Selective AI Reasoning Jobs
        ↓
Memory / Tasks / Recommendations / Workflows Updated
```

The system should be live but not constantly thinking.

---

### 9.3 Deterministic Rules

Examples:

- If a session completes, schedule memory extraction.
- If an implementation session completes, recommend review or validation.
- If two sessions modify the same files, emit possible conflict.
- If a task depends on unresolved open questions, mark blocked.
- If a dangerous action is proposed, require approval.
- If a workflow phase completes, advance workflow state.

---

### 9.4 AI Reasoning Jobs

AI reasoning jobs are structured tasks invoked by the orchestrator.

Examples:

```text
goal_refinement_job
plan_generation_job
task_decomposition_job
context_assembly_job
session_summary_job
memory_extraction_job
decision_extraction_job
conflict_synthesis_job
recommendation_generation_job
```

All reasoning jobs should return structured JSON, not only prose.

---

## 10. Goal Refinement Pipeline

Goal creation starts with natural language.

The system then refines the Goal into structured operational state.

Flow:

```text
User creates Goal
    ↓
User selects Goal creation skill
    ↓
Skill runs refinement flow
    ↓
Structured Goal model produced
    ↓
Initial workspaces attached
    ↓
Initial memory created
    ↓
High-level plan/workstreams generated
    ↓
Initial recommendations created
```

The default Goal creation experience should support skill selection.

Example skill options:

- Quick Goal
- Guided Goal Refinement
- Brainstorm Goal
- Superpowers-inspired Brainstorm
- Import from Markdown
- Custom Skill

---

## 11. Memory Engine

### 11.1 Memory Philosophy

Memory should preserve operational reasoning.

The system should remember:

- decisions
- rationale
- assumptions
- constraints
- sibling session activity
- blockers
- risks
- validation outcomes
- why work changed direction

---

### 11.2 Memory Lifecycle

```text
Observed
   ↓
Extracted
   ↓
Promoted
   ↓
Canonical
```

Observed:
Raw events/session output exist.

Extracted:
AI or deterministic processor extracts structured memory candidates.

Promoted:
Memory is automatically added to Goal memory.

Canonical:
High-confidence or user-confirmed memory that should strongly influence orchestration.

---

### 11.3 Memory Promotion

Memory promotion should be automatic by default.

The user should not need to curate routine memory.

High-risk decisions may require confirmation before affecting execution.

Examples:

Auto-promote:

- session summary
- discovered blocker
- validation result
- implementation note
- low-risk decision

Require confirmation before action:

- destructive refactor
- database migration strategy
- production deploy decision
- security-sensitive change
- payment/billing policy change

---

### 11.4 Memory Retrieval

The context builder should retrieve memory based on:

- Goal
- task
- role
- workspace
- recent activity
- active sibling sessions
- decisions
- constraints
- risks

The system should avoid dumping all memory into every session.

The goal is right-sized context.

---

## 12. Context Assembly

The context assembly engine prepares agent-ready context.

Inputs:

- Goal summary
- current task
- role
- workflow stage
- relevant memory
- relevant decisions
- sibling session summaries
- workspace/repo context
- validation expectations
- constraints

Output:

- prompt/context package for agent session

Context tiers:

### Always Include

- Goal objective
- task objective
- role
- critical constraints
- relevant decisions
- acceptance criteria

### Include If Relevant

- sibling session summaries
- architecture notes
- known risks
- recent changes
- related files
- open questions

### Exclude By Default

- stale logs
- irrelevant prior discussion
- rejected ideas unless relevant
- full raw session transcripts

---

## 13. Workflow Engine

### 13.1 Workflow Philosophy

Workflows are adaptive orchestration graphs.

They are not rigid pipelines.

A workflow defines:

- stages
- recommended roles
- validation expectations
- approval boundaries
- orchestration heuristics
- skill hooks
- policy rules

The orchestrator adapts workflows dynamically as Goal state changes.

---

### 13.2 Workflow Provider Interface

```ts
interface WorkflowProvider {
  id: string;
  displayName: string;
  supports(goal: Goal): Promise<boolean>;
  createInitialGraph(input: WorkflowInput): Promise<WorkflowGraph>;
  handleEvent?(event: DomainEvent, state: GoalState): Promise<WorkflowAction[]>;
}
```

---

### 13.3 Example Default Workflows

MVP default workflows could include:

- Brainstorm / Discovery Workflow
- Technical Design Workflow
- Feature Implementation Workflow
- Bug Fix Workflow
- Refactor Workflow
- Validation / Review Workflow

These should be inspired by SDLC-oriented practices, but adapted for this platform’s Goal, memory, session, and orchestration model.

---

## 14. Skill Runtime

### 14.1 Skill Definition

Skills are composable orchestration behavior modules.

A skill may customize:

- user experience
- prompt strategy
- reasoning job behavior
- output schema
- workflow steps
- memory extraction
- context assembly
- validation strategy
- recommendation logic

---

### 14.2 Skill Interface

```ts
interface Skill {
  id: string;
  displayName: string;
  description: string;
  extensionPoints: SkillExtensionPoint[];
  run(input: SkillRunInput): Promise<SkillRunResult>;
}
```

Extension points:

```text
goal.create
goal.refine
plan.generate
task.decompose
session.prepare
session.summarize
memory.extract
decision.extract
conflict.resolve
validation.run
recommendation.generate
workflow.advance
```

---

### 14.3 Skill-Oriented UX

UX should allow users to choose skills at key moments.

Example: Create Goal

```text
Create Goal
  ├─ Quick Goal
  ├─ Guided Goal Refinement
  ├─ Superpowers-inspired Brainstorm
  ├─ Import Existing Plan
  └─ Custom Skill
```

Example: Generate Plan

```text
Generate Plan
  ├─ Default Technical Plan
  ├─ SDLC Feature Plan
  ├─ Refactor Plan
  ├─ Startup MVP Plan
  └─ Custom Skill
```

---

### 14.4 Default Skill Pack

The platform should ship with a default internal skill pack.

Suggested default skills:

- Goal Brainstorm Skill
- Goal Refinement Skill
- Goal Structuring Skill
- Technical Design Skill
- Task Decomposition Skill
- Session Preparation Skill
- Memory Extraction Skill
- Decision Extraction Skill
- Validation Planning Skill
- Review Recommendation Skill
- Conflict Synthesis Skill

These should preserve the spirit of SDLC-focused skills while being customized for:

- multi-agent orchestration
- Goal memory
- sibling awareness
- token efficiency
- structured outputs
- long-running operational context

---

## 15. Plugin Runtime

### 15.1 MVP Plugin Strategy

MVP supports internal plugins only.

The architecture must support future external plugins.

Progression:

```text
Phase 1: Internal plugins
Phase 2: Local user-installed plugins
Phase 3: Git/package installed plugins
Phase 4: Marketplace
```

---

### 15.2 Plugin Manifest

Future plugin manifest example:

```json
{
  "id": "claude-code-adapter",
  "name": "Claude Code Adapter",
  "version": "0.1.0",
  "capabilities": ["agent.adapter", "session.hooks"],
  "permissions": ["pty.spawn", "filesystem.read", "filesystem.write"],
  "entry": "./dist/index.js"
}
```

---

### 15.3 Extension Points

Initial extension points:

```text
AgentAdapter
WorkflowProvider
SkillProvider
StorageProvider
MemoryProcessor
ReasoningExtractor
ContextProvider
ValidationProvider
RecommendationProvider
EventSubscriber
UIContribution later
```

---

### 15.4 Plugin Registry

The daemon should maintain a plugin registry.

Responsibilities:

- discover plugins
- register extension points
- validate capabilities
- expose available skills/workflows/adapters
- manage plugin lifecycle

---

## 16. Storage Architecture

### 16.1 Pluggable Storage Provider

Storage must be provider-based.

MVP default:

- SQLite

Future provider:

- Postgres

Rule:

The orchestration system must not directly depend on SQLite-specific behavior.

---

### 16.2 Storage Interfaces

Recommended interfaces:

```ts
interface EventStore {
  append(event: DomainEvent): Promise<void>;
  getEvents(query: EventQuery): Promise<DomainEvent[]>;
}

interface ProjectionStore {
  getGoalState(goalId: string): Promise<GoalState>;
  updateProjection(update: ProjectionUpdate): Promise<void>;
}

interface MemoryStore {
  create(item: MemoryItem): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryItem[]>;
  update(item: MemoryItem): Promise<void>;
}

interface ArtifactStore {
  put(artifact: Artifact): Promise<void>;
  get(id: string): Promise<Artifact | null>;
}
```

---

### 16.3 SQLite MVP

SQLite is the default local provider because:

- zero install
- local-first
- easy packaging
- good enough for single-user execution
- works offline
- low operational overhead

Postgres should be introduced for:

- team mode
- cloud mode
- multi-user collaboration
- shared Goals
- hosted deployments

---

## 17. UI Architecture

### 17.1 Primary UX

The primary interface is a hybrid of:

- Goal Command Center
- Live Agent Workspace

The app should feel like an operational war room for AI execution.

---

### 17.2 Core Views

MVP views:

- Goal Dashboard
- Create Goal / Refine Goal
- Active Sessions
- Embedded Terminal Workspace
- Task Graph / Work Units
- Recommendations Panel
- Memory / Reasoning View
- Decisions View
- Workspaces View
- Settings / Plugin Registry

---

### 17.3 Goal Command Center

Should show:

- Goal objective
- current status
- active sessions
- recommended next actions
- task graph
- recent reasoning updates
- key decisions
- blockers
- attached workspaces

---

### 17.4 Live Agent Workspace

Should show:

- embedded terminal sessions
- session tabs/splits
- agent type
- role
- assigned task
- session status
- sibling awareness indicators
- session summary

The terminal experience should preserve native agent ergonomics.

---

## 18. Conflict Detection

At Level 3, conflicts should escalate to the human.

Conflict sources:

- conflicting decisions
- overlapping file edits
- contradictory assumptions
- reviewer rejection
- sibling sessions duplicating work
- stale context usage

Conflict handling flow:

```text
Conflict detected
    ↓
Conflict synthesized
    ↓
Human receives concise explanation
    ↓
Human resolves or redirects
    ↓
Resolution becomes Goal memory
```

The system learns from human resolution patterns over time.

---

## 19. Approval Gates

Approval gates are used for high-impact actions.

Examples:

- database migrations
- deleting files
- production deploys
- modifying secrets
- billing/payment changes
- large refactors
- security-sensitive changes

At Level 3, approval gates mostly appear as recommendations or warnings.

At Level 4 and 5, they become enforceable orchestration boundaries.

---

## 20. Observability

Deep orchestration observability is mostly internal/debugging.

The user-facing UX should show:

- recommendation rationale
- important decisions
- conflicts
- memory updates
- session status
- task progress

Internal telemetry should track:

- event flow
- plugin execution
- skill execution
- reasoning job cost
- token usage
- context size
- recommendation acceptance/rejection
- memory promotion
- session lifecycle

This telemetry will support future orchestration learning and debugging.

---

## 21. Security Model

### 21.1 MVP Security Principle

The app inherits the native security and execution behavior of the underlying agent runtime.

Claude Code behaves like Claude Code.
opencode behaves like opencode.

The orchestrator coordinates sessions but does not initially replace runtime permission systems.

---

### 21.2 Local Trust Boundary

Sensitive operations remain local:

- code access
- terminal execution
- agent logs
- workspace files
- local credentials

---

### 21.3 Future Plugin Security

Before external plugins are supported, the platform will need:

- plugin permission declarations
- user approval for sensitive capabilities
- plugin sandboxing strategy
- signed plugins or trust model
- marketplace review process

---

## 22. Future Cloud Architecture

Cloud is not required for MVP.

Future cloud layer may support:

- account management
- billing
- sync
- team collaboration
- organization memory
- marketplace
- shared workflow packs
- shared skill packs
- analytics

Cloud should not become mandatory for local execution.

Recommended future architecture:

```text
Tauri Desktop App
    ↓
Local Daemon
    ↓
Optional Cloud Coordination Layer
    ↓
Team Sync / Billing / Marketplace / Shared Templates
```

---

## 23. Autonomy Progression Support

The architecture must support all five autonomy levels.

### Level 1
Manual coordination.

### Level 2
Shared Goal memory and context injection.

### Level 3
Suggested orchestration with human supervision.

### Level 4
Supervised orchestration where the system runs flows and pauses at gates.

### Level 5
Autonomous execution with exception-based oversight.

The MVP targets Level 3 but must not require major architectural rewrites to reach Level 4.

---

## 24. MVP Technical Scope

The first build should prove the Level 3 loop.

Required capabilities:

- Tauri desktop shell
- Node daemon
- local daemon startup/connectivity
- SQLite storage provider
- event store
- Goal creation
- multiple workspace attachment
- internal plugin registry
- internal skill registry
- Create Goal skill selection
- Goal refinement pipeline
- task/work unit generation
- embedded PTY sessions
- Claude Code adapter
- opencode adapter
- session output streaming
- session lifecycle events
- automatic memory extraction
- decision extraction
- recommendations panel
- manual accept/reject recommendation flow

---

## 25. Explicit Non-Goals for MVP

Do not build yet:

- cloud sync
- team collaboration
- external plugin marketplace
- full cross-goal memory
- full autonomous execution
- custom model hosting
- complete reasoning graph
- enterprise permission system
- full VS Code replacement
- generic chatbot interface

---

## 26. Recommended Initial Build Order

### Phase 1: Runtime Foundation

- Tauri app boots
- Node daemon boots
- UI connects to daemon
- SQLite provider works
- event store works
- basic Goal CRUD works

### Phase 2: Plugin and Skill Foundation

- internal plugin registry
- internal skill registry
- default Goal creation skill
- default Goal refinement skill
- default session preparation skill

### Phase 3: Workspaces and Goals

- attach multiple workspaces to Goal
- store workspace metadata
- inspect git state
- basic workspace events

### Phase 4: Session Runtime

- node-pty integration
- embedded terminal UI
- Claude Code adapter
- opencode adapter
- session lifecycle events
- terminal streaming

### Phase 5: Memory and Reasoning

- session summary extraction
- memory extraction
- decision extraction
- automatic promotion to Goal memory
- memory view

### Phase 6: Orchestration Recommendations

- basic recommendation engine
- task/work unit generation
- next session recommendation
- review/validation recommendation
- accept/reject feedback loop

### Phase 7: Adaptive Workflows

- default workflow provider
- workflow graph model
- workflow event handling
- skill-driven workflow steps

---

## 27. Key Technical Risks

### PTY Stability

Embedded terminal behavior can be tricky across operating systems.

Mitigation:

- isolate PTY manager
- build shell/manual adapter first
- test Windows/macOS/Linux early

---

### Token Cost

Live orchestration can become expensive.

Mitigation:

- event-first architecture
- hooks before AI inspection
- structured summaries
- selective reasoning jobs
- context budgeting

---

### Memory Quality

Automatic memory promotion can create noisy memory.

Mitigation:

- typed memory
- confidence scores
- importance scores
- canonical status
- memory consolidation jobs

---

### Plugin Complexity

A plugin system can overcomplicate MVP.

Mitigation:

- internal plugins only first
- stable interfaces
- no marketplace early
- first-party plugins use same interfaces

---

### Workflow Over-Rigidity

Static workflows can make the system feel brittle.

Mitigation:

- adaptive workflow graphs
- recommendations over enforcement at Level 3
- human feedback loop

---

## 28. Final Architecture Statement

The platform is a local-first, plugin-oriented, skill-driven orchestration runtime for coordinating multiple AI agent sessions around long-running engineering Goals.

The Tauri app provides the command center and live agent workspace.

The Node daemon owns orchestration, sessions, memory, workflows, plugins, skills, events, and storage.

The system is event-driven, deterministic where possible, selectively AI-powered where judgment is needed, and designed to progress from supervised Level 3 orchestration toward higher autonomy over time.

