# Intake UX & Goal Context Seeding

**Date:** 2026-05-26  
**Status:** Approved (review notes added 2026-05-26 — see `> REVIEW:` callouts)

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

Returns an array so a single hook call can satisfy multiple criteria (future-proofing).

> REVIEW (#5, wording): The hook is **always** called when a rule exists. The "only if criterion not satisfied" guard lives **inside** the hook (intake checks `!ctx.satisfiedExitCriteria.includes(CRITERIA.brief)`). The caller cannot pre-filter — it does not know which criteria the hook returns until it calls it. Do NOT add a phantom pre-filter in the service.

#### Intake rule implementation

In `apps/daemon/src/workflows/steps/rules/intake.ts`, implement `evaluateGoalContextSatisfies`:

- If `goal.description` is non-empty and `"goal brief captured"` not yet satisfied:
  - Return `{ criterion: CRITERIA.brief, artifact: { type: "goal_brief", title: "Goal Brief (draft)", body: \`# Problem\n\n${goal.description}\` } }`
- Workspaces criterion (`"relevant workspaces identified"`) is **not** seeded here — workspace data is not available in this context. Future work.

> REVIEW (#6, minor): title changed to `"Goal Brief (draft)"` to match the manual flow (`intake.ts:38`). `appendSection` keys on artifact **type**, not title, and picks `.at(-1)`, so append still works either way — but matching titles avoids mixed labels across versions of the same brief.

#### OrchestratorService change

In `apps/daemon/src/workflows/orchestrator/service.ts`:

1. Extend `GoalRow` interface to include `title: string` and `description: string`.
2. Extend `readGoal()` SQL to select `title, description` in addition to existing columns.
3. Add `applyGoalContextSatisfaction()` function (parallel to `applyDeterministicRuleSatisfaction()`):
   - Gets the step rule for the current step
   - Calls `rule.evaluateGoalContextSatisfies?.(goal, ctx)`
   - For each returned item: creates the artifact (if provided), marks the criterion satisfied via `recordExitCriteriaSatisfaction()`
   - Idempotent: the criterion guard in the hook prevents double-application
4. Call `applyGoalContextSatisfaction()` in `requestNextDecision()` after `applyDeterministicRuleSatisfaction()` and before reading `outstanding`. Like `applyDeterministicRuleSatisfaction()`, it returns the updated `StepRunRow` so the service can chain:
   ```ts
   stepRun = applyDeterministicRuleSatisfaction(db, now, stepRun, artifacts);
   stepRun = applyGoalContextSatisfaction(db, now, stepRun, goal, workflowRunId);
   const outstanding = parseOutstanding(stepRun);
   ```

> REVIEW (#1, correctness): Use the existing `createArtifact(db, now, input, idFactory, stagedEvents)` from `artifacts/usecases.ts` — NOT a hand-rolled insert. Raw insert skips the `workflow.artifact.created` event and rule hooks. Input: `{ goalId, workflowRunId, stepRunId: stepRun.id, type, title, body, source: "orchestrator" }`. `"orchestrator"` confirmed valid (`contracts/workflows/index.ts:321`).
> - `createArtifact` runs `onArtifactCreated`/`evaluateArtifactSatisfies`, but the intake rule has **neither**, so it will NOT auto-satisfy `brief`. The explicit `recordExitCriteriaSatisfaction()` call is still required. ✓
> - Seeding the real artifact is **load-bearing**, not cosmetic: `prd`/`research` steps declare `requiredInputs: ["goal_brief"]` (`seed-engineering.ts:39,58`). Marking the criterion without a real `goal_brief` artifact would block those steps on `missingInputs`.
> - Thread `bus`/`stagedEvents` through so the SSE `workflow.artifact.created` fires. If not threaded, the artifact still appears on the next refresh (decision/recommendation events trigger it) — acceptable but less clean.

> REVIEW (#4, latent bug): `requestNextDecision` computes `artifacts` (service.ts:267) and `missing` (271) **before** seeding. Seeding a new artifact leaves both stale. Safe **today** because intake has `requiredInputs: []`, so `missingInputs` is empty. But the hook is on the generic `StepRule` — any future step that implements `evaluateGoalContextSatisfies` AND has `requiredInputs` would wrongly hit `commitMissingInputDecision`. Fix or guard: seed before listing artifacts, or re-list artifacts after seeding. At minimum leave a comment noting the constraint.

Artifact creation uses `createArtifact()` from `artifacts/usecases.ts`. Source is `"orchestrator"`.

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

> REVIEW (#2, correctness): This must run in a **guarded `useEffect`**, not the render body. `inputRecs` is a fresh `.filter()` array every render — firing in render (or an effect keyed on the array) re-POSTs `acceptRecommendation` on every render. The "server no-ops duplicate accept" edge case covers DB state but not the network spray. Guard with a `useRef<Set<string>>` of already-accepted rec ids (or effect dep on `rec.id` + ref guard) so accept fires once per rec.

> REVIEW (#7, decision to confirm): Bypassing the `RecommendationCard` for `request_user_input` removes its reject/dismiss buttons — the input card has Submit only, no skip path. Likely fine (intake questions are mandatory) but make it a deliberate choice.

#### RecommendationCard list unchanged

`actionRecs` render as `RecommendationCard` items as before. Approval gates for `advance_workflow_step`, `launch_workflow_session`, `complete_workflow_run` are preserved.

> REVIEW (#3, wiring): existing references to `workflowRecommendations` must switch to `actionRecs` — the card list (`OrcaChat.tsx:548-577`) and the empty-state condition (`OrcaChat.tsx:579-587`, `workflowRecommendations.length === 0`). Spec describes the split but not the downstream rename.

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

> REVIEW (test gaps):
> - service.test: seeded `goal_brief` artifact is actually **created** (not just criterion marked) + `brief` satisfied + next question is "outcome".
> - service.test: re-entry on an already-seeded step creates **no duplicate** artifact and no duplicate satisfaction (idempotency).
> - OrcaChat.test: `acceptRecommendation` fires **once** across multiple re-renders, not per-render (guards #2).

## Out of Scope

- Seeding `"relevant workspaces identified"` from attached workspaces (future work)
- Any changes to the Workflows page template editor
- Matt Pocock-style step redesign (separate initiative)
