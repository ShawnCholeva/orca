# Orca Goal: Workflow-Driven Orchestrator

## Goal

Build Orca’s orchestrator so it can coordinate cross-agent sessions through explicit workflows instead of ad-hoc chat routing.

The orchestrator should take a user goal, classify the type of work, select an appropriate workflow, move the goal through SDLC phases, dispatch work to agents, collect results, evaluate phase exit criteria, and decide whether to advance, retry, escalate, or ask the user for input.

This is the foundation for Orca becoming an AI engineering control plane rather than just a multi-agent terminal manager.

---

## Core Product Idea

Orca should not do this:

```txt
User → Orchestrator Chat → Agent
```

It should do this:

```txt
User → Orchestrator Chat → Workflow Runtime → SDLC Phase → Agent Task → Validation → Next Phase
```

The orchestrator chat is the user-facing interface.

The workflow runtime is the actual system that controls the process.

---

## Terminology

### Goal

A high-level user outcome that may span multiple workspaces, agents, sessions, and workflow runs.

Examples:

- Add agent readiness checks to onboarding
- Refactor workspace detection
- Build a new feature
- Investigate architecture drift
- Fix a bug across several packages

### Workflow

A reusable SDLC playbook.

The user calls these “workflows.”

Examples:

- Feature Development Workflow
- Bugfix Workflow
- Refactor Workflow
- Architecture Review Workflow
- Prototype Workflow

### Phase

A step inside a workflow.

Examples:

- Idea Intake
- Research
- Spec / PRD
- Issue Breakdown
- Execution
- QA
- Review
- Done

### Agent

An external or local coding/reasoning system Orca can coordinate.

Examples:

- Claude Code
- Codex
- Gemini
- OpenCode
- Local model
- Human user

### Artifact

A durable output created during a phase.

Examples:

- Goal brief
- Research summary
- PRD
- Implementation plan
- Ticket list
- Test report
- QA checklist
- Review report
- Final summary
- Memory update

---

## MVP Scope

Build the workflow-driven orchestrator for a single primary workflow:

```txt
Feature Development Workflow
```

The workflow should support the following phases:

```txt
1. Idea Intake
2. Research
3. Spec
4. Issue Breakdown
5. Execution
6. QA
7. Review
8. Done
```

The MVP does not need to fully automate every phase. It only needs to represent the phases, route work through them, store phase outputs, and allow the orchestrator to advance through the workflow intentionally.

---

## Non-Goals

Do not build a full autonomous engineering agent yet.

Do not attempt to optimize agent performance yet.

Do not build the full metrics dashboard in this goal. Metrics are covered in a separate goal document.

Do not build every possible workflow yet.

Do not let the LLM invent arbitrary workflow steps or agent capabilities.

Do not give the orchestrator unlimited raw terminal logs. Use summarized state and artifacts.

---

## Required Architecture

The orchestrator should be built around these components:

```txt
Orchestrator Chat UI
        ↓
Orchestrator LLM
        ↓
Workflow Runtime
        ↓
Workflow Registry
Agent Registry
Goal Store
Artifact Store
Workspace Context
Session Dispatcher
```

---

## Core Flow

The orchestrator should follow this flow:

```txt
1. User enters a goal in orchestrator chat.
2. Orca determines whether this belongs to an existing goal or creates a new one.
3. Orca classifies the work type.
4. Orca selects a workflow.
5. Orca starts a workflow run.
6. Orca determines the current phase.
7. Orca checks whether required phase inputs exist.
8. If inputs are missing, Orca asks the user or dispatches a discovery task.
9. If inputs exist, Orca generates an agent task.
10. Orca selects the best available agent.
11. Orca checks whether the agent is ready.
12. Orca dispatches the task to the agent.
13. Orca captures the result.
14. Orca summarizes the result into an artifact.
15. Orca evaluates the phase exit criteria.
16. Orca advances, retries, escalates, or asks the user.
17. Orca repeats until the workflow is complete.
```

---

## Workflow Runtime Requirements

Create a workflow runtime that can:

- Start a workflow run
- Track current phase
- Load workflow definition
- Load goal context
- Load relevant artifacts
- Determine missing inputs
- Generate phase-specific agent tasks
- Dispatch tasks to agents
- Store phase outputs
- Evaluate exit criteria
- Advance to the next phase
- Pause when user input is required
- Mark workflow complete

