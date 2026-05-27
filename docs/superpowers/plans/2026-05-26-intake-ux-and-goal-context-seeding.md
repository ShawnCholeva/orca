# Intake UX & Goal Context Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At workflow start, seed the intake step's `goal_brief` from the goal description so Orca skips the "What problem are we solving?" question, and remove the Accept gate so `request_user_input` recommendations show their input card immediately.

**Architecture:** Daemon side adds an optional `evaluateGoalContextSatisfies` hook on `StepRule`; the intake rule implements it to produce a `goal_brief` artifact from `goal.description`, and `OrchestratorService.requestNextDecision` applies it (creating the artifact + marking the criterion) before computing outstanding criteria. Frontend side splits workflow recommendations into input vs. action buckets — input recs auto-derive the input card and fire `acceptRecommendation` in the background (guarded to fire once), while action recs keep their approval gates.

**Tech Stack:** TypeScript, better-sqlite3, Fastify (daemon); React + Vitest + Testing Library (desktop). Test runner: `vitest run`.

**Spec:** `docs/superpowers/specs/2026-05-26-intake-ux-and-goal-context-seeding-design.md` (read the `> REVIEW:` callouts — they are folded into the tasks below).

---

## File Structure

**Daemon:**
- `apps/daemon/src/workflows/steps/rules/types.ts` — add `evaluateGoalContextSatisfies` to the `StepRule` interface (type only).
- `apps/daemon/src/workflows/steps/rules/intake.ts` — implement `evaluateGoalContextSatisfies` on `intakeRule`.
- `apps/daemon/src/workflows/orchestrator/service.ts` — extend `GoalRow` + `readGoal`, add `applyGoalContextSatisfaction`, wire it into `requestNextDecision`.

**Frontend:**
- `apps/desktop/src/orchestrator/OrcaChat.tsx` — split rec buckets, guarded auto-accept effect, immediate input card.

**Tests:**
- `apps/daemon/src/workflows/steps/rules/index.test.ts`
- `apps/daemon/src/workflows/orchestrator/service.test.ts`
- `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Run commands:**
- Daemon single file: `pnpm --filter @orca/daemon exec vitest run src/workflows/<path>`
- Desktop single file: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx`

---

## Task 1: Add `evaluateGoalContextSatisfies` to the `StepRule` interface

**Files:**
- Modify: `apps/daemon/src/workflows/steps/rules/types.ts`

This is a pure type addition — no behavior yet. `WorkflowArtifactType` is already imported at the top of the file.

- [ ] **Step 1: Add the optional hook to the `StepRule` interface**

In `apps/daemon/src/workflows/steps/rules/types.ts`, add this method to the `StepRule` interface (place it directly after the `stepTemplateId: string;` line):

```ts
  evaluateGoalContextSatisfies?(
    goal: { title: string; description: string },
    ctx: StepRuleContext
  ): Array<{
    criterion: string;
    artifact?: { type: WorkflowArtifactType; title: string; body: string };
  }>;
```

- [ ] **Step 2: Typecheck the package builds**

