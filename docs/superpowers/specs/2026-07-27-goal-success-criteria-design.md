# Goal Success Criteria — Design

**Date:** 2026-07-27
**Status:** Approved (brainstorming)
**Branch:** `goal-success-criteria`

## Problem

When creating a Goal, the user provides a **title** and an **intent** (free-text
outcome). There is no way for the user to state, up front, *what makes the goal
successful*. Meanwhile workflow **gates** — the PEV "Verify" phase — judge a
step's output "against the goal and the gate instructions," but the only goal
text a gate ever sees is `goal.intent`. There is no explicit, user-authored
definition of done for the gate to check against.

A `successCriteria` concept already exists in the codebase, but only as the
output of the AI **goal refinement** skill (`goal_refinements.success_criteria`),
and it is *not* threaded into gate evaluation. Users cannot type it directly, and
gates never receive it.

## Goal

1. Let the user type **success criteria** as part of goal creation.
2. Make that user-authored definition of done reach the two parties that need it:
   the **gate** (the judge) and the **step agent** (the doer).

## Decisions (locked during brainstorming)

- **Input shape:** a **structured list** of short discrete criteria — matches the
  existing `successCriteria: string[]` model (max 20 items, ≤200 chars each).
  Not a free-text box.
- **Storage:** a **new `success_criteria` column on the `goals` table**, kept
  cleanly separate from the AI-generated `goal_refinements.success_criteria`.
  (Not reusing `goal_refinements`.)
- **Reach:** thread into the **gate** *and* the **step agent objective**. Both the
  doer and the judge share the same definition of done. (Not full parity with
  every `goal_refinements` consumer.)
- **Required:** at least **1** criterion is required to create a goal.
- **Editing:** **create-only** for now. No edit-after-create
  (`UpdateGoalRequest`) in this scope.

## Non-goals (explicitly out of scope)

- Threading the new field into context assembly, tasks, memory seeding, or
  recommendations — those keep reading `goal_refinements.successCriteria`.
- Editing success criteria after goal creation.
- Any change to the AI refinement path (`goal.refine` skill,
  `goal_refinements`). It is untouched and continues to exist in parallel.

## Design

### 1. Data model — new column on `goals`

- **Migration** (`apps/daemon/migrations/00xx_goal_success_criteria.sql`): add
  `success_criteria TEXT` to the `goals` table, storing a **JSON array of
  strings** (same encoding pattern `goal_refinements.success_criteria` uses).
  **Nullable** so existing rows backfill cleanly and parse as `[]`.
- **Contract** (`packages/contracts/src/index.ts`):
  - `Goal` (read schema): add
    `successCriteria: z.array(z.string().min(1).max(200)).max(20).default([])`.
    The `.default([])` lets pre-existing rows / null columns parse.
  - `CreateGoalRequest` **and** `CreateGoalAndStartWorkflowRequest`: add
    `successCriteria: z.array(z.string().min(1).max(200)).min(1).max(20)`
    (**required, ≥1**).
- **Row mapping** (`apps/daemon/src/goals.ts`):
  - `GoalRow` gains the `success_criteria` column.
  - `rowToGoal` JSON-parses it (null → `[]`).
  - The `INSERT` in `createGoal` persists the JSON-serialized array. Blank /
    whitespace-only items are filtered out before persistence.

### 2. Input UI — structured list in the create flow

- **`apps/desktop/src/create-goal-flow/steps/RoughGoalStep.tsx`**: below the
  intent textarea, add a **"Success Criteria"** section — a list of add/remove
  rows, each a short single-line `<input>`, plus an "+ Add criterion" button.
  Starts with one empty row.
- **`apps/desktop/src/create-goal-flow/state.ts`**: `RoughState` gains
  `successCriteria: string[]`; actions to add / edit / remove a row;
  `proceedToCoordinate` carries the list into the coordinate phase.
- **Required gate:** `canProceed` becomes
  `title.trim() && intent.trim() && ≥1 non-empty criterion`. Empty rows are
  ignored for both the count and submission.
- **`CreateGoalFlow.tsx` / `apps/desktop/src/api.ts`**: pass the trimmed,
  non-empty `successCriteria` through `createGoalAndStartWorkflow`.

### 3. Reach — gate + step agent

- **Gate (the judge):**
  - `GateEvaluationRequest.goal`
    (`packages/contracts/src/workflows/index.ts`) gains
    `successCriteria?: string[]`.
  - `buildGateEvaluationRequest` (`apps/daemon/src/workflows/orchestrator/
    dispatch-engine.ts`, ~line 2095) populates it from `goal.successCriteria`.
  - `composeGateEvaluationPrompt`
    (`.../orchestrator/gate-evaluation.ts`) and the worker variant
    `composeGateWorkerPrompt` (`.../orchestrator/gate-worker.ts`) render a
    **"Success Criteria:"** block when the list is non-empty, instructing the
    gate to judge the step output against each criterion. When the list is
    empty/absent, prompt output is **byte-identical to today**.
- **Step agent (the doer):**
  - `StepExecutionInput.goal` (`.../orchestrator/step-input.ts`) carries
    `successCriteria`.
  - `buildAgentObjective` (`.../orchestrator/agent-objective.ts`) renders the
    same criteria block after the `Goal:` line so the worker knows the
    definition of done. Empty → unchanged.

## Data flow

```
RoughGoalStep (list UI, ≥1 required)
  → CreateGoalFlow submit
  → api.createGoalAndStartWorkflow({ ..., successCriteria })
  → POST create-and-start-workflow  (CreateGoalAndStartWorkflowRequest, min(1))
  → createGoal(): INSERT goals.success_criteria = JSON(criteria)
  → rowToGoal(): goal.successCriteria: string[]
       ├─→ buildAgentObjective()          → worker step prompt  (doer)
       └─→ buildGateEvaluationRequest()    → GateEvaluationRequest.goal
             → composeGateEvaluationPrompt / composeGateWorkerPrompt  (judge)
```

## Testing

- **Contract:** schema tests for `Goal.successCriteria` (default `[]`),
  `CreateGoalRequest` / `CreateGoalAndStartWorkflowRequest` (rejects empty
  array, enforces max 20 / ≤200).
- **Daemon `goals.ts`:** round-trip test — `createGoal` with criteria →
  `rowToGoal` returns the same list; null column → `[]`.
- **Gate prompt:** `composeGateEvaluationPrompt` / `composeGateWorkerPrompt`
  render the criteria block when present; assert **identical output** when
  absent (no behavior drift for existing goals).
- **Objective:** `buildAgentObjective` renders the block when present; identical
  output when absent.
- **UI:** `canProceed` is false until ≥1 non-empty criterion is entered.

## Risks / notes

- **Two parallel `successCriteria`.** `goals.success_criteria` (user-authored)
  and `goal_refinements.success_criteria` (AI-refined) now coexist. They are
  independent by design; gate + step read the goal column only. If a future
  task wants a single merged view, that is a separate decision.
- **Empty-list parity is load-bearing.** Every prompt change must be a no-op
  when the list is empty, so existing goals and existing gate/step behavior are
  provably unchanged (asserted by tests).
