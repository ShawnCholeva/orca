# Step-Type-Aware Verification B1 — Ceiling-Relative Band (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Judge each step's verification band at the bar that fits its kind of work. A step that has no code to run must not be capped at "weak" for "not executing" — its ceiling is grounding/review, and hitting it reads healthy. Ship the honest **label** with the level so there is no transient overclaim.

**Architecture:** The band derivation (`aggregate.ts`) currently marks `strong` only when execution verified the majority — so every no-code step is structurally "weak". B1 makes it **ceiling-relative** using `stepRequiresExecution` (which Orca already computes for the completion gate): a step that requires execution keeps the execution bar; a no-code step's bar is grounding/review. The band **label** becomes step-appropriate in the same change. Daemon-only; score/calibration unchanged; recompute-on-read.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`apps/daemon`).

**Design:** umbrella spec `docs/superpowers/specs/2026-07-19-metrics-health-console-design.md` §4 (Phase B1), with the label-coupling resolved (labels ship WITH B1).

## Global Constraints

- **Ceiling-relative band level** (replaces `executableCount > scoredCount/2`):
  - `requiresExec` step → `strong` iff `executableCount > scoredCount/2` (unchanged).
  - no-code step → `strong` iff `(grounding || independentReview) count > scoredCount/2`.
  - `needs_evidence` iff `scoreValue == null` (unchanged).
  - else `weak`.
- **Step-appropriate band labels** (the pill text; desktop renders `band.label` verbatim):
  | level | requiresExec | no-code |
  |---|---|---|
  | strong | `Run & tested` | `Reviewed` |
  | weak | `Not tested` | `Only self-reported` |
  | needs_evidence | `Not checked yet` | `Not checked yet` |
- `requiresExec` per step = `stepRequiresExecution(templateGuardrails, stepTemplateId) !== null` (from `apps/daemon/src/workflows/orchestrator/requires-execution.ts`), computed in `usecases.ts` and threaded into `computeStepMetrics` as `requiresExecution?: Set<string>` (default empty ⇒ every step judged at the grounding ceiling — safe).
- **No change** to `composedScore`, calibration, coverage, the gate/completion gateways, or `band.level`'s three-value enum. Only the level *derivation* and the *label* change.
- Labels must be jargon-free (`no-jargon.test.tsx` renders the band label).
- Recompute-on-read; no migration; no contract change.

---

### Task 1: Ceiling-relative band level + step-appropriate labels (daemon)

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts` (band derivation ~:496-505; `computeStepMetrics` input gains `requiresExecution?`)
- Modify: `apps/daemon/src/metrics/usecases.ts` (load template guardrails; compute the `requiresExecution` set; pass to `computeStepMetrics`)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts` (+ update `canary.test.ts` / `diagnose.test.ts` band-label expectations)

**Interfaces:**
- Consumes: `stepRequiresExecution(guardrails: WorkflowGuardrailConfig[], stepTemplateId: string): {required:string[]} | null` (import from `../workflows/orchestrator/requires-execution.js`); `WorkflowGuardrailConfig` from `@orca/contracts`.
- Produces: `computeStepMetrics` accepts `requiresExecution?: Set<string>`; band `level` ceiling-relative; band `label` step-appropriate.

- [ ] **Step 1: Write the failing tests**

