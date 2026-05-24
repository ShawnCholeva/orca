# PRD: Workflow-Driven Orchestrator And Engineering Workflow

## Summary

Build Orca workflows as a first-class product model. A workflow is a global reusable template made of ordered steps, guardrails, artifact requirements, operator-selection constraints, validation expectations, and advancement rules. The orchestrator chat runs and supervises workflow runs; the Workflows tab authors workflow templates.

The first built-in workflow is **Engineering**. Engineering adapts Matt Pocock's AI engineering practices to Orca's product model: alignment-first intake, PRD as destination artifact, vertical-slice issue breakdown, bounded agent execution, human QA, fresh-context review, and rework loops. The system should make workflow influence visible so users can understand how a workflow design changes the work Orca recommends and performs.

## Goals

- Make workflows reusable, visible, user-definable orchestration templates.
- Ship a built-in locked **Engineering** workflow optimized for AI-assisted software delivery.
- Let users create and edit simple custom global workflows in the Workflows tab.
- Let orchestrator chat start and supervise workflow runs for goals.
- Let the orchestrator LLM choose the best model, agent, or human operator for each step/task using available context, readiness, capabilities, risk, cost, and guardrails.
- Keep MVP execution supervised by default: recommend launches and advancement, but require user approval for meaningful execution actions.
- Store workflow artifacts in Orca's database as the source of truth.
- Record decision traces and workflow events so future metrics can plug in without reworking core state.

## Non-Goals

- Full autonomous execution.
- Auto-launching agents without approval.
- Per-goal workflow template overrides.
- Complex visual DAG workflow builder.
- Cross-goal workflows.
- External GitHub/Jira sync.
- Advanced policy language.
- Metrics dashboard.
- Self-adapting workflows.
- Agent performance optimization.

## Product Model

### Workflow Template

A global reusable definition. Templates may be built-in or custom.

MVP templates use linear steps. More complex branching can come later.

Templates define:

- name and description
- ordered steps
- expected inputs and outputs
- guardrails
- validation expectations
- operator-selection guidance
- advancement rules

### Workflow Run

A goal-scoped execution of a workflow template.

Runs track:

- selected workflow template and version
- current step
- step run statuses
- artifacts
- decisions
- selected/recommended operators
- linked tasks, sessions, and validation results
- emitted events

### Workflow Step

A step defines the job to be done, not the exact model or agent that must do it.

Steps define:

- purpose
- required inputs
- required output artifacts
- gate type
- recommended capabilities
- validation expectations
- advancement criteria

The orchestrator LLM selects the best operator at runtime from registered available operators.

### Workflow Artifact

DB-owned structured output created during a workflow run.

Examples:

- goal brief
- research summary
- PRD
- issue breakdown
- implementation result
- test report
- QA report
- review report
- final summary
- memory update

Artifacts may link to tasks, sessions, files, or future external systems, but DB artifacts are the MVP source of truth.

### Guardrails

Guardrails are user-configurable workflow constraints. MVP guardrails should be simple form controls rather than a full policy language.

Guardrail categories:

- Approval required: ask before launching agents, marking done, risky changes.
- Allowed operators: restrict to selected agents/models/human.
- Risk rules: escalate security/auth/payment/database migrations.
- Validation rules: require tests/typecheck or explicit skip reason.
- Context rules: avoid raw terminal logs; use summaries/artifacts.
- Concurrency rules: max execution tasks at a time; allow/disallow parallel unblocked tasks.
- Cost/speed preference: cheapest sufficient, fastest, best quality.

Guardrails are evaluated before operator selection, task dispatch, step advancement, validation skip, and workflow completion.

## Built-In Engineering Workflow

The Engineering workflow is built-in and locked as the default high-quality reference workflow. Users can duplicate it into an editable custom workflow.

Engineering is linear at the workflow-step level. The Issue Breakdown step creates a task DAG using existing Orca tasks and dependencies.

### 1. Intake / Alignment

Purpose: reach shared understanding before planning.