Run: `pnpm --filter @orca/daemon exec tsc --noEmit`
Expected: PASS (no errors). The new member is optional, so no existing rule breaks.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/workflows/steps/rules/types.ts
git commit -m "feat(daemon): add evaluateGoalContextSatisfies hook to StepRule"
```

---

## Task 2: Implement `evaluateGoalContextSatisfies` on the intake rule

**Files:**
- Modify: `apps/daemon/src/workflows/steps/rules/intake.ts`
- Test: `apps/daemon/src/workflows/steps/rules/index.test.ts`

The hook guards internally on the brief criterion (REVIEW #5: the guard lives in the hook, not the caller). Body is trimmed to match the manual `evaluateUserInputAsArtifact` flow, and the title is `"Goal Brief (draft)"` for consistency (REVIEW #6).

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `apps/daemon/src/workflows/steps/rules/index.test.ts` (append after the existing top-level `describe`s; it needs no database — the hook is pure):

```ts
describe("intakeRule.evaluateGoalContextSatisfies", () => {
  const baseCtx: StepRuleContext = {
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    artifacts: [],
    satisfiedExitCriteria: [],
    outstandingExitCriteria: [
      "goal brief captured",
      "success outcome captured",
      "constraints captured",
      "relevant workspaces identified",
      "open questions captured",
    ],
  };

  it("seeds a goal_brief artifact from a non-empty description", () => {
    const result = stepRules.intake.evaluateGoalContextSatisfies?.(
      { title: "Speed up checkout", description: "  Make checkout faster  " },
      baseCtx,
    );
    expect(result).toEqual([
      {
        criterion: "goal brief captured",
        artifact: {
          type: "goal_brief",
          title: "Goal Brief (draft)",
          body: "# Problem\n\nMake checkout faster",
        },
      },
    ]);
  });

  it("returns [] when the description is empty or whitespace", () => {
    expect(
      stepRules.intake.evaluateGoalContextSatisfies?.(
        { title: "T", description: "   " },
        baseCtx,
      ),
    ).toEqual([]);
  });

  it("returns [] when the brief criterion is already satisfied", () => {
    expect(
      stepRules.intake.evaluateGoalContextSatisfies?.(
        { title: "T", description: "Make checkout faster" },
        { ...baseCtx, satisfiedExitCriteria: ["goal brief captured"] },
      ),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/steps/rules/index.test.ts -t "evaluateGoalContextSatisfies"`
Expected: FAIL — `stepRules.intake.evaluateGoalContextSatisfies` is `undefined`, so the optional-chained call returns `undefined`, not the expected array.

- [ ] **Step 3: Implement the hook on `intakeRule`**

In `apps/daemon/src/workflows/steps/rules/intake.ts`, add the `evaluateGoalContextSatisfies` method to the `intakeRule` object. Place it directly after the `stepTemplateId: "intake",` line:

```ts
  evaluateGoalContextSatisfies(goal, ctx) {
    const description = goal.description.trim();
    if (description.length === 0) return [];
    if (ctx.satisfiedExitCriteria.includes(CRITERIA.brief)) return [];
    return [
      {
        criterion: CRITERIA.brief,
        artifact: {
          type: "goal_brief",
          title: "Goal Brief (draft)",
          body: `# Problem\n\n${description}`,
        },
      },
    ];
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/steps/rules/index.test.ts -t "evaluateGoalContextSatisfies"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/rules/intake.ts apps/daemon/src/workflows/steps/rules/index.test.ts
git commit -m "feat(daemon): seed goal_brief from goal description in intake rule"
```

---

## Task 3: Apply goal-context seeding in `OrchestratorService.requestNextDecision`

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: `apps/daemon/src/workflows/orchestrator/service.test.ts`

Extends `GoalRow`/`readGoal` to carry `title` + `description`, adds `applyGoalContextSatisfaction` (creates the real artifact via `createArtifact` so downstream steps with `requiredInputs: ["goal_brief"]` aren't blocked — REVIEW #1), and re-lists artifacts after seeding (REVIEW #4). Seeding does not publish to the bus — matching the existing silent `applyDeterministicRuleSatisfaction` pattern; the next recommendation event triggers the frontend refresh (REVIEW #8).

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `apps/daemon/src/workflows/orchestrator/service.test.ts`, inside the existing `describe("OrchestratorService", ...)` (after the last `it`). It defines a local intake-run seeder built on the existing `step`/`seedWorkflow`/`fakeSelector`/`selection`/`recommendationRows` helpers:

```ts
  describe("goal context seeding (intake)", () => {
    function seedIntakeRun(db: Database.Database, description: string): void {
      const intake = step({
        id: "intake",
        ordinal: 0,
        name: "Intake",
        purpose: "Capture the goal brief",
        requiredInputs: [],
        requiredOutputs: ["goal_brief"],
        gateType: "human-input",
        recommendedCapabilities: [],
        recommendedOperatorIds: ["human"],
        exitCriteria: [
          "goal brief captured",
          "success outcome captured",
          "constraints captured",
          "relevant workspaces identified",
          "open questions captured",
        ],
      });
      seedWorkflow(db, { currentStep: intake, outstanding: intake.exitCriteria });
      db.prepare("UPDATE goals SET description = ? WHERE id = 'goal-1'").run(description);
    }

    it("seeds goal_brief from the description and asks the next question", async () => {
      const { db, bus, idFactory } = setup();
      seedIntakeRun(db, "Make checkout faster");
      const service = new OrchestratorService(fakeSelector(selection()));

      const result = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

      expect(result.decision.decisionType).toBe("request_user_input");

      const rows = recommendationRows(db);
      expect(rows).toHaveLength(1);
      const action = JSON.parse(rows[0].proposed_action_json as string) as { question: string };
      expect(action.question).toBe("What outcome should this optimize for?");

      const artifacts = db
        .prepare(
          "SELECT type, title, body, source FROM workflow_artifacts WHERE workflow_run_id = 'run-1'",
        )
        .all();
      expect(artifacts).toEqual([
        {
          type: "goal_brief",
          title: "Goal Brief (draft)",
          body: "# Problem\n\nMake checkout faster",
          source: "orchestrator",
        },
      ]);

      const stepRow = db
        .prepare("SELECT satisfied_exit_criteria_json FROM workflow_step_runs WHERE id = 'step-1'")
        .get() as { satisfied_exit_criteria_json: string };
      expect(JSON.parse(stepRow.satisfied_exit_criteria_json)).toContain("goal brief captured");
    });

    it("asks the problem question when the description is empty", async () => {
      const { db, bus, idFactory } = setup();
      seedIntakeRun(db, "");
      const service = new OrchestratorService(fakeSelector(selection()));

      const result = await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

      const rows = recommendationRows(db);
      const action = JSON.parse(rows[0].proposed_action_json as string) as { question: string };
      expect(action.question).toBe("What problem are we solving?");

      const count = db
        .prepare("SELECT COUNT(*) AS c FROM workflow_artifacts WHERE workflow_run_id = 'run-1'")
        .get() as { c: number };
      expect(count.c).toBe(0);
    });

    it("does not duplicate the goal_brief when the step is already seeded", async () => {
      const { db, bus, idFactory } = setup();
      seedIntakeRun(db, "Make checkout faster");
      const service = new OrchestratorService(fakeSelector(selection()));

      await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
      await service.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });

      const count = db
        .prepare("SELECT COUNT(*) AS c FROM workflow_artifacts WHERE type = 'goal_brief'")
        .get() as { c: number };
      expect(count.c).toBe(1);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.test.ts -t "goal context seeding"`
Expected: FAIL — first test fails because no artifact is created and the question is still "What problem are we solving?" (brief never auto-satisfied).

- [ ] **Step 3: Extend `GoalRow` and `readGoal`**

In `apps/daemon/src/workflows/orchestrator/service.ts`, change the `GoalRow` interface (currently lines 37-41) to:

```ts
interface GoalRow {
  id: string;
  title: string;
  description: string;
  orchestrator_provider: ModelProviderId | null;
  orchestrator_model: string | null;
}
```

And change the `readGoal` SQL (currently line 115) to select the new columns:

```ts
function readGoal(db: Database.Database, goalId: string): GoalRow {
  const row = db
    .prepare(
      "SELECT id, title, description, orchestrator_provider, orchestrator_model FROM goals WHERE id = ?",
    )
    .get(goalId) as GoalRow | undefined;
  if (!row) throw new OrchestratorGoalNotFoundError(goalId);
  return row;
}
```

- [ ] **Step 4: Add the `createArtifact` import**

In `apps/daemon/src/workflows/orchestrator/service.ts`, add this import next to the existing artifacts import (the file already imports `listArtifactsForRun` from `../artifacts/projection.js` on line 13):

```ts
import { createArtifact } from "../artifacts/usecases.js";
```

- [ ] **Step 5: Add the `applyGoalContextSatisfaction` function**

In `apps/daemon/src/workflows/orchestrator/service.ts`, add this module-level function directly after `applyDeterministicRuleSatisfaction` (after its closing brace, ~line 216):

```ts
function applyGoalContextSatisfaction(
  db: Database.Database,
  now: () => string,
  stepRun: StepRunRow,
  goal: GoalRow,
  workflowRunId: string,
  idFactory?: () => string
): StepRunRow {
  const rule = stepRules[stepRun.step_template_id];
  if (!rule?.evaluateGoalContextSatisfies) return stepRun;

  const ctx = ruleContext(stepRun, listArtifactsForRun(db, workflowRunId));
  const results = rule.evaluateGoalContextSatisfies(
    { title: goal.title, description: goal.description },
    ctx
  );
  if (results.length === 0) return stepRun;

  const satisfied: string[] = [];
  for (const item of results) {
    if (item.artifact) {
      createArtifact(
        db,
        now,
        {
          goalId: stepRun.goal_id,
          workflowRunId,
          stepRunId: stepRun.id,
          type: item.artifact.type,
          title: item.artifact.title,
          body: item.artifact.body,
          source: "orchestrator",
        },
        idFactory
      );
    }
    satisfied.push(item.criterion);
  }
  recordExitCriteriaSatisfaction(db, now, stepRun.id, satisfied);
  return readStepRun(db, stepRun.id);
}
```

- [ ] **Step 6: Wire it into `requestNextDecision`**

In `apps/daemon/src/workflows/orchestrator/service.ts`, replace the block currently at lines 267-271:

```ts
    const artifacts = listArtifactsForRun(db, workflowRunId);
    stepRun = applyDeterministicRuleSatisfaction(db, now, stepRun, artifacts);
    const goal = readGoal(db, run.goalId);
    const outstanding = parseOutstanding(stepRun);
    const missing = missingInputs(stepTpl, artifacts);
```

with (re-list artifacts after seeding so `missing` is not stale — REVIEW #4):

```ts
    let artifacts = listArtifactsForRun(db, workflowRunId);
    stepRun = applyDeterministicRuleSatisfaction(db, now, stepRun, artifacts);
    const goal = readGoal(db, run.goalId);
    stepRun = applyGoalContextSatisfaction(db, now, stepRun, goal, workflowRunId, options.idFactory);
    artifacts = listArtifactsForRun(db, workflowRunId);
    const outstanding = parseOutstanding(stepRun);
    const missing = missingInputs(stepTpl, artifacts);
```

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.test.ts -t "goal context seeding"`
Expected: PASS (3 tests).

- [ ] **Step 8: Run the full daemon workflow suite to check for regressions**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows`
Expected: PASS (all existing workflow tests still green — `seedGoal` already inserts a non-empty description, but no non-intake step implements the hook, so other steps are unaffected).

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.test.ts
git commit -m "feat(daemon): apply goal context seeding in requestNextDecision"
```

---

## Task 4: Auto-accept `request_user_input` recs in OrcaChat (no Accept gate)

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

Split workflow recs into `inputRecs` (type `request_user_input`) and `actionRecs` (everything else). Input recs derive the input card directly and fire `acceptRecommendation` once via a ref-guarded effect (REVIEW #2). Action recs keep their `RecommendationCard` approval gates. `useRef` and `acceptRecommendation` are already imported.

- [ ] **Step 1: Update the existing `request_user_input` test for the no-gate behavior**

In `apps/desktop/src/orchestrator/OrcaChat.test.tsx`, replace the entire existing test `it("accepts a request_user_input recommendation and submits the answer", ...)` (starts at ~line 391) with this version — it no longer clicks "Accept", expects the input card immediately, and asserts the background accept fired once:

```ts
  it("shows the input card immediately for a request_user_input rec and auto-accepts once", async () => {
    setupRunLoad(workflowRecommendation());
    acceptRecommendationMock.mockResolvedValue({
      recommendation: workflowRecommendation({ status: "accepted" }),
      proposedAction: {
        kind: "request_user_input",
        workflowStepRunId: "step-1",
        question: "What problem are we solving?",
      },
      feedback: {
        id: "fb-1",
        goalId: "goal-1",
        recommendationId: "rec-1",
        action: "accept",
        note: null,
        modifiedPayloadJson: null,
        createdAt: now,
      },
    });
    submitWorkflowUserInputMock.mockResolvedValue({
      stepRun: {
        id: "step-1",
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepTemplateId: "intake",
        ordinal: 0,
        attempt: 1,
        status: "active",
        startedAt: now,
        finishedAt: null,
        blockedReason: null,
        satisfiedExitCriteria: ["goal brief captured"],
        outstandingExitCriteria: [],
      },
    });
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    // No Accept gate: the input card appears without any click.
    expect(await screen.findByText("User input requested")).toBeInTheDocument();
    expect(screen.queryByText("Accept")).toBeNull();

    await waitFor(() => {
      expect(acceptRecommendationMock).toHaveBeenCalledWith("rec-1", {});
    });
    expect(acceptRecommendationMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("Answer the intake question…"), {
      target: { value: "We need a deterministic workflow chat." },
    });
    fireEvent.click(screen.getByText("Submit"));

    await waitFor(() => {
      expect(submitWorkflowUserInputMock).toHaveBeenCalledWith("goal-1", "step-1", {
        stepRunId: "step-1",
        answerText: "We need a deterministic workflow chat.",
      });
    });
  });

  it("keeps the Accept gate for an advance_workflow_step recommendation", async () => {
    setupRunLoad(
      workflowRecommendation({
        type: "advance_workflow_step",
        title: "Advance to research",
        rationale: "Intake complete.",
        proposedAction: {
          kind: "advance_workflow_step",
          workflowRunId: "run-1",
          workflowStepRunId: "step-1",
          toStepTemplateId: "research",
        },
      }),
    );
    const { OrcaChat } = await import("./OrcaChat");

    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);

    expect(await screen.findByText("Accept")).toBeInTheDocument();
    expect(screen.queryByText("User input requested")).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx -t "input card immediately"`
Expected: FAIL — current code renders `request_user_input` as a `RecommendationCard` (so "Accept" is present and the input card only appears after a click), and never auto-fires `acceptRecommendation`.

- [ ] **Step 3: Add the auto-accept ref and clear it on goal change**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`, add a ref next to the other `useRef` (the file already declares `composerFormRef` at ~line 101):

```ts
  const autoAcceptedInputRecs = useRef<Set<string>>(new Set());
```

Then, in the `useEffect` that resets state on `selectedGoalId` change (currently lines 106-112), add a clear call so a new goal re-evaluates input recs:

```ts
  useEffect(() => {
    setActionError(null);
    setPendingInput(null);
    setAnswerDraft("");
    setSessionPrefill(null);
    setMessageError(null);
    autoAcceptedInputRecs.current.clear();
  }, [selectedGoalId]);
```

- [ ] **Step 4: Split the recommendation buckets and add the guarded auto-accept effect**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`, directly after the `workflowRecommendations` declaration (currently lines 267-272) and before `restoredPendingInput`, add the buckets:

```ts
  const inputRecs = workflowRecommendations.filter(
    (recommendation) => recommendation.type === "request_user_input",
  );
  const actionRecs = workflowRecommendations.filter(
    (recommendation) => recommendation.type !== "request_user_input",
  );
```

Then add this effect after the `hasModel` declaration (~line 278), so it runs after `restoredPendingInput` is computed:

```ts
  const firstInputRec = inputRecs[0] ?? null;
  useEffect(() => {
    if (restoredPendingInput) return;
    if (!firstInputRec) return;
    if (firstInputRec.proposedAction.kind !== "request_user_input") return;
    if (autoAcceptedInputRecs.current.has(firstInputRec.id)) return;
    autoAcceptedInputRecs.current.add(firstInputRec.id);
    setPendingInput({
      question: firstInputRec.proposedAction.question,
      stepRunId: firstInputRec.proposedAction.workflowStepRunId,
      recommendationId: firstInputRec.id,
    });
    setAnswerDraft("");
    void acceptRecommendation(firstInputRec.id, {}).catch(() => {
      autoAcceptedInputRecs.current.delete(firstInputRec.id);
    });
  }, [firstInputRec, restoredPendingInput]);
```

- [ ] **Step 5: Switch the card list and empty-state to `actionRecs`**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`, update the three references in the recommendations block (currently lines 548-577) and the empty-state condition (lines 579-587) from `workflowRecommendations` to `actionRecs`:

- Line 548: `{!loading && workflowRecommendations.length > 0 && (` → `{!loading && actionRecs.length > 0 && (`
- Line 551: `Workflow recommendations ({workflowRecommendations.length})` → `Workflow recommendations ({actionRecs.length})`
- Line 554: `{workflowRecommendations.map((recommendation) => (` → `{actionRecs.map((recommendation) => (`
- Lines 579-582: the empty-state guard `workflowRecommendations.length === 0` → `actionRecs.length === 0`

- [ ] **Step 6: Run the updated tests to verify they pass**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx`
Expected: PASS — including the existing "restores the input composer when a request_user_input recommendation was already accepted" test (accepted recs are excluded from `inputRecs` by the active-status filter, so `restoredPendingInput` still comes from `findAcceptedPendingInput`).

- [ ] **Step 7: Typecheck the desktop package**

Run: `pnpm --filter @orca/desktop exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): show input card immediately for request_user_input recs"
```

---

## Final verification

- [ ] **Run both affected suites end to end**

```bash
pnpm --filter @orca/daemon exec vitest run src/workflows
pnpm --filter @orca/desktop exec vitest run src/orchestrator/OrcaChat.test.tsx
```
Expected: all PASS.

- [ ] **Manual smoke (optional, if a dev environment is available):** create a goal with a title + description, start the Engineering workflow, and confirm the first intake prompt is "What outcome should this optimize for?" (not "What problem are we solving?") and that the input card appears with no Accept click.

---

## Notes carried from review (for the implementer)

- **REVIEW #1:** `createArtifact` is used (not a raw insert) so the `goal_brief` artifact is real — `prd`/`research` steps declare `requiredInputs: ["goal_brief"]` and would otherwise block.
- **REVIEW #2:** auto-accept is a ref-guarded effect, fires `acceptRecommendation` once per rec id, never in render.
- **REVIEW #3:** card list + empty state moved to `actionRecs`.
- **REVIEW #4:** `artifacts` is re-listed after seeding so `missingInputs` is not stale.
- **REVIEW #5:** the brief guard lives inside the intake hook; the service does not pre-filter.
- **REVIEW #6:** seeded artifact title is `"Goal Brief (draft)"` to match the manual flow.
- **REVIEW #7 (open decision):** bypassing the card removes reject/dismiss for questions — accepted here as intentional (intake questions are mandatory). Revisit if a skip path is wanted.
- **Out of scope:** seeding `"relevant workspaces identified"`; Workflows page template editor; step redesign.
