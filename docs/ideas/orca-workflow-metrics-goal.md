# Orca Goal: Workflow Metrics and SDLC Measurement

## Goal

Build Orca’s metrics layer so that after orchestration runs, Orca can measure what happened across the workflow, phases, agents, artifacts, validation, cost, and human intervention.

This goal depends on the workflow-driven orchestrator emitting events.

The metrics system should help answer:

- Did the workflow complete successfully?
- Which phase was slow or blocked?
- Which agent performed well?
- Where did rework happen?
- Did validation pass?
- Did QA find issues?
- Was architecture drift introduced?
- How much did the workflow cost?
- How much human intervention was required?
- Which parts of the SDLC are helping or hurting?

---

## Core Product Idea

Orca should not only run workflows.

Orca should observe workflows, score them, and help the user improve their AI-assisted SDLC over time.

The system should make this kind of insight possible:

```txt
Tasks that skipped Research had more QA failures.
Codex performs best on bounded Execution tasks.
Claude Code performs best during Research and Spec phases.
Gemini catches the most architecture drift during Review.
Most rework is caused by weak acceptance criteria in Spec.
```

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

A reusable SDLC process used to complete a Goal.

Examples:

- Feature Development Workflow
- Bugfix Workflow
- Refactor Workflow
- Architecture Review Workflow
- Prototype Workflow

### Workflow Run

One execution of a Workflow for a Goal.

A Goal may have one or many Workflow Runs over time.

### Phase

A step inside a Workflow.

Examples:

- Idea Intake
- Research
- Spec
- Issue Breakdown
- Execution
- QA
- Review
- Done

### Artifact

A durable output created during a phase.

Examples:

- Goal brief
- Research summary
- Spec
- Issue breakdown
- Implementation result
- Test report
- QA report
- Review report
- Final summary
- Memory update

---

## MVP Scope

Build metrics for completed and active workflow runs.

The first version should compute metrics from workflow events, phase runs, artifacts, agent sessions, and validation results.

Do not build a predictive recommendation engine yet.

Do not build agent learning or automatic policy tuning yet.

Do not build perfect scoring. Start with simple, explainable metrics.

---

## Non-Goals

Do not require every metric to be perfect in MVP.

Do not attempt to measure subjective quality without storing the reasoning or evidence.

Do not block orchestration work on advanced dashboards.

Do not use metrics to auto-tune agent routing yet.

Do not build organization-wide analytics yet.

This should start as per-user, per-goal, and per-workflow-run observability.

---

## Required Inputs

This goal assumes the orchestrator emits events such as:

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

Metrics should be derived from the event stream where possible.

---

## Architecture

Build the metrics system around these pieces:

```txt
Workflow Events
Phase Runs
Agent Sessions
Artifacts
Validation Results
Cost Records
        ↓
Metrics Calculator
        ↓
Workflow Metrics
Phase Metrics
Agent Metrics
Quality Metrics
Cost Metrics
Autonomy Metrics
        ↓
Metrics Dashboard
Orchestrator Summaries
Future Routing Insights
```

---

## Metric Categories

The metrics system should support these categories:

```txt
1. Workflow Metrics
2. Phase Metrics
3. Agent Metrics
4. Quality Metrics
5. Validation Metrics
6. Human Intervention Metrics
7. Cost Metrics
8. Context Metrics
9. Artifact Metrics
10. Workflow Health Score
```

MVP should focus on the first seven.

Context and artifact quality can be added once the event and artifact model is stable.

---

## 1. Workflow Metrics

Workflow metrics measure the full Goal or Workflow Run.

Required MVP metrics:

```ts
type WorkflowMetrics = {
  workflowRunId: string;
  goalId: string;
  workflowId: string;

  status: "active" | "completed" | "failed" | "blocked" | "abandoned";

  startedAt: string;
  completedAt?: string;

  totalCycleTimeMinutes?: number;
  completedPhaseCount: number;
  totalPhaseCount: number;

  agentSessionCount: number;
  humanInterventionCount: number;
  validationRunCount: number;
  validationPassCount: number;
  validationFailCount: number;

  reworkLoopCount: number;
  totalEstimatedCostUsd?: number;

  finalOutcome?: "completed" | "partially_completed" | "blocked" | "failed" | "rolled_back";
};
```

Important derived metrics:

```txt
Cycle Time = workflow completed time - workflow started time

Validation Pass Rate = validation pass count / validation run count

Workflow Completion Rate = completed phases / total phases

Human Intervention Count = number of times the workflow asked the user for a decision

Rework Loop Count = number of times a later phase sends work back to an earlier phase
```