---

## Data Model

Create or adapt models similar to the following.

```ts
type Goal = {
  id: string;
  title: string;
  description?: string;
  status: "active" | "paused" | "completed" | "abandoned" | "blocked";
  currentWorkflowRunId?: string;
  workspaceIds: string[];
  createdAt: string;
  updatedAt: string;
};
```

```ts
type Workflow = {
  id: string;
  name: string;
  description: string;
  phases: WorkflowPhase[];
  defaultPolicy: WorkflowPolicy;
};
```

```ts
type WorkflowRun = {
  id: string;
  goalId: string;
  workflowId: string;
  status: "active" | "paused" | "completed" | "failed" | "blocked";
  currentPhaseId: string;
  startedAt: string;
  completedAt?: string;
};
```

```ts
type WorkflowPhase = {
  id: string;
  name: string;
  purpose: string;
  requiredInputs: ArtifactType[];
  requiredOutputs: ArtifactType[];
  recommendedAgents: AgentId[];
  exitCriteria: ExitCriterion[];
  escalationRules: EscalationRule[];
};
```

```ts
type PhaseRun = {
  id: string;
  workflowRunId: string;
  phaseId: string;
  status: "pending" | "active" | "passed" | "failed" | "skipped" | "blocked";
  startedAt?: string;
  completedAt?: string;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  assignedAgentSessionIds: string[];
};
```

```ts
type Artifact = {
  id: string;
  goalId: string;
  workflowRunId?: string;
  phaseRunId?: string;
  type: ArtifactType;
  title: string;
  content: string;
  source: "user" | "agent" | "orchestrator" | "system";
  createdAt: string;
};
```

```ts
type ArtifactType =
  | "goal_brief"
  | "research_summary"
  | "spec"
  | "issue_breakdown"
  | "implementation_result"
  | "test_report"
  | "qa_report"
  | "review_report"
  | "final_summary"
  | "memory_update";
```

---

## Workflow Registry

Create a registry for supported workflows.

The first workflow should be:

```ts
const featureDevelopmentWorkflow = {
  id: "feature-development",
  name: "Feature Development",
  description: "A standard workflow for taking a user goal from idea to implemented and reviewed software.",
  phases: [
    "idea_intake",
    "research",
    "spec",
    "issue_breakdown",
    "execution",
    "qa",
    "review",
    "done"
  ]
};
```

Each phase should have explicit required inputs, required outputs, exit criteria, and recommended agents.

---

## Phase Definitions

### Phase 1: Idea Intake

Purpose:

Clarify what the user wants and convert it into a usable goal brief.

Required inputs:

- User request

Required outputs:

- Goal brief

Exit criteria:

- Problem statement exists
- Desired outcome exists
- Success criteria exist
- Known constraints are captured
- Blocking questions are either resolved or explicitly tracked

Recommended agents:

- Orchestrator LLM
- Claude Haiku for lightweight intake
- Claude Sonnet if product ambiguity is high

---

### Phase 2: Research

Purpose:

Understand the existing codebase, architecture, user flow, and relevant constraints before proposing changes.

Required inputs:

- Goal brief
- Workspace context

Required outputs:

- Research summary

Exit criteria:

- Relevant files identified
- Existing implementation summarized
- Dependencies and risks captured
- Unknowns captured
- Suggested implementation area identified

Recommended agents:

- Claude Code
- Gemini
- Sonnet for complex architecture

---

### Phase 3: Spec

Purpose:

Turn the researched goal into a buildable specification.

Required inputs:

- Goal brief
- Research summary

Required outputs:

- Spec

Exit criteria:

- User stories or behavior statements exist
- Acceptance criteria exist
- Non-goals exist
- Edge cases exist
- Open questions are captured
- Validation expectations are defined

Recommended agents:

- Claude Code
- Sonnet

---

### Phase 4: Issue Breakdown

Purpose:

Break the spec into executable units of work.

Required inputs:

- Spec
- Research summary

Required outputs:

- Issue breakdown

Exit criteria:

- Work is split into clear tasks
- Each task has validation criteria
- Dependencies are explicit
- Tasks are small enough to assign to an agent
- Suggested agent per task is defined

Recommended agents:

- Haiku for simple breakdown
- Sonnet for complex systems
- Claude Code for repo-aware breakdown