Add to `aggregate.steps.test.ts` (reuse the file's transition/step-run builders; `stepNames`/`names` already map `"s"`). The key behavioral change: a grounding-only **no-code** step is now **strong "Reviewed"** (was weak).

```ts
it("no-code step at its ceiling (grounding-majority) bands STRONG 'Reviewed'", () => {
  // step "s" with grounding-passed completions, NO sensors; requiresExecution NOT provided (empty)
  const [step] = computeStepMetrics({ transitions: groundingPassedTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d" });
  expect(step.verification.band.level).toBe("strong");
  expect(step.verification.band.label).toBe("Reviewed");
});

it("a step that REQUIRES execution but wasn't executed bands WEAK 'Not tested'", () => {
  const [step] = computeStepMetrics({ transitions: groundingPassedTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d", requiresExecution: new Set(["s"]) });
  expect(step.verification.band.level).toBe("weak");
  expect(step.verification.band.label).toBe("Not tested");
});

it("executed step bands STRONG 'Run & tested' when it requires execution", () => {
  const [step] = computeStepMetrics({ transitions: executableTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d", requiresExecution: new Set(["s"]) });
  expect(step.verification.band.level).toBe("strong");
  expect(step.verification.band.label).toBe("Run & tested");
});

it("self-report-only no-code step bands WEAK 'Only self-reported'", () => {
  const [step] = computeStepMetrics({ transitions: selfReportTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d" });
  expect(step.verification.band.level).toBe("weak");
  expect(step.verification.band.label).toBe("Only self-reported");
});

it("no conclusive verification → needs_evidence 'Not checked yet'", () => {
  const [step] = computeStepMetrics({ transitions: unverifiedTxs("s", 1), stepRuns: passRuns("s", 1), stepNames: names, nowIso, period: "7d" });
  expect(step.verification.band.level).toBe("needs_evidence");
  expect(step.verification.band.label).toBe("Not checked yet");
});
```
(Use the file's existing helpers for grounding-passed / executable / self-report / unverified completions — the same shapes `composed-score.test.ts` uses: grounding = `{verdict:"passed",checks:[{mode:"enforce",result:"passed"}]}`; executable = `sensorsRun:[{kind:"unit"}]` + `oracleAdequacy.sufficient:true`. If a helper doesn't exist, add a small inline builder.)

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @orca/daemon test -- aggregate.steps`. The grounding-only test fails (currently bands weak "Weakly verified").

- [ ] **Step 3: Implement the band derivation**

In `aggregate.ts`, add `requiresExecution?: Set<string>` to the `computeStepMetrics` input; in the per-step loop bind `const requiresExec = input.requiresExecution?.has(stepTemplateId) ?? false;`. Replace the band block (~:496-505):

```ts
    const scoredCount = concScores.length;
    const executableCount = concScores.filter((s) => s.verifiers.executable).length;
    // Ceiling-relative: a step that can't be executed is judged at its best-available
    // verifier (grounding/review), not against an execution bar it could never meet.
    const ceilingCount = requiresExec
      ? executableCount
      : concScores.filter((s) => s.verifiers.grounding || s.verifiers.independentReview).length;
    const bandLevel: "strong" | "weak" | "needs_evidence" =
      scoreValue == null ? "needs_evidence"
      : ceilingCount > scoredCount / 2 ? "strong"
      : "weak";
    const BAND_LABEL = {
      strong: requiresExec ? "Run & tested" : "Reviewed",
      weak: requiresExec ? "Not tested" : "Only self-reported",
      needs_evidence: "Not checked yet",
    } as const;
```
(`verifierMix`/`scoreBreakdown` below are unchanged.)

- [ ] **Step 4: Thread `requiresExecution` from usecases**

In `usecases.ts` `getTemplateMetricsDetail`, load the template's guardrails and compute the set for the current steps:
```ts
import { stepRequiresExecution } from "../workflows/orchestrator/requires-execution.js";
import type { WorkflowGuardrailConfig } from "@orca/contracts";
// near stepNames():
const gRow = db.prepare(`SELECT guardrails_json FROM workflow_templates WHERE id = ?`).get(templateId) as { guardrails_json: string } | undefined;
const guardrails = gRow ? (JSON.parse(gRow.guardrails_json) as WorkflowGuardrailConfig[]) : [];
const requiresExecution = new Set([...stepNamesMap.keys()].filter((id) => stepRequiresExecution(guardrails, id) !== null));
```
Pass `requiresExecution` into the `computeStepMetrics({ … })` call.

- [ ] **Step 5: Run tests to verify they pass** — `pnpm --filter @orca/daemon test -- aggregate.steps` (new pass). Then update the OTHER daemon band-label assertions to the new labels + ceiling semantics:
- `aggregate.steps.test.ts` `deriveInsights` cases and the prior "grounding-only → weak" test — the grounding-only NO-CODE case now bands **strong "Reviewed"** (intended inversion); a case meant to be weak must be self-report-only or execution-required. Adjust each to the new model, preserving intent.
- `canary.test.ts` / `diagnose.test.ts` — update any asserted band label string to the new labels.

- [ ] **Step 6: Full workspace green**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/desktop test && pnpm -w typecheck`. Fix any desktop/contract test that asserts a *derived* old band label (most use hardcoded fixtures that still parse — leave those; only fix real assertions). `no-jargon` must pass with the new labels (they are jargon-free).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/usecases.ts apps/daemon/src/metrics/aggregate.steps.test.ts apps/daemon/src/learning/canary.test.ts apps/daemon/src/learning/diagnose.test.ts
git commit -m "feat(metrics): step-type-aware verification band — ceiling-relative level + honest labels"
```

---

### Task 2: Verify — whole-branch review + live check

- [ ] **Step 1:** Full-workspace deterministic verify (all four packages + typecheck) green.
- [ ] **Step 2:** Whole-branch review (base = commit before Task 1 .. HEAD). Verify: band level ceiling-relative (code = execution bar, no-code = grounding/review bar); labels step-appropriate per the matrix; `requiresExecution` derived from `stepRequiresExecution` on the template guardrails and threaded correctly; **no change to composedScore/calibration/coverage or the band enum**; the grounding-only-no-code inversion (weak→strong) is intended, not a regression; `no-jargon` passes. Feed the ledger's Minor list.
- [ ] **Step 3:** Live check (needs daemon restart — ask user). On Adaptive Delivery: **Triage/Proposal** (no-code, grounded) now read a **green "Reviewed"** band (were amber "Weakly verified"); **Execution** reads **green "Run & tested"**; **Done** (self-report-only) reads amber **"Only self-reported"**; **Clarify** reads **"Not checked yet"**. Screenshot.
- [ ] **Step 4:** Mark B1 complete in the ledger + update `metrics-health-console-redesign.md`. Next: B2.

---

## Self-Review

**Spec coverage:** ceiling-relative level (Task 1 Step 3), step-appropriate labels shipped with it (Step 3 matrix), `stepRequiresExecution` threading (Step 4), the grounding-only inversion + label ripple (Step 5), live confirmation of Triage/Proposal green (Task 2 Step 3). Matches umbrella §4 + the resolved label decision.

**Placeholder scan:** band code + label matrix are complete; test bodies name concrete expected `level`+`label` values. The completion-builder helpers reference the exact shapes used in `composed-score.test.ts` (grounding enforce-check / executable sensors+sufficient / self-report / unverified) — the implementer reuses or inlines them.

**Type consistency:** `requiresExecution?: Set<string>` optional (default empty); `requiresExec: boolean` per step; `stepRequiresExecution(...) !== null` is the boolean source; `BAND_LABEL` keys match the `level` enum; band `label` stays a plain string in the contract (no schema change).