---

## 2. Phase Metrics

Phase metrics measure how each SDLC phase performed.

Required MVP metrics:

```ts
type PhaseMetrics = {
  phaseRunId: string;
  workflowRunId: string;
  phaseId: string;

  status: "pending" | "active" | "passed" | "failed" | "skipped" | "blocked";

  startedAt?: string;
  completedAt?: string;
  durationMinutes?: number;

  assignedAgentIds: string[];
  artifactCount: number;
  requiredArtifactCount: number;

  validationRunCount: number;
  validationPassCount: number;
  validationFailCount: number;

  humanInterventionCount: number;
  retryCount: number;
  escalationCount: number;
};
```

Important phase-level insights:

```txt
Which phase took longest?
Which phase required the most human input?
Which phase failed validation most often?
Which phase created the most rework?
Which phase was skipped?
Which phase produced missing artifacts?
```

---

## 3. Agent Metrics

Agent metrics measure how well agents perform by phase and task type.

Do not only measure agents globally.

Agent performance should be measured by phase.

Example:

```txt
Claude Code may be great at Research but slower at Execution.
Codex may be great at Execution but weak at Spec.
Gemini may be useful for Review but not implementation.
```

Required MVP metrics:

```ts
type AgentMetrics = {
  agentId: string;
  phaseId: string;

  tasksAssigned: number;
  tasksCompleted: number;
  tasksFailed: number;

  successRate: number;
  avgCompletionTimeMinutes?: number;

  validationRunCount: number;
  validationPassCount: number;
  validationFailCount: number;

  retryCount: number;
  escalationCount: number;
  humanRescueCount: number;

  estimatedCostUsd?: number;
};
```

Important derived metrics:

```txt
Agent Success Rate = completed tasks / assigned tasks

Agent Validation Pass Rate = passed validations / validation runs

Agent Retry Rate = retries / assigned tasks

Agent Cost Per Completed Task = agent cost / completed tasks
```

---

## 4. Validation Metrics

Validation metrics measure whether the work was verified.

Required MVP metrics:

```ts
type ValidationMetrics = {
  workflowRunId: string;
  phaseRunId?: string;
  agentId?: string;

  validationRunCount: number;
  validationPassCount: number;
  validationFailCount: number;

  commandsRun: string[];
  failedCommands: string[];

  lastValidationStatus?: "passed" | "failed" | "not_run";
};
```

Validation events should track:

- build commands
- test commands
- lint commands
- typecheck commands
- manual QA checks
- review checks

Important derived metrics:

```txt
Validation Pass Rate = validation passes / validation runs

Unvalidated Phase Count = phases completed without validation

Final Validation Status = passed, failed, or not run
```

The orchestrator should never mark a workflow as confidently complete if final validation failed or did not run without explanation.

---

## 5. Human Intervention Metrics

Human intervention metrics measure how autonomous the workflow really was.

Required MVP metrics:

```ts
type HumanInterventionMetrics = {
  workflowRunId: string;

  humanDecisionCount: number;
  approvalGateCount: number;
  clarificationCount: number;
  humanRescueCount: number;

  autonomousActionCount: number;
  totalActionCount: number;

  autonomyRatio: number;
};
```

Important distinction:

Not all human intervention is bad.

The system should distinguish:

```txt
Necessary approvals
Clarifying questions
Emergency rescues
Unnecessary interruptions
```

For MVP, just count human decision events. Later, categorize them.

Derived metric:

```txt
Autonomy Ratio = autonomous successful actions / total actions
```

Be careful: 100% autonomy is not always desirable for production workflows. Production mode may intentionally require human approval gates.

---

## 6. Cost Metrics

Cost metrics measure the economics of orchestration.

Required MVP metrics:

```ts
type CostMetrics = {
  workflowRunId: string;

  totalCostUsd: number;
  orchestrationCostUsd: number;
  agentExecutionCostUsd: number;
  reviewCostUsd: number;

  costByPhase: Record<string, number>;
  costByAgent: Record<string, number>;

  costPerCompletedPhase?: number;
  costPerCompletedTask?: number;
};
```

Important derived metrics:

```txt
Orchestration Cost Ratio = orchestration cost / total cost

Cost Per Completed Task = total cost / completed execution tasks

Cost Per Completed Workflow = total cost / completed workflow
```

This will help determine whether Claude Haiku is cheap enough as the orchestrator and when escalation to Sonnet or Opus is worth it.

---