---

### Phase 5: Execution

Purpose:

Assign implementation tasks to agents and capture code changes.

Required inputs:

- Issue breakdown
- Spec
- Research summary

Required outputs:

- Implementation result
- Test report where applicable

Exit criteria:

- Assigned task completed
- Files changed are summarized
- Validation command was run or skipped with reason
- Failures are captured
- No blocking errors remain

Recommended agents:

- Codex
- Claude Code
- OpenCode

---

### Phase 6: QA

Purpose:

Verify the result against the acceptance criteria and expected user behavior.

Required inputs:

- Spec
- Implementation result
- Test report

Required outputs:

- QA report

Exit criteria:

- Acceptance criteria checked
- Passing and failing items recorded
- Bugs or gaps captured
- Rework required or not required is clear

Recommended agents:

- Gemini
- Claude Code
- Human user when manual UI validation is needed

---

### Phase 7: Review

Purpose:

Review the change for architecture quality, maintainability, test gaps, and production readiness.

Required inputs:

- Implementation result
- QA report
- Spec
- Research summary

Required outputs:

- Review report

Exit criteria:

- Architecture drift assessed
- Test gaps assessed
- Maintainability risks captured
- Blocking issues identified
- Follow-up tasks created if needed

Recommended agents:

- Gemini
- Claude Sonnet
- Claude Code

---

### Phase 8: Done

Purpose:

Finalize the workflow and store durable memory.

Required inputs:

- Review report
- QA report
- Implementation result

Required outputs:

- Final summary
- Memory update

Exit criteria:

- Final result summarized
- Important decisions captured
- Follow-up work captured
- Goal marked complete or partially complete

Recommended agents:

- Orchestrator LLM

---

## Agent Registry

The orchestrator should use a deterministic registry of known agents.

Example:

```ts
const agentRegistry = {
  claude_code: {
    displayName: "Claude Code",
    strengths: ["research", "architecture", "refactoring", "planning", "codebase navigation"],
    defaultPhases: ["research", "spec", "review"],
    supportsRepoEditing: true,
    supportsTerminal: true
  },
  codex: {
    displayName: "Codex",
    strengths: ["implementation", "patching", "test fixing", "bounded tasks"],
    defaultPhases: ["execution"],
    supportsRepoEditing: true,
    supportsTerminal: true
  },
  gemini: {
    displayName: "Gemini",
    strengths: ["large-context review", "alternative analysis", "QA", "architecture review"],
    defaultPhases: ["qa", "review"],
    supportsRepoEditing: false,
    supportsTerminal: false
  },
  opencode: {
    displayName: "OpenCode",
    strengths: ["local coding workflows", "provider flexibility", "implementation"],
    defaultPhases: ["execution"],
    supportsRepoEditing: true,
    supportsTerminal: true
  }
};
```

The LLM may choose from the registry, but it must not invent unsupported agents.

---

## Orchestrator Decision Shape

The orchestrator LLM should return structured decisions.

Example:

```ts
type OrchestratorDecision =
  | {
      type: "START_WORKFLOW";
      goalId: string;
      workflowId: string;
      reason: string;
    }
  | {
      type: "ADVANCE_PHASE";
      workflowRunId: string;
      fromPhaseId: string;
      toPhaseId: string;
      reason: string;
    }
  | {
      type: "DISPATCH_AGENT_TASK";
      workflowRunId: string;
      phaseId: string;
      agentId: string;
      prompt: string;
      expectedArtifactType: ArtifactType;
      reason: string;
    }
  | {
      type: "ASK_USER";
      question: string;
      options?: string[];
      reason: string;
    }
  | {
      type: "ESCALATE";
      targetModelOrAgent: string;
      reason: string;
    }
  | {
      type: "MARK_PHASE_COMPLETE";
      phaseId: string;
      artifactIds: string[];
      reason: string;
    };
```

---

## Orchestrator Prompt Requirements

The orchestrator prompt should include:

- The user request
- Current goal state
- Current workflow run
- Current phase
- Available artifacts
- Available agents
- Workflow definition
- Exit criteria
- Allowed actions
- Safety rules

The orchestrator should be instructed to:

- Prefer the cheapest sufficient model/agent
- Use workflows instead of ad-hoc routing
- Never skip required phase outputs unless policy allows it
- Ask the user only when blocked by a meaningful decision
- Escalate when complexity or risk is high
- Never claim completion without validation or clear reason why validation could not run
- Output structured decisions only

