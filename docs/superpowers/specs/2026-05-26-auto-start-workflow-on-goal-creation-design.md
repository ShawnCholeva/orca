# Auto-Start Workflow on Goal Creation

**Date:** 2026-05-26  
**Status:** Approved

## Problem

Creating a goal lands the user in the Orchestrator chat with a "Start Engineering Workflow" button. This is an unnecessary step — the workflow should begin automatically as part of goal creation.

## Goals

- Goal creation automatically starts the selected workflow (no extra button click)
- Workflow selection is explicitly required before the goal can be created
- Workflow bootstrap failures block in the modal with a recoverable error state
- "Start Engineering Workflow" card replaced with a recovery-only fallback in OrcaChat

## Non-Goals

- Changing the workflow selector contents (templates come from existing `listWorkflowTemplates`)
- Supporting multiple concurrent workflow runs per goal
- Migrating existing goals that have no workflow run

---

## Design

### 1. Workflow Selection Is Explicitly Required

`CoordinateStep` gates the Create Goal button on `workflowTemplateId !== null`.

`WorkflowSelector` removes the "None" option and adds a disabled placeholder ("Choose workflow…"). There is no default — the user must make an explicit selection. The select value starts empty; the Create Goal button stays disabled until a template is chosen. This is a hard UI requirement, not just validation.

### 2. Single Backend Command

Prefer a single `createGoalAndStartWorkflow` Tauri command that encapsulates goal creation, run creation, and initial orchestrator trigger in one call. The command returns a discriminated result:

```ts
type CreateGoalAndStartWorkflowResult =
  | { ok: true; goalId: string; workflowRunId: string }
  | { ok: false; phase: "createGoal"; error: string }
  | { ok: false; phase: "startWorkflowRun"; goalId: string; error: string }
  | { ok: false; phase: "requestDecision"; goalId: string; workflowRunId: string; error: string };
```

The frontend `useEffect` makes one call and switches on the result phase. If the backend cannot be extended, fall back to three sequential frontend calls (see §2a).

#### 2a. Fallback: Chained Frontend Calls

If `createGoalAndStartWorkflow` is not available, `CreateGoalFlow`'s submitting `useEffect` runs in sequence:

```
1. createGoal(title, description, workspaces, orchestratorModel)
   ↓ failure → submitFailed → back to CoordinateStep (existing behavior)

2. startWorkflowRun(goalId, { goalId, templateId: workflowTemplateId })
   → store goalId + returned workflowRunId immediately on success
   ↓ failure → workflowBootstrapFailed(goalId, workflowRunId: undefined, error)

3. requestNextOrchestratorDecision(goalId, runId, { workflowRunId: runId })
   → workflowRunId already stored from step 2
   ↓ failure → workflowBootstrapFailed(goalId, workflowRunId: runId, error)

4. dispatch(submitSucceeded) + onDone(goalId)
```

The loading spinner ("Creating Goal…") covers the entire sequence.

### 3. State Machine Changes (`state.ts`)

**`SubmittingState`** gains two optional fields:

```ts
type SubmittingState = {
  phase: "submitting";
  goalId?: string;          // set → skip createGoal on retry
  workflowRunId?: string;   // set → skip startWorkflowRun on retry
  // ... existing fields
};
```

When retrying:
- `goalId` set, `workflowRunId` unset → skip `createGoal`, run `startWorkflowRun`
- Both set → skip `createGoal` and `startWorkflowRun`, run only `requestNextOrchestratorDecision`

This makes retries fully idempotent — each step is skipped if its artifact already exists.

**New phase — `WorkflowFailedState`:**

```ts
type WorkflowFailedState = {
  phase: "workflowFailed";
  goalId: string;              // goal was created; don't create again
  workflowRunId?: string;      // set if run was created before failure; skip startWorkflowRun on retry
  title: string;
  description: string;
  pendingWorkspaces: PendingWorkspace[];
  orchestratorModel: OrchestratorModelChoice | null;
  workflowTemplateId: string;  // always non-null (required by step 1)
  error: string;
};
```

**New actions:**

| Action | From | To | Notes |
|---|---|---|---|
| `workflowBootstrapFailed` | `submitting` | `workflowFailed` | carries goalId, optional workflowRunId, error |
| `retryWorkflowStart` | `workflowFailed` | `submitting` | carries goalId + workflowRunId; skips already-completed steps |

### 4. Workflow-Failed Modal Render

When `state.phase === "workflowFailed"`, `CreateGoalFlow` renders:

- Error message: "Goal created but workflow bootstrap failed: [error]"
- **Retry** button — dispatches `retryWorkflowStart`, re-enters submitting with `goalId` (and `workflowRunId` if set), skipping completed steps
- **Open Goal** button — calls `onDone(state.goalId)` directly; workflow can be recovered from the goal detail

### 5. OrcaChat — Recovery-Only No-Run UI

The `!workflowState.run` branch is **simplified, not removed**. Goals created through the old flow may have no workflow run; those need a recovery path.

Replace the full "Start Engineering Workflow" `SystemCard` with a minimal recovery card:

- Title: "No workflow running"
- Body: "This goal has no active workflow run. Start one to begin orchestration."
- Single **Start Workflow** button — opens the workflow selector in a minimal dialog; user must pick a template explicitly (same hard-require as creation flow)

This card is **never shown** for goals created through the updated flow (they always exit `CreateGoalFlow` with a run). It exists only for legacy goals and manual-recovery scenarios.

---

## File Changes

| File | Change |
|---|---|
| `state.ts` | Add `WorkflowFailedState`; extend `SubmittingState` with `goalId?` + `workflowRunId?`; add 2 actions; idempotent retry branching |
| `CreateGoalFlow.tsx` | Call `createGoalAndStartWorkflow` (or chained fallback); store `workflowRunId` as soon as run exists; render `workflowFailed` phase |
| `CoordinateStep.tsx` | Remove "None" from WorkflowSelector; disable Create Goal when `workflowTemplateId === null` |
| `OrcaChat.tsx` | Replace full `!workflowState.run` SystemCard with recovery-only minimal card |
| `state.test.ts` | Add tests for new actions/phases and idempotent retry branching |

---

## Error Handling

| Failure point | Artifacts created | Behavior |
|---|---|---|
| `createGoal` fails | none | `submitFailed` → CoordinateStep (unchanged) |
| `startWorkflowRun` fails | goalId only | `workflowBootstrapFailed(goalId, undefined, error)` → workflowFailed phase |
| `requestNextOrchestratorDecision` fails | goalId + workflowRunId | `workflowBootstrapFailed(goalId, runId, error)` → workflowFailed phase |
| Retry after run exists | goalId + workflowRunId stored | `retryWorkflowStart` → submitting; skips createGoal + startWorkflowRun; only retries requestDecision |
| Retry after no run | goalId stored only | `retryWorkflowStart` → submitting; skips createGoal; retries startWorkflowRun + requestDecision |