Matt Pocock mapping: grill-me session.

Behavior:

- Ask the user focused questions one at a time.
- Provide recommended answers when useful.
- Capture decisions, constraints, success criteria, assumptions, unresolved questions.
- Stay human-in-the-loop.

Output artifacts:

- `goal_brief`
- `open_questions` if unresolved questions remain

Exit criteria:

- problem statement exists
- desired outcome exists
- success criteria exist
- known constraints captured
- unresolved questions captured or resolved

### 2. Research

Purpose: understand the repo, architecture, user flow, risks, and module boundaries.

Matt Pocock mapping: repo exploration and codebase understanding.

Behavior:

- Use available workspace context and optionally an agent/model for research.
- Identify relevant files, existing implementation, architecture constraints, dependencies, and risks.
- Identify likely deep module boundaries and meaningful test boundaries.

Output artifact:

- `research_summary`

Exit criteria:

- relevant files identified
- current implementation summarized
- dependencies and risks captured
- unknowns captured
- likely implementation area and module boundaries identified

### 3. PRD / Destination

Purpose: turn alignment and research into a buildable destination document.

Matt Pocock mapping: PRD as destination document.

Behavior:

- Generate a PRD artifact from the goal brief and research.
- Capture user stories, non-goals, implementation decisions, testing decisions, and definition of done.
- Avoid over-optimizing the PRD; QA/review loops carry much of the quality burden.

Output artifact:

- `prd`

Exit criteria:

- problem and solution stated
- user stories or behavior statements exist
- acceptance criteria exist
- non-goals exist
- implementation and testing decisions captured
- definition of done exists

### 4. Issue Breakdown

Purpose: convert the destination into independently grabbable vertical-slice tasks.

Matt Pocock mapping: PRD to Kanban/issue graph.

Behavior:

- Generate Orca tasks from the PRD.
- Prefer vertical slices/tracer bullets over horizontal layer-by-layer work.
- Use existing task dependencies to create a DAG.
- Each task should be small enough for a bounded agent session.
- Each task should include acceptance criteria and validation steps.
- Each task should include recommended capabilities and role fit.

Output:

- task DAG
- `issue_breakdown` artifact

Exit criteria:

- work split into clear tasks
- dependencies explicit
- first vertical slice reaches user/test-visible behavior where possible
- validation expectations exist
- suggested role/capabilities exist for each task

### 5. Execution

Purpose: recommend and supervise bounded agent work.

Matt Pocock mapping: AFK implementation loop / Ralph loop.

Behavior:

- Find next unblocked task(s).
- Select the best operator from registered available operators.
- Check readiness.
- Prepare prompt/context package.
- Ask user to approve launch in MVP.
- Capture session result and validation output.

Output artifacts:

- `implementation_result`
- `test_report` when applicable

Exit criteria:

- assigned task completed or blocked with reason
- changed files summarized when applicable
- validation run or skipped with reason
- failures captured

### 6. QA

Purpose: apply human product judgment and taste before accepting the work.

Matt Pocock mapping: human QA / taste gate.

Behavior:

- Human-led QA with Orca-generated checklist.
- AI may assist, but human judgment is the gate.
- QA failures create new tasks back into the task DAG.

Output artifact:

- `qa_report`

Exit criteria:

- acceptance criteria checked
- passing/failing items recorded
- bugs/gaps captured
- rework required or not required is explicit

### 7. Fresh-Context Review

Purpose: review in a separate context instead of degraded implementer context.

Matt Pocock mapping: separate review agent in fresh context.

Behavior:

- Select reviewer operator based on risk, context needs, and readiness.
- Push relevant standards/guardrails to reviewer.
- Include PRD, research summary, implementation result, QA report, validation report, and relevant diff/context.
- Review architecture quality, maintainability, test gaps, and production readiness.
- Blocking review findings create new tasks in the DAG.

Output artifact:

- `review_report`

Exit criteria:

