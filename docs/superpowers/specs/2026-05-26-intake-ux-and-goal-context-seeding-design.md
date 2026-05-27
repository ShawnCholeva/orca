# Intake UX & Goal Context Seeding

**Date:** 2026-05-26  
**Status:** Approved

## Problem

Two friction points in the OrcaChat workflow experience:

1. **Redundant approval gate.** When the orchestrator decides to ask the user a question (`request_user_input`), it surfaces as a `RecommendationCard` requiring an explicit Accept click before the input card appears. This is unnecessary friction — a question prompt needs no approval.

2. **Context blindness.** The user specifies a goal title and description during goal creation. The intake step ignores this and immediately asks "What problem are we solving?" — information Orca already has.

## Goals

- Orca ingests the goal description at workflow start and skips intake criteria it can already satisfy.
- `request_user_input` recommendations show the input card immediately — no Accept gate.
- Approval gates survive only for consequential actions: step advance, session launch, run complete.
- Full intake Q&A loop: Orca asks remaining questions one at a time until all criteria satisfied, then surfaces the step-advance recommendation.

## Ideal Flow (Post-Fix)

```
User creates goal (title + description)
    ↓
Workflow starts (intake step)
    ↓
requestNextDecision()
    → evaluateGoalContextSatisfies: description → goal_brief artifact
    → "goal brief captured" satisfied automatically
    → asks next outstanding question: "What outcome should this optimize for?"
    ↓
Input card appears immediately (no Accept)
User answers → submitWorkflowUserInput()
    ↓
requestNextDecision() → next question
    ↓ (repeat until all criteria satisfied)
    ↓
advance_workflow_step recommendation appears
User clicks Accept → advances to next step
    ↓
repeat loop for remaining steps
```

## Design

### Part 1 — Goal Context Seeding (Daemon)

#### StepRule interface change

Add optional hook to `apps/daemon/src/workflows/steps/rules/types.ts`:

```ts
evaluateGoalContextSatisfies?(
  goal: { title: string; description: string },
  ctx: StepRuleContext
): Array<{
  criterion: string;
  artifact?: { type: WorkflowArtifactType; title: string; body: string };
}>
```

Only called if the criterion is not already in `ctx.satisfiedExitCriteria`. Returns an array so a single hook call can satisfy multiple criteria (future-proofing).

#### Intake rule implementation

In `apps/daemon/src/workflows/steps/rules/intake.ts`, implement `evaluateGoalContextSatisfies`:

- If `goal.description` is non-empty and `"goal brief captured"` not yet satisfied:
  - Return `{ criterion: CRITERIA.brief, artifact: { type: "goal_brief", title: "Goal Brief", body: \`# Problem\n\n${goal.description}\` } }`
- Workspaces criterion (`"relevant workspaces identified"`) is **not** seeded here — workspace data is not available in this context. Future work.

#### OrchestratorService change

In `apps/daemon/src/workflows/orchestrator/service.ts`:

1. Extend `GoalRow` interface to include `title: string` and `description: string`.
2. Extend `readGoal()` SQL to select `title, description` in addition to existing columns.
3. Add `applyGoalContextSatisfaction()` function (parallel to `applyDeterministicRuleSatisfaction()`):
   - Gets the step rule for the current step
   - Calls `rule.evaluateGoalContextSatisfies?.(goal, ctx)`
   - For each returned item: creates the artifact (if provided) via `listArtifactsForRun` + insert, marks the criterion satisfied via `recordExitCriteriaSatisfaction()`
   - Idempotent: the criterion guard in the hook prevents double-application
4. Call `applyGoalContextSatisfaction()` in `requestNextDecision()` after `applyDeterministicRuleSatisfaction()` and before reading `outstanding`. Like `applyDeterministicRuleSatisfaction()`, it returns the updated `StepRunRow` so the service can chain:
   ```ts
   stepRun = applyDeterministicRuleSatisfaction(db, now, stepRun, artifacts);
   stepRun = applyGoalContextSatisfaction(db, now, stepRun, goal, workflowRunId);
   const outstanding = parseOutstanding(stepRun);
   ```

Artifact creation uses the existing artifact insert pattern from `artifacts/usecases.ts`. Source is `"orchestrator"`.

### Part 2 — `request_user_input` Bypass (Frontend)

In `apps/desktop/src/orchestrator/OrcaChat.tsx`:

#### Split recommendation buckets

```ts
const inputRecs = workflowRecommendations.filter(
  (rec) => rec.type === "request_user_input"
);
const actionRecs = workflowRecommendations.filter(
  (rec) => rec.type !== "request_user_input"
);
```

#### Auto-accept + immediate input card

When `inputRecs` is non-empty and `restoredPendingInput` is null:

1. Derive `pendingInput` directly from the first `inputRec`'s `proposedAction` — no API call needed to show the card:
   ```ts
   {
     question: rec.proposedAction.question,
     stepRunId: rec.proposedAction.workflowStepRunId,
     recommendationId: rec.id,
   }
   ```
2. Fire `acceptRecommendation(rec.id, {})` in background (no await) so the server state stays consistent and `findAcceptedPendingInput()` can restore on reload.
3. Do **not** render `inputRecs` in the recommendation card list.

#### RecommendationCard list unchanged

`actionRecs` render as `RecommendationCard` items as before. Approval gates for `advance_workflow_step`, `launch_workflow_session`, `complete_workflow_run` are preserved.

#### Session reload path

`findAcceptedPendingInput()` + `restoredPendingInput` already handles reload correctly — finds the accepted rec and restores the input card. No changes needed there.

### Part 3 — Edge Cases

| Scenario | Behavior |
|---|---|
| Goal created with empty description | Hook returns `[]`; intake starts with "What problem are we solving?" (no regression) |
| Re-render fires `acceptRecommendation()` twice | Server no-ops duplicate accept; recommendation stays `accepted` |
| `requestNextDecision()` called on already-seeded step | Criterion already in `satisfiedExitCriteria`; hook guard prevents duplicate artifact creation |
| Non-intake step rule | No `evaluateGoalContextSatisfies` implementation; service skips silently |
| User refreshes mid-intake | `findAcceptedPendingInput()` finds accepted rec, restores input card |

## Files Changed

**Daemon:**
- `apps/daemon/src/workflows/steps/rules/types.ts` — add `evaluateGoalContextSatisfies` to `StepRule`
- `apps/daemon/src/workflows/steps/rules/intake.ts` — implement `evaluateGoalContextSatisfies`
- `apps/daemon/src/workflows/orchestrator/service.ts` — extend `GoalRow`, add `applyGoalContextSatisfaction()`, call it in `requestNextDecision()`
- `apps/daemon/src/workflows/artifacts/usecases.ts` — may need artifact creation helper callable from service

**Frontend:**
- `apps/desktop/src/orchestrator/OrcaChat.tsx` — split rec buckets, auto-accept + immediate input card for `request_user_input`

**Tests:**
- `apps/daemon/src/workflows/steps/rules/index.test.ts` — intake `evaluateGoalContextSatisfies` with/without description
- `apps/daemon/src/workflows/orchestrator/service.test.ts` — first decision with description skips "problem" question; empty description asks it
- `apps/desktop/src/orchestrator/OrcaChat.test.tsx` — `request_user_input` proposed rec renders input card not RecommendationCard; `acceptRecommendation` called; `advance_workflow_step` rec still renders RecommendationCard

## Out of Scope

- Seeding `"relevant workspaces identified"` from attached workspaces (future work)
- Any changes to the Workflows page template editor
- Matt Pocock-style step redesign (separate initiative)
