# Brainstorm Phase 5: Result-First Card

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the step-result card lead with the step's actual result (the agent's `summary` + a link to its artifact) instead of the mediator's scoring justification, and demote the quality scores/metrics into a collapsed drawer. This is the direct fix for the original screenshot (metrics-first card).

**Architecture:** `buildApprovalStepResult` (`service.ts:2407`) builds the `WorkflowStepResult` stored in `step_result_json`; the activity projection (`activities/projection.ts:107`) parses it onto `activity.stepResult`; `ActivityThread.tsx:StepResultCard` renders it (today: `stepName` + `outcome.reason`, scores in an expand drawer). We add `resultSummary` + `primaryArtifact` to `WorkflowStepResult`, populate them from the step's output JSON at build time, and rework the card to lead with them.

**Tech Stack:** TypeScript, Zod, Vitest, React. Depends on Phases 1–4 (esp. the Done `artifacts` schema from Phase 1).

---

## File Structure

- `packages/contracts/src/workflows/index.ts` — add optional `resultSummary` + `primaryArtifact` to `WorkflowStepResult`.
- `apps/daemon/src/workflows/orchestrator/service.ts` — in `buildApprovalStepResult`, read the step output and populate the two fields.
- `apps/desktop/src/orchestrator/ActivityThread.tsx` — rework `StepResultCard` to lead with `resultSummary` + artifact link, scores into the drawer.
- Tests alongside each.

---

### Task 1: Add `resultSummary` + `primaryArtifact` to `WorkflowStepResult`

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (`WorkflowStepResult`, ~line 416-426)
- Test: the existing contracts workflows test (add a case), e.g. `packages/contracts/src/workflows/step-template.test.ts` or wherever `WorkflowStepResult` is tested — search for `WorkflowStepResult` tests; if none, add to a sensible workflows test file.

- [ ] **Step 1: Write the failing test**

Add a test that `WorkflowStepResult` accepts the new optional fields and omits them when absent:

```ts
it("accepts an optional resultSummary and primaryArtifact", () => {
  const base = {
    stepId: "s1", stepStatus: "passed", evaluationStatus: "scored",
    successScore: 0.9,
    quality: { outputCompleteness: 0.9, outputCorrectness: 0.9, instructionAdherence: 0.9, downstreamReadiness: 0.9, riskLevel: 0.1 },
    performance: { durationSeconds: 1, retries: 0 },
    outcome: { reason: "ok", producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true },
  };
  expect(WorkflowStepResult.parse(base).resultSummary).toBeUndefined();
  const withExtras = WorkflowStepResult.parse({
    ...base,
    resultSummary: "Recommends Approach A: an app-wide saved-workspaces table.",
    primaryArtifact: { reference: ".orca/specs/2026-06-17-x.md", description: "design spec" },
  });
  expect(withExtras.resultSummary).toContain("Approach A");
  expect(withExtras.primaryArtifact?.reference).toContain(".orca/specs");
});
```

(Confirm the exact required fields of `WorkflowStepResult` / its sub-objects from the contract and match them in `base` so the parse succeeds. Use the real enum values for `stepStatus`/`evaluationStatus`.)

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/contracts test` (filter to the file you added the test to)
Expected: FAIL — `.strict()` strips/rejects the unknown keys, so the assertions fail.

- [ ] **Step 3: Implement**

In `WorkflowStepResult` (keep `.strict()`), add after `outcome`:

```ts
    outcome: WorkflowStepResultOutcome,
    resultSummary: z.string().max(2000).optional(),
    primaryArtifact: z
      .object({ reference: z.string().max(1024), description: z.string().max(512) })
      .strict()
      .optional(),
  })
  .strict();
```

- [ ] **Step 4: Run, verify PASS**

Run: the same test command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/<test file>
git commit -m "feat(contracts): add resultSummary + primaryArtifact to WorkflowStepResult

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Populate `resultSummary` + `primaryArtifact` from the step output

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`buildApprovalStepResult`, ~line 2407)
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (or the closest test exercising approval result building)

**Context:** `buildApprovalStepResult(db, ctx, scoring, finishedAt)` returns the scored `WorkflowStepResult`. The step's output JSON is readable via `this.readStepOutputAsRecord(db, runId, stepRunId)` (service.ts:3128) — it returns the parsed output record (with `summary`, and for Done `artifacts: [{type, reference, description}]`). After building the scored result, attach:
- `resultSummary` = the output's `summary` (string) if present.
- `primaryArtifact` = the first `artifacts` entry with `type === "spec"` (fallback: first artifact) mapped to `{ reference, description }`, if present.

The other builders (`buildEvaluationFailedStepResult`, `replayEvaluationFailedResult`) leave both undefined (optional) — no change needed there.

- [ ] **Step 1: Write the failing test**

Add a test that drives an approval-completion for a step whose step_output record has `summary: "Recommends Approach A"` and `artifacts: [{ type: "spec", reference: ".orca/specs/x.md", description: "spec" }]`, then reads the persisted `step_result_json` (or the built result) and asserts `resultSummary === "Recommends Approach A"` and `primaryArtifact.reference === ".orca/specs/x.md"`. Reuse the existing approval/`setupAgentStepRun` harness; write the step_output artifact the way the suite does (a `workflow_artifacts` row of `type='step_output'` with the JSON body), then trigger the approval path that calls `buildApprovalStepResult`.

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: FAIL — resultSummary/primaryArtifact are undefined.

- [ ] **Step 3: Implement**

In `buildApprovalStepResult`, after computing the scored `result` (the `buildScoredStepResult(...)` return) and BEFORE returning it, read the output and attach the fields. Replace the `return buildScoredStepResult(facts, proposal.data);` with:

```ts
    if (proposal.success) {
      const result = buildScoredStepResult(facts, proposal.data);
      return this.withResultSummary(db, ctx.stepRun, result);
    }