- architecture drift assessed
- test gaps assessed
- maintainability risks captured
- blocking issues identified or ruled out
- follow-up tasks created where needed

### 8. Done

Purpose: finalize durable outcome and memory.

Matt Pocock mapping: finalize, merge/share with team, preserve useful context.

Behavior:

- Summarize what happened, what changed, validation status, decisions, and follow-ups.
- Promote durable memory where useful.
- Avoid stale-doc poisoning by treating workflow artifacts as historical run records, not evergreen source docs.

Output artifacts:

- `final_summary`
- `memory_update`

Exit criteria:

- final result summarized
- important decisions captured
- follow-up work captured
- goal marked complete or left active with explicit remaining work

## Operator Selection

The workflow step defines the work and constraints. The orchestrator LLM chooses the best operator.

Operators may include:

- Claude Code
- Codex
- Gemini CLI
- OpenCode
- GPT-backed model/operator
- future registered agents/models
- human user

Selection inputs:

- current workflow step
- task/artifact type
- required capabilities
- available registered operators
- readiness status
- workspace/repo access needs
- context size needs
- risk level
- cost/speed preference
- prior artifacts
- validation state
- workflow guardrails

Structured output:

```ts
type OperatorSelection = {
  operatorId: string;
  operatorKind: "agent" | "model" | "human";
  reason: string;
  requiredCapabilities: string[];
  alternativesConsidered: string[];
  confidence: number;
  requiresUserApproval: boolean;
};
```

Guardrails:

- choose only registered/available operators
- explain why the operator fits
- request approval before launching an agent in MVP
- pause when no suitable operator is ready
- workflow definitions may recommend capabilities/operators, but the orchestrator decides unless a human gate is required

## Decision Traceability

Visibility is core to the product. Users should see how workflow structure, artifacts, guardrails, task state, and operator readiness influence decisions.

Every orchestrator decision should store a lightweight trace.

```ts
type WorkflowDecisionTrace = {
  decisionId: string;
  workflowRunId: string;
  stepRunId: string;
  decisionType: string;
  selectedAction: string;
  reason: string;
  influencedBy: Array<{
    kind:
      | "workflow_step"
      | "guardrail"
      | "artifact"
      | "task_state"
      | "operator_readiness"
      | "user_input";
    id: string;
    label: string;
    effect:
      | "required"
      | "blocked"
      | "preferred"
      | "disallowed"
      | "satisfied"
      | "missing";
  }>;
  alternativesConsidered?: string[];
  confidence?: number;
  createdAt: string;
};
```

UI examples:

- "Required by: Engineering > Fresh-Context Review"
- "Blocked by: Guardrail requires validation before Done"
- "Preferred because: Codex ready + execution task + repo editing required"
- "Missing: QA report artifact"
- "Disallowed by: workflow allows only ready registered operators"

This is not a metrics dashboard. It is decision transparency and future metrics plumbing.

## UI Requirements

### Workflows Tab

Users can:

- view built-in Engineering workflow
- view custom global workflows
- create/edit custom workflows
- duplicate the built-in Engineering workflow into a custom workflow
- add/remove/reorder linear steps
- configure step name, purpose, inputs, outputs, gate type, recommended capabilities, and validation expectations
- configure guardrails with simple toggles/selects/rule rows
- see whether a workflow is built-in/locked or custom/editable

Engineering can expose richer built-in behavior than custom workflows, but its structure and guardrails should be visible.

### Orchestrator Chat

Chat can:

- accept a user goal
- create/select a Goal
- recommend a workflow, usually Engineering for software work
- start a workflow run after confirmation
- show current workflow, step, status, artifacts, selected/recommended operator, and next action
- ask alignment or blocking questions one at a time
- capture answers as artifacts/decisions
- recommend agent launch instead of auto-launch in MVP
- explain operator selection and workflow influence

Chat does not author workflow templates.

### Goal Detail

Goal detail should show:

- active workflow run
- current step
- completed steps
- artifacts
- next recommended action
- "why this action" decision trace
- task DAG from Issue Breakdown
- linked sessions and validation results

