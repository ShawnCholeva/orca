# Auto-Start Workflow on Goal Creation

**Date:** 2026-05-26  
**Status:** Approved

## Problem

Creating a goal lands the user in the Orchestrator chat with a "Start Engineering Workflow" button. This is an unnecessary step — the workflow should begin automatically as part of goal creation.

## Goals

- Goal creation automatically starts the selected workflow (no extra button click)
- Workflow selection is required before the goal can be created
- Workflow-start failures block in the modal with a recoverable error state
- "Start Engineering Workflow" card removed from OrcaChat

## Non-Goals

- Changing the workflow selector contents (templates come from existing `listWorkflowTemplates`)
- Supporting multiple concurrent workflow runs per goal
- Migrating existing goals that have no workflow run

---

## Design

### 1. Workflow Selection Is Required

`CoordinateStep` gates the Create Goal button on `workflowTemplateId !== null`.

`WorkflowSelector` removes the "None" option and adds a disabled placeholder ("Choose workflow…"). The user must make an explicit selection. The select value starts empty; the Create Goal button stays disabled until a template is chosen.

### 2. Submission Chains Three API Calls

`CreateGoalFlow`'s submitting `useEffect` runs all calls in sequence:

```
1. createGoal(title, description, workspaces, orchestratorModel)
   ↓ failure → submitFailed → back to CoordinateStep (existing behavior)

2. startWorkflowRun(goalId, { goalId, templateId: workflowTemplateId })
   ↓ failure → workflowStartFailed(goalId, error) → workflowFailed phase

3. requestNextOrchestratorDecision(goalId, runId, { workflowRunId: runId })
   ↓ failure → workflowStartFailed(goalId, error) → workflowFailed phase

4. dispatch(submitSucceeded) + onDone(goalId)
```

The loading spinner ("Creating Goal…") covers the entire sequence.

### 3. State Machine Changes (`state.ts`)

**`SubmittingState`** gains an optional `goalId?: string`. When set, the `useEffect` skips `createGoal` and goes straight to the workflow calls. This supports retry after workflow-start failure without re-creating the goal.

**New phase — `WorkflowFailedState`:**

```ts
type WorkflowFailedState = {
  phase: "workflowFailed";
  goalId: string;           // goal was created; don't create again
  title: string;
  description: string;
  pendingWorkspaces: PendingWorkspace[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string; // always non-null (required by step 1)
  error: string;
};
```

**New actions:**

| Action | From | To | Notes |
|---|---|---|---|
| `workflowStartFailed` | `submitting` | `workflowFailed` | carries goalId + error |
| `retryWorkflowStart` | `workflowFailed` | `submitting` | carries goalId, skips createGoal |

### 4. Workflow-Failed Modal Render

When `state.phase === "workflowFailed"`, `CreateGoalFlow` renders:

- Error message: "Goal created but workflow failed to start: [error]"
- **Retry** button — dispatches `retryWorkflowStart`, re-enters submitting with `goalId` pre-set
- **Open Goal** button — calls `onDone(state.goalId)` directly; workflow can be started manually from the goal detail

### 5. OrcaChat Cleanup

Remove the `!workflowState.run` branch entirely — the `SystemCard` titled "Engineering workflow ready" and its "Start Engineering workflow" button. This branch is now unreachable for any goal created through the updated flow. No replacement UI is needed; the `WorkflowBanner` and event-stream-driven recommendations surface workflow state once the run exists.

---

## File Changes

| File | Change |
|---|---|
| `state.ts` | Add `WorkflowFailedState`, extend `SubmittingState.goalId?`, add 2 actions |
| `CreateGoalFlow.tsx` | Import `startWorkflowRun` + `requestNextOrchestratorDecision`; extend useEffect; render workflowFailed phase |
| `CoordinateStep.tsx` | Remove "None" from WorkflowSelector; disable Create Goal when `workflowTemplateId === null` |
| `OrcaChat.tsx` | Remove `!workflowState.run` SystemCard block |
| `state.test.ts` | Add tests for new actions/phases |

---

## Error Handling

| Failure point | Behavior |
|---|---|
| `createGoal` fails | `submitFailed` → CoordinateStep (unchanged) |
| `startWorkflowRun` fails | `workflowStartFailed` → workflowFailed phase; Retry or Open Goal |
| `requestNextOrchestratorDecision` fails | Same as above |
| Network recovers, user retries | `retryWorkflowStart` → submitting with goalId; skips createGoal |