## 7. Quality Metrics

Quality metrics measure whether the work was actually good.

MVP should start simple.

Required MVP metrics:

```ts
type QualityMetrics = {
  workflowRunId: string;

  qaBugCount: number;
  reviewFindingCount: number;
  blockingFindingCount: number;

  architectureDriftLevel?: "none" | "low" | "medium" | "high";
  testGapCount: number;

  acceptanceCriteriaCount?: number;
  acceptanceCriteriaVerifiedCount?: number;
};
```

Important derived metrics:

```txt
Acceptance Criteria Coverage = verified acceptance criteria / total acceptance criteria

Blocking Finding Rate = blocking findings / total review findings

QA Defect Count = number of bugs found during QA
```

Architecture drift can start as a review field produced by a review agent.

Example:

```txt
Architecture Drift: Medium

Reasons:
- Added a new pattern instead of using existing abstraction.
- Duplicated workspace lookup logic.
- Added UI state without persistence boundary.
```

Later, Orca can make this more structured.

---

## 8. Artifact Metrics

Artifact metrics measure whether workflow outputs are useful.

This can be a post-MVP enhancement.

Potential metrics:

```ts
type ArtifactMetrics = {
  artifactId: string;
  artifactType: ArtifactType;

  wasRequired: boolean;
  wasCreated: boolean;
  wasUsedByLaterPhase: boolean;

  revisionCount: number;
  completenessScore?: number;
  usefulnessScore?: number;
};
```

Important future metric:

```txt
Artifact Reuse Rate = artifacts referenced by later phases / artifacts created
```

This helps prevent process theater.

A spec is not useful just because it exists. It is useful if Execution, QA, or Review actually used it.

---

## 9. Context Metrics

Context metrics measure whether agents received the right information.

This can be a post-MVP enhancement.

Potential metrics:

```ts
type ContextMetrics = {
  workflowRunId: string;

  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;

  contextArtifactsLoaded: number;
  contextArtifactsReferenced: number;

  missingContextIncidents: number;
  irrelevantContextEstimate?: number;

  compressionRatio?: number;
};
```

Important future insight:

```txt
Codex failed twice because it did not receive the Research Summary.
Recommendation: include Research Summary automatically in Execution prompts.
```

---

## Workflow Health Score

Create a simple workflow health score after the basic metrics exist.

The score should be explainable.

Example shape:

```ts
type WorkflowHealthScore = {
  workflowRunId: string;

  overall: number;

  deliveryProgress: number;
  validation: number;
  quality: number;
  autonomy: number;
  costEfficiency: number;
  architectureQuality: number;

  summary: string;
  mainIssues: string[];
};
```

Suggested scoring categories:

```txt
Delivery Progress
- Did the workflow complete?
- How many phases passed?

Validation
- Did tests/build/lint pass?
- Was final validation run?

Quality
- Were QA bugs found?
- Were blocking review findings found?

Autonomy
- Did the workflow require many human rescues?
- Were interruptions reasonable?

Cost Efficiency
- Was cost proportional to completed work?
- Did escalation happen too often?

Architecture Quality
- Was architecture drift low?
- Were maintainability issues low?
```

Example dashboard output:

```txt
Workflow Health: 78/100

Main issue:
QA found gaps because the Spec did not define failed-agent onboarding states.

Strengths:
- Research completed successfully
- Execution passed validation
- No human rescue was needed

Risks:
- 2 acceptance criteria remain unverified
- Review found medium architecture drift
```

---

## Metrics Dashboard Requirements

Create a basic workflow metrics view.

For a selected workflow run, show:

```txt
Goal
Workflow
Status
Current phase or final phase
Started time
Completed time
Total duration
Cost
Validation status
Human intervention count
Agent sessions
Phase breakdown
```

Example UI:

```txt
Goal: Agent Readiness Checks
Workflow: Feature Development
Status: In QA

Cycle Time:
- Started: 10:12 AM
- Active duration: 1h 18m

Cost:
- Total: $3.42
- Orchestration: $0.16
- Execution: $2.31
- Review: $0.95

Validation:
- Runs: 4
- Passed: 3
- Failed: 1
- Current: Passing

Autonomy:
- Human decisions: 2
- Human rescues: 0

Phase Progress:
Idea Intake        Complete
Research           Complete
Spec               Complete
Issue Breakdown    Complete
Execution          Complete
QA                 Active
Review             Pending
Done               Pending
```

---

## Phase Metrics UI

Show a phase breakdown table:

```txt
Phase             Status       Agent         Duration    Validations    Human Input
Idea Intake       Complete     Haiku         4m          0              1
Research          Complete     Claude Code   12m         0              0
Spec              Complete     Sonnet        9m          0              1
Issue Breakdown   Complete     Haiku         3m          0              0
Execution         Complete     Codex         31m         3              0
QA                Active       Gemini        8m          1              0
Review            Pending      -
Done              Pending      -
```

---

## Agent Metrics UI

Show agent performance by phase:

```txt
Agent        Phase          Tasks   Success   Avg Time   Validation Pass   Cost
Claude Code  Research       4       100%      13m        N/A               $1.20
Codex        Execution      6       83%       24m        78%               $4.70
Gemini       Review         3       100%      8m         N/A               $0.90
Haiku        Orchestration  18      100%      20s        N/A               $0.12
```

---

## Event-to-Metric Mapping

The metrics calculator should derive metrics from workflow events.

Examples:

```txt
WORKFLOW_STARTED + WORKFLOW_COMPLETED
→ total workflow cycle time

PHASE_STARTED + PHASE_COMPLETED
→ phase duration

TASK_DISPATCHED
→ task count

AGENT_ASSIGNED
→ agent usage per phase

VALIDATION_RUN
→ validation run count

VALIDATION_PASSED
→ validation pass count

VALIDATION_FAILED
→ validation failure count

HUMAN_DECISION_REQUESTED
→ human intervention count

ARTIFACT_CREATED
→ artifact count by phase

ESCALATION event, when added
→ escalation count
```

If an event does not exist yet, add it to the orchestration event stream rather than calculating the metric from unreliable UI state.

---

## Storage Requirements

Metrics can be calculated live from events at first.

Eventually, store snapshots for performance.

Suggested approach:

```txt
MVP:
Calculate metrics dynamically from events.

Later:
Persist metrics snapshots per workflow run.
```

Potential table/model:

```ts
type WorkflowMetricsSnapshot = {
  id: string;
  workflowRunId: string;
  calculatedAt: string;
  metricsJson: unknown;
};
```

---

## Acceptance Criteria

This goal is complete when:

- Orca can calculate workflow-level metrics from workflow events.
- Orca can calculate phase-level metrics.
- Orca can calculate basic agent metrics by phase.
- Orca can calculate validation pass/fail counts.
- Orca can calculate human intervention count.
- Orca can calculate basic cost by workflow, phase, and agent if cost data exists.
- Orca can display a workflow metrics summary in the UI.
- Orca can display a phase breakdown table.
- Orca can display agent performance by phase.
- Orca can identify incomplete validation.
- Orca can show a basic workflow health score or health summary.
- Metrics are derived from workflow events rather than hardcoded UI state.

---

## MVP Metric Set

Start with these metrics only:

```txt
1. Current workflow phase
2. Phase duration
3. Agent assigned per phase
4. Agent success/failure
5. Retry count
6. Human intervention count
7. Validation pass/fail status
8. Files changed, if available
9. Artifact count by phase
10. Cost per phase, if available
11. Cost per agent, if available
12. Rework loop count
```

Advanced metrics can come later:

```txt
Architecture drift
Context efficiency
Artifact reuse rate
Agent specialization scores
Autonomy ratio
Spec churn
QA defect origin
Acceptance criteria coverage
Workflow health trends over time
```

---

## Implementation Guidance

Build in this order:

### Phase 1: Event Coverage

Confirm orchestration emits the required workflow events.

Add missing events if needed.

### Phase 2: Metrics Calculator

Create a service that accepts workflow events and produces:

- workflow metrics
- phase metrics
- agent metrics
- validation metrics
- human intervention metrics

### Phase 3: Metrics API

Expose metrics by:

```txt
workflowRunId
goalId
agentId
phaseId
```

### Phase 4: Metrics UI

Create a workflow metrics dashboard.

Start with simple tables and summary cards.

### Phase 5: Health Summary

Add a simple explainable workflow health score.

Do not overcomplicate scoring. Show the reasons behind the score.

---

## Important Design Principle

Do not measure only activity.

Measure useful progress.

Bad metrics:

```txt
Number of messages
Number of tokens
Number of files touched
Number of agents used
```

Useful metrics:

```txt
Did the phase pass?
Did validation pass?
Did QA find defects?
Did review find architecture drift?
Did the workflow require human rescue?
Did skipped phases cause rework?
Which agent performs best for each SDLC phase?
```

The goal is not to make agents look busy.

The goal is to understand whether Orca is producing better software with less chaos.