## API / Contract Requirements

Add shared contract schemas and daemon endpoints for:

- list workflow templates
- get workflow template
- create/update custom workflow template
- duplicate workflow template
- list workflow runs for a goal
- start workflow run for a goal
- get workflow run
- submit workflow user input
- create/list workflow artifacts
- request next orchestrator decision
- accept/reject recommended workflow action

Contracts should include:

- `WorkflowTemplate`
- `WorkflowStepTemplate`
- `WorkflowGuardrail`
- `WorkflowRun`
- `WorkflowStepRun`
- `WorkflowArtifact`
- `OperatorSelection`
- `WorkflowDecisionTrace`
- request/response schemas for workflow routes

## Data Model Guidance

Suggested tables:

- `workflow_templates`
- `workflow_template_steps`
- `workflow_template_guardrails`
- `workflow_runs`
- `workflow_step_runs`
- `workflow_artifacts`
- `workflow_decisions`

Templates should include a version or revision field so future metrics can distinguish decisions made under different workflow definitions.

Runs should store the template version used at run start. Do not silently mutate historical runs when a template changes.

Artifacts should be goal-scoped and optionally linked to workflow run, step run, task, session, and source type.

## Event Requirements

Emit workflow events with enough IDs for future metrics:

- workflow started/completed/paused/blocked
- step started/completed/blocked/skipped
- artifact created
- guardrail evaluated
- operator selected
- user decision requested
- recommended action created/accepted/rejected
- task DAG created/updated
- validation run/passed/failed/skipped

Event payloads should include compact IDs, not raw prompts, raw terminal output, or large artifact bodies.

Include:

- workflow template ID and version
- workflow run ID
- step template ID and step run ID
- guardrail IDs when relevant
- artifact IDs
- selected/rejected operator IDs
- task/session IDs when relevant
- decision ID

## Implementation Notes For Claude Opus

Build in layers:

1. Contracts and database migrations.
2. Workflow template persistence and Engineering seed.
3. Workflow run and step run lifecycle.
4. Artifact persistence.
5. Guardrail representation and validation.
6. Operator selection schema and decision trace persistence.
7. Orchestrator decision service that returns structured decisions.
8. Integration with existing goals, tasks, sessions, agents/readiness, and events.
9. Workflows tab UI.
10. Orchestrator chat and goal-detail workflow state.

Reuse existing Orca primitives where possible:

- goals as workflow run parent
- tasks and dependencies for Engineering issue DAG
- agents/readiness for operator availability
- sessions for agent execution
- context packages for session startup context
- events for workflow observability

Keep the daemon runtime authoritative. The orchestrator LLM proposes structured decisions; daemon validation accepts, rejects, or pauses.

## Validation Expectations

Add focused tests for:

- workflow template persistence
- built-in Engineering seed behavior
- custom workflow CRUD
- guardrail validation
- workflow run state transitions
- artifact creation/listing
- operator selection schema validation
- decision trace persistence
- task DAG creation during Engineering Issue Breakdown
- event emission with joinable IDs
- Workflows tab smoke behavior
- active workflow state in orchestrator/goal detail

## Acceptance Criteria

MVP is complete when a user can:

1. Open a Workflows tab and see built-in Engineering.
2. Create and edit a simple custom global workflow.
3. Start Engineering from orchestrator chat for a goal.
4. Move through Intake, Research, PRD, Issue Breakdown, Execution, QA, Review, and Done as tracked workflow steps.
5. Store artifacts for each meaningful step.
6. Generate vertical-slice tasks with dependencies during Issue Breakdown.
7. See Orca recommend the best available operator with a structured reason.
8. Approve or reject launch/advance recommendations.
9. Define basic workflow guardrails and see them influence decisions.
10. See which workflow step, artifact requirement, guardrail, task state, operator readiness, or user input influenced a recommendation.
11. See workflow events emitted for start, step changes, artifacts, decisions, guardrail evaluations, operator selection, and completion.