---

## Workflow Rigor Modes

Support the idea of workflow rigor, even if MVP only uses one default.

```ts
type WorkflowRigor = "prototype" | "standard" | "production";
```

Prototype mode:

```txt
Idea Intake → Execution → QA
```

Standard mode:

```txt
Idea Intake → Research → Spec → Execution → QA
```

Production mode:

```txt
Idea Intake → Research → Spec → Issue Breakdown → Execution → QA → Review → Done
```

For the MVP, default to `standard` or `production` depending on user preference.

---

## UI Requirements

The orchestrator chat should show:

- Current goal
- Current workflow
- Current phase
- Active agent
- Phase status
- Required outputs
- Exit criteria
- Recent agent results
- Next recommended action

Example UI state:

```txt
Goal: Agent Readiness Checks
Workflow: Feature Development
Rigor: Production

Current Phase: Research
Assigned Agent: Claude Code

Exit Criteria:
- Existing onboarding flow inspected
- Agent config locations identified
- Readiness check requirements documented
- Unknowns captured
```

---

## Event Requirements

The workflow runtime should emit events for important actions.

This is required because the metrics goal will build metrics from these events.

At minimum, emit:

```ts
type WorkflowEvent =
  | { type: "WORKFLOW_STARTED"; workflowRunId: string; goalId: string; timestamp: string }
  | { type: "PHASE_STARTED"; workflowRunId: string; phaseRunId: string; phaseId: string; timestamp: string }
  | { type: "AGENT_ASSIGNED"; phaseRunId: string; agentId: string; timestamp: string }
  | { type: "TASK_DISPATCHED"; phaseRunId: string; agentId: string; timestamp: string }
  | { type: "ARTIFACT_CREATED"; phaseRunId: string; artifactId: string; artifactType: ArtifactType; timestamp: string }
  | { type: "VALIDATION_RUN"; phaseRunId: string; command?: string; timestamp: string }
  | { type: "VALIDATION_PASSED"; phaseRunId: string; timestamp: string }
  | { type: "VALIDATION_FAILED"; phaseRunId: string; reason?: string; timestamp: string }
  | { type: "HUMAN_DECISION_REQUESTED"; phaseRunId: string; question: string; timestamp: string }
  | { type: "PHASE_COMPLETED"; workflowRunId: string; phaseRunId: string; phaseId: string; timestamp: string }
  | { type: "WORKFLOW_COMPLETED"; workflowRunId: string; timestamp: string };
```

---

## Acceptance Criteria

This goal is complete when:

- Orca can create a goal from orchestrator chat.
- Orca can select the Feature Development Workflow.
- Orca can create a workflow run.
- Orca can track the current workflow phase.
- Orca can load phase definitions from a registry.
- Orca can generate phase-specific agent tasks.
- Orca can dispatch tasks to selected agents.
- Orca can store artifacts created by each phase.
- Orca can evaluate basic phase exit criteria.
- Orca can advance from one phase to the next.
- Orca can pause and ask the user for input when required.
- Orca emits workflow events that can later be used for metrics.
- The UI shows the current goal, workflow, phase, assigned agent, and next action.

---

## Implementation Guidance

Build this in layers.

### Phase 1: Data and Registry

- Add goal model if missing
- Add workflow run model
- Add phase run model
- Add artifact model if missing
- Add workflow registry
- Add agent registry

### Phase 2: Workflow Runtime

- Start workflow run
- Start phase run
- Complete phase run
- Advance phase
- Store artifacts
- Emit workflow events

### Phase 3: Orchestrator Decision Layer

- Create structured decision schema
- Build orchestrator prompt
- Add decision validation
- Ensure only supported actions are executable

### Phase 4: Agent Dispatch

- Connect workflow phase tasks to existing agent/session infrastructure
- Store agent results as artifacts
- Capture session summaries

### Phase 5: UI

- Show goal workflow state
- Show current phase
- Show phase progress
- Show next action
- Show active agent sessions

---

## Important Design Principle

The orchestrator should not directly manage chaos.

The orchestrator should execute workflows.

The workflows define the SDLC.

The agents do the work.

The runtime enforces the process.

The event stream makes the process measurable.