```

Add a private helper:

```ts
  /** Attaches the step's own output summary + primary artifact to a built result,
   *  so the result card can lead with the result rather than the scoring reason. */
  private withResultSummary(
    db: Database.Database,
    stepRun: StepRunRow,
    result: WorkflowStepResult,
  ): WorkflowStepResult {
    const output = this.readStepOutputAsRecord(db, stepRun.workflow_run_id, stepRun.id);
    if (!output) return result;
    const summary = typeof output.summary === "string" ? output.summary : undefined;
    const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
    const specLike = artifacts.find(
      (a) => a && typeof a === "object" && (a as { type?: unknown }).type === "spec",
    ) ?? artifacts[0];
    const primaryArtifact =
      specLike && typeof specLike === "object"
        ? (() => {
            const ref = (specLike as { reference?: unknown }).reference;
            const desc = (specLike as { description?: unknown }).description;
            return typeof ref === "string"
              ? { reference: ref, description: typeof desc === "string" ? desc : "" }
              : undefined;
          })()
        : undefined;
    return {
      ...result,
      ...(summary ? { resultSummary: summary } : {}),
      ...(primaryArtifact ? { primaryArtifact } : {}),
    };
  }
```

(Confirm `StepRunRow` exposes `workflow_run_id` — it's used elsewhere in the file. Confirm `readStepOutputAsRecord`'s return type/shape and adapt the access. Keep all defensive.)

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test service.agent-step`

- [ ] **Step 5: Regression + typecheck**

Run: `pnpm --filter @orca/daemon test workflows/orchestrator` (PASS), `pnpm --filter @orca/daemon typecheck` (PASS).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(orchestrator): carry step output summary + artifact onto the step result

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Rework `StepResultCard` to lead with the result

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx` (`StepResultCard`, lines ~62-99)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

**Context:** Today the card shows `stepName`, `stepStatus`, score %, handoff badge, then `outcome.reason` and the counts always-visible, with quality metrics + performance behind the expand toggle. Rework so the **result leads** and the **scores are all in the drawer**:
- Headline: `stepName` + the **`resultSummary`** (fall back to `outcome.reason` when `resultSummary` is absent — e.g. evaluation-failed results).
- If `primaryArtifact` is present, render a link/button "View spec" (or `primaryArtifact.description`) showing `primaryArtifact.reference`. (A plain element is fine; opening it is out of scope — render the reference as text/title.)
- Move into the existing `open` drawer (everything that is currently always-visible OR already in the drawer): the score %, handoff badge, `outcome.reason`, the counts line, quality metrics, and performance. Keep the expand toggle button ("Details"/"Hide").

- [ ] **Step 1: Write the failing test**

In `ActivityThread.test.tsx` (mirror existing `StepResultCard` tests), render a `StepResultCard` whose `activity.stepResult` has `resultSummary: "Recommends Approach A"`, `primaryArtifact: { reference: ".orca/specs/x.md", description: "design spec" }`, and the usual scores. Assert:
- the result summary text is visible WITHOUT expanding (query by text),
- the spec reference (".orca/specs/x.md") is rendered,
- the quality score percentages are NOT visible until the expand toggle is clicked (and ARE after clicking),
- a result WITHOUT `resultSummary` falls back to showing `outcome.reason` as the headline.

Use the existing test's render helper + `data-testid`s (`step-result-card`, `step-result-expand`). Add new `data-testid`s as needed (e.g. `step-result-summary`, `step-result-artifact`).

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/desktop test ActivityThread`
Expected: FAIL — scores are visible unexpanded / no summary headline / no artifact.

- [ ] **Step 3: Implement**

Rework `StepResultCard` (keep `data-testid="step-result-card"` and the expand toggle). Structure:

```tsx
export function StepResultCard({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const r = activity.stepResult;
  if (!r) return null;
  const scored = r.evaluationStatus === "scored";
  const headline = r.resultSummary ?? r.outcome.reason;
  return (
    <div className="step-result-card" data-testid="step-result-card" data-status={r.stepStatus} data-eval={r.evaluationStatus}>
      <div className="step-result-head">
        <span className="step-result-name">{activity.stepName ?? "Step"}</span>
        <button type="button" data-testid="step-result-expand" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Details"}</button>
      </div>
      <div className="step-result-summary" data-testid="step-result-summary">{headline}</div>
      {r.primaryArtifact ? (
        <div className="step-result-artifact" data-testid="step-result-artifact" title={r.primaryArtifact.reference}>
          {r.primaryArtifact.description || "Artifact"}: {r.primaryArtifact.reference}
        </div>
      ) : null}
      {open ? (
        <div className="step-result-details">
          <div className="step-result-state">{r.stepStatus}{scored ? ` · ${pct(r.successScore)} · ${r.outcome.handoffReady ? "Ready for handoff" : "Not ready"}` : " · Evaluation failed"}</div>
          {r.resultSummary ? <div className="step-result-reason">{r.outcome.reason}</div> : null}
          <div className="step-result-counts">
            {r.outcome.producedArtifactsCount} artifacts · {r.outcome.blockingIssuesCount} blockers · {r.outcome.warningsCount} warnings
          </div>
          <dl className="step-result-metrics">
            {scored ? (
              <>
                <div><dt>Output completeness</dt><dd>{pct(r.quality.outputCompleteness)}</dd></div>
                <div><dt>Output correctness</dt><dd>{pct(r.quality.outputCorrectness)}</dd></div>
                <div><dt>Instruction adherence</dt><dd>{pct(r.quality.instructionAdherence)}</dd></div>
                <div><dt>Downstream readiness</dt><dd>{pct(r.quality.downstreamReadiness)}</dd></div>
                <div><dt>Risk level (higher = riskier)</dt><dd>{pct(r.quality.riskLevel)}</dd></div>
              </>
            ) : null}
            <div><dt>Duration</dt><dd>{r.performance.durationSeconds}s</dd></div>
            <div><dt>Retries</dt><dd>{r.performance.retries}</dd></div>
            {r.performance.totalTurns !== undefined ? <div><dt>Total turns</dt><dd>{r.performance.totalTurns}</dd></div> : null}
            {r.performance.toolCalls !== undefined ? <div><dt>Tool calls</dt><dd>{r.performance.toolCalls}</dd></div> : null}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
```

(Match the project's existing styling conventions; reuse class names where they already exist in the stylesheet. If `outcome.reason` duplicates `resultSummary` it's hidden in the drawer only when a `resultSummary` exists — when there's no `resultSummary`, `reason` is the headline and not repeated in the drawer.)

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/desktop test ActivityThread`

- [ ] **Step 5: Regression + typecheck**

Run: `pnpm --filter @orca/desktop test` (or at least the orchestrator UI tests) and `pnpm --filter @orca/desktop typecheck`. Expect PASS. Update any other `StepResultCard` test/snapshot that asserted the old always-visible reason/score layout.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(desktop): lead the step-result card with the result, scores in a drawer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§4):**
- Card renders only when the step is done → unchanged (the `step_result` activity is materialized at completion; the card already only shows for terminal results). ✓
- Leads with the step's `summary` + headline + artifact link → Tasks 1–3 (`resultSummary` = output `summary`; `primaryArtifact` = spec). ✓
- Scores / reason / counts / handoff into a collapsed drawer → Task 3. ✓

**Placeholder scan:** Task 1's `base` object and Task 2's output-record access are directed to the real contract/return shapes (the implementer confirms exact fields); the card JSX in Task 3 is literal. No TBD/TODO.

**Type consistency:** `resultSummary`/`primaryArtifact` are the same names across the contract (Task 1), the daemon populate (Task 2), and the card (Task 3). `primaryArtifact` shape `{ reference, description }` matches between contract and the populate helper. `readStepOutputAsRecord` is the existing reader (service.ts:3128).

**Design notes:**
- `resultSummary` is the step's own `summary` (every Brainstorm step schema has one) — kept generic rather than per-step headline fields, so the cross-cutting card works for all workflows. Falls back to `outcome.reason` for evaluation-failed results that have no output summary.
- Opening the artifact (filesystem/editor) is out of scope — the card renders the reference as text/title. A future enhancement can make it a real link.

---

## Done

Phase 5 completes the 2026-06-17 spec. After this, the full Brainstorm arc is: participatory steps that pause at forks (1–2), a confirmed/persisted spec with a closing summary (3), live reasoning narration (4), and a result-first card (5) — closing the original "I have no idea what happened or what the result is" experience end to end.
