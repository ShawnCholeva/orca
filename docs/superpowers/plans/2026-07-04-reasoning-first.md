# Reasoning-First Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a required, leading `reasoning` field to the five LLM-filled judgment schemas (scoring/gate/refute/split/judge) so the model generates chain-of-thought *before* — and conditioned on — its verdict, and persist that reasoning as inspectable telemetry.

**Architecture:** The behavior lever is the prompt (zod ignores key order at parse), so each schema's prompt literal is reordered to emit `reasoning` first + a reason-first instruction; the schema key order is reordered to match for self-documentation. `reasoning` is added **optional first** (no blast radius), wired through prompts + persistence, then **flipped to required on the five proposal schemas in one dedicated fixture-sweep task**. Persistence rides existing JSON blobs for scoring/refute/judge (no migration) and one additive migration (two nullable columns) for the gate/split decision tables.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), better-sqlite3, Zod (`@orca/contracts`), Vitest, pnpm monorepo (`@orca/daemon`, `@orca/contracts`).

## Global Constraints

- Scope is exactly the **five judgment schemas**: `StepResultScoringProposal`, `GateEvaluationProposal`, `RefuteCompletionProposal`, `SplitEvaluationProposal`, `JudgeInstructionEditProposal`. Do NOT touch narration/output actions, `SynthesisProposal`, `ProposeInstructionRevisionProposal`, or `StepSkillProposal`.
- `reasoning` is a **distinct** field — the existing `reason`/verdict/score fields and their downstream consumers are UNCHANGED. Never rename or repurpose `reason`.
- `REASONING_MAX = 2000` (chars). `reasoning` on the five *proposal* schemas ends **required** (`min(1).max(REASONING_MAX)`); on the persistence records (`WorkflowStepResult`, `RefuteFacet`, `CounterfactualJudgment`) it is `.max(REASONING_MAX)` and **optional/nullable** (engine-constructed verdicts with no proposal carry null reasoning; historical records without it must still parse).
- The lever is the prompt: each prompt literal emits `reasoning` first + a one-line "reason first, then commit the verdict; do not restate the verdict as the reasoning" instruction.
- Deterministic core unchanged — `reasoning` is model-output shaping + telemetry, never a control/routing input.
- Contracts additions are additive; exactly one additive migration (`0054`, two nullable columns); ESM `.js` specifiers; surgical changes.
- Commit on `main`. Every commit: `pnpm --filter @orca/contracts build` + `pnpm --filter @orca/daemon build` green + touched vitest dirs pass.
- End commit bodies with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `packages/contracts/src/workflows/index.ts` — `reasoning` on `StepResultScoringProposal`, `GateEvaluationProposal`, `RefuteCompletionProposal`, `SplitEvaluationProposal`, `WorkflowStepResult`; `REASONING_MAX` (Tasks 1, 5).
- `packages/contracts/src/learning/index.ts` — `reasoning` on `JudgeInstructionEditProposal`, `CounterfactualJudgment` (Tasks 1, 5).
- `packages/contracts/src/harness/index.ts` — `reasoning` on `RefuteFacet` (Task 1).
- Prompts: `orchestrator-llm/prompts.ts`, `workflows/orchestrator/service.ts` (recover-scoring), `gate-evaluation.ts`, `refute-completion.ts`, `learning/judge.ts`, the broker-side `evaluate_split` prompt (Task 2).
- Persistence wiring: `workflows/steps/step-result.ts` + `step-result-scoring.ts`, `workflows/orchestrator/service.ts` (`maybeRefute`), `learning/usecases.ts` (`judgeProposal`) (Task 3); `apps/daemon/migrations/0054_*.sql` + `migrations.ts` + `gates/usecases.ts` + `splitters/usecases.ts` + `dispatch-engine.ts` (Task 4).
- Enforcement + fixture sweep (Task 5); docs (Task 6).

---

### Task 1: Contracts — add `reasoning` (optional) + `REASONING_MAX`

Add `reasoning` as the first key of each of the five proposal schemas, **optional for now** (so nothing breaks), and optional on the three persistence records. Flipped to required on the proposals in Task 5.

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (`StepResultScoringProposal:819`, `GateEvaluationProposal:833`, `RefuteCompletionProposal:866`, `SplitEvaluationProposal:911`, `WorkflowStepResult:480`; add `REASONING_MAX`)
- Modify: `packages/contracts/src/learning/index.ts` (`JudgeInstructionEditProposal:45`, `CounterfactualJudgment:76`)
- Modify: `packages/contracts/src/harness/index.ts` (`RefuteFacet`)
- Test: `packages/contracts/src/workflows/index.test.ts`, `packages/contracts/src/learning/index.test.ts`, `packages/contracts/src/harness/index.test.ts`

**Interfaces:**
- Produces: `export const REASONING_MAX = 2000;`; a `reasoning?: string` field (optional) on all eight schemas above, declared as the first key on the five proposals.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/workflows/index.test.ts`:
```ts
import { REASONING_MAX, RefuteCompletionProposal, GateEvaluationProposal, StepResultScoringProposal, SplitEvaluationProposal, WorkflowStepResult } from "./index.js";
describe("reasoning field (workflows)", () => {
  it("REASONING_MAX is 2000", () => { expect(REASONING_MAX).toBe(2000); });
  it("accepts a reasoning field on each proposal (optional for now)", () => {
    expect(RefuteCompletionProposal.parse({ reasoning: "checked X,Y; no failure", verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] }).reasoning).toBe("checked X,Y; no failure");
    expect(GateEvaluationProposal.parse({ reasoning: "criteria met", outcome: "approved", reason: "ok", inputsConsidered: [] }).reasoning).toBe("criteria met");
    expect(StepResultScoringProposal.parse({ reasoning: "output complete", successScore: 0.9, quality: { outputCompleteness: 1, outputCorrectness: 1, instructionAdherence: 1, downstreamReadiness: 1, riskLevel: 0 }, reason: "done", handoffReady: true }).reasoning).toBe("output complete");
    expect(SplitEvaluationProposal.parse({ reasoning: "branch A fits", selectedBranch: "a", reason: "a", inputsConsidered: [] }).reasoning).toBe("branch A fits");
  });
  it("still parses proposals WITHOUT reasoning (optional in Task 1)", () => {
    expect(GateEvaluationProposal.safeParse({ outcome: "approved", reason: "ok", inputsConsidered: [] }).success).toBe(true);
  });
  it("rejects reasoning over REASONING_MAX", () => {
    expect(RefuteCompletionProposal.safeParse({ reasoning: "x".repeat(2001), verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] }).success).toBe(false);
  });
  it("WorkflowStepResult carries optional reasoning", () => {
    const base = { stepId: "s1", stepStatus: "completed", evaluationStatus: "scored", successScore: 1, quality: { outputCompleteness: 1, outputCorrectness: 1, instructionAdherence: 1, downstreamReadiness: 1, riskLevel: 0 }, performance: { durationSeconds: 1, retries: 0 }, outcome: { reason: "ok", producedArtifactsCount: 0, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true } };
    expect(WorkflowStepResult.parse({ ...base, reasoning: "why" }).reasoning).toBe("why");
    expect(WorkflowStepResult.parse(base).reasoning ?? null).toBeNull();
  });
});
```
Add to `packages/contracts/src/learning/index.test.ts`:
```ts
import { JudgeInstructionEditProposal, CounterfactualJudgment } from "./index.js";
it("JudgeInstructionEditProposal accepts leading reasoning (optional)", () => {
  expect(JudgeInstructionEditProposal.parse({ reasoning: "solved cases hold", verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: [] }).reasoning).toBe("solved cases hold");
  expect(JudgeInstructionEditProposal.safeParse({ verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: [] }).success).toBe(true);
});
it("CounterfactualJudgment carries optional reasoning", () => {
  const j = { verdict: "unavailable", regressionRisk: null, addressesFailureMode: null, regressionCases: [], reason: null, solvedCaseIds: [], failureCaseIds: [], solvedSampleSize: 0, failureSampleSize: 0, judgedAt: "2026-07-04T00:00:00.000Z", judgedAgainstVersion: 1 };
  expect(CounterfactualJudgment.parse(j).reasoning ?? null).toBeNull();
  expect(CounterfactualJudgment.parse({ ...j, reasoning: "why" }).reasoning).toBe("why");
});
```
Add to `packages/contracts/src/harness/index.test.ts`:
```ts
import { RefuteFacet } from "./index.js";
it("RefuteFacet carries optional reasoning", () => {
  const f = { verdict: "refuted", triggered_by: ["no_oracle"], risk_class: "high", reason: "bad", issue_refs: ["x"] };
  expect(RefuteFacet.parse(f).reasoning ?? null).toBeNull();
  expect(RefuteFacet.parse({ ...f, reasoning: "why" }).reasoning).toBe("why");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/contracts exec vitest run src/workflows/index.test.ts src/learning/index.test.ts src/harness/index.test.ts`
Expected: FAIL — `REASONING_MAX`/`reasoning` not present.

- [ ] **Step 3: Add `REASONING_MAX` + the reasoning fields**

In `packages/contracts/src/workflows/index.ts`, add near the other size constants (e.g. after `ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES:49`):
```ts
export const REASONING_MAX = 2000;
```
Add `reasoning: z.string().max(REASONING_MAX).optional()` as the **first key** of `StepResultScoringProposal`, `GateEvaluationProposal`, `RefuteCompletionProposal`, `SplitEvaluationProposal` (place it as the first property inside each `.object({ ... })`). Example for `RefuteCompletionProposal` (`:866`):
```ts
export const RefuteCompletionProposal = z
  .object({
    reasoning: z.string().max(REASONING_MAX).optional(),
    verdict: RefuteVerdict,
    reason: z.string().max(1024),
    issueRefs: z.array(z.string().min(1).max(128)).max(50),
    inputsConsidered: z.array(z.string().min(1).max(128)).max(50),
  })
  .strict();
```
Do the same (first key) for the other three. Then add to `WorkflowStepResult` (`:480`, after `primaryArtifact`):
```ts
    reasoning: z.string().max(REASONING_MAX).nullable().optional(),
```
In `packages/contracts/src/learning/index.ts`: add `reasoning: z.string().max(REASONING_MAX).optional()` as the **first key** of `JudgeInstructionEditProposal` (`:45`), and `reasoning: z.string().max(REASONING_MAX).nullable().optional()` to `CounterfactualJudgment` (`:76`, e.g. after `reason`). Import `REASONING_MAX`: add it to the existing `../workflows/index.js` import.
In `packages/contracts/src/harness/index.ts`: add `reasoning: z.string().max(REASONING_MAX).nullable().optional()` to `RefuteFacet` (after `reason`); import `REASONING_MAX` from `../workflows/index.js` (add the import if absent).

- [ ] **Step 4: Run tests + build**

Run: `pnpm --filter @orca/contracts exec vitest run src/workflows/index.test.ts src/learning/index.test.ts src/harness/index.test.ts && pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon build`
Expected: PASS; BOTH builds clean (optional field ⇒ no daemon break).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src
git commit -m "feat(contracts): reasoning field (optional) + REASONING_MAX on judgment schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Prompts — reasoning-first ordering

Reorder each judgment prompt's example JSON literal so `reasoning` appears first, and add the reason-first instruction. This is the behavior lever.

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/prompts.ts:95,99-103` (approve_step_complete scoring literal)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`composeRecoveryScoringPrompt`, ~`:125-136`)
- Modify: `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts:36` (and the surrounding instruction)
- Modify: `apps/daemon/src/workflows/orchestrator/refute-completion.ts` (`composeRefutePrompt`, the fenced literal ~`:29-32` + instruction)
- Modify: `apps/daemon/src/learning/judge.ts` (`composeJudgePrompt`, the fenced literal + instruction)
- Modify: the broker-side `evaluate_split` prompt (LOCATE — see Step 5)
- Test: the prompt test beside each (`prompts.test.ts`, `refute-completion.test.ts`, `judge.test.ts`, `gate-evaluation.test.ts`); add order assertions.

**Interfaces:** none new — string edits inside existing prompt composers.

- [ ] **Step 1: Add failing order-assertions**

To `apps/daemon/src/workflows/orchestrator/refute-completion.test.ts` (extend the existing prompt test):
```ts
it("emits reasoning before the verdict in the prompt literal", () => {
  const { systemPrompt } = composeRefutePrompt(REQ);
  expect(systemPrompt.indexOf('"reasoning"')).toBeGreaterThan(-1);
  expect(systemPrompt.indexOf('"reasoning"')).toBeLessThan(systemPrompt.indexOf('"verdict"'));
});
```
To `apps/daemon/src/learning/judge.test.ts`:
```ts
it("emits reasoning before the verdict", () => {
  const { systemPrompt } = composeJudgePrompt(REQ);
  expect(systemPrompt.indexOf('"reasoning"')).toBeLessThan(systemPrompt.indexOf('"verdict"'));
});
```
To the gate-evaluation prompt test (locate `composeGatePrompt`/the gate prompt test file; if none exists, add one asserting the composed prompt has `"reasoning"` before `"outcome"`).
To `apps/daemon/src/orchestrator-llm/prompts.test.ts`:
```ts
it("scoring literal lists reasoning before successScore", () => {
  const { systemPrompt } = composeOrchestratorPrompt(BASE_INPUT); // reuse the file's existing input fixture
  expect(systemPrompt.indexOf('"reasoning"')).toBeGreaterThan(-1);
  expect(systemPrompt.indexOf('"reasoning"')).toBeLessThan(systemPrompt.indexOf('"successScore"'));
});
```

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/refute-completion.test.ts src/learning/judge.test.ts src/orchestrator-llm/prompts.test.ts`
Expected: FAIL — `reasoning` not in the literals.

- [ ] **Step 3: Reorder the local prompt literals**

`refute-completion.ts` (`composeRefutePrompt`): change the fenced example line to lead with reasoning, and add a reason-first instruction before it:
```ts
    "Work through the evidence in `reasoning` FIRST, THEN commit to the verdict — do not restate the verdict as the reasoning.",
    "Emit exactly one RefuteCompletionProposal JSON object in one fenced block, nothing after:",
    "```orca:action",
    '{ "reasoning": "...", "verdict": "...", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
    "```",
```
`judge.ts` (`composeJudgePrompt`): same treatment — reasoning first in the literal + a reason-first line:
```ts
    "Fill `reasoning` FIRST (work through solved + failure cases), THEN commit the verdict conditioned on it.",
    "```orca:action",
    '{ "reasoning": "...", "verdict": "...", "regressionRisk": "...", "addressesFailureMode": "...", "regressionCases": [...], "reason": "...", "inputsConsidered": [...] }',
    "```",
```
`gate-evaluation.ts:36`: reorder the literal to `{ "reasoning":..., "outcome":..., "reason":..., "issueRefs":..., "inputsConsidered":... }` + add a "reason first, then outcome" instruction line.
`prompts.ts:95`: reorder the scoring literal to lead with reasoning:
```ts
'- {"kind":"approve_step_complete","scoring":{"reasoning":"<work through the evidence>","successScore":0.0,"quality":{...},"reason":"<short>","handoffReady":true}}  (...)'
```
and add near `:99-102` a line: `"In scoring, fill reasoning FIRST — reason through the evidence before choosing the numbers; then successScore/quality, then the concise reason."`
`service.ts` `composeRecoveryScoringPrompt`: change `"The JSON object has successScore, quality, reason, and handoffReady."` to `"The JSON object has reasoning FIRST, then successScore, quality, reason, and handoffReady."` and, if it embeds an example, reorder it.

- [ ] **Step 4: Run local-literal tests green**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/refute-completion.test.ts src/learning/judge.test.ts src/orchestrator-llm/prompts.test.ts && pnpm --filter @orca/daemon build`
Expected: PASS; build clean.

- [ ] **Step 5: Reorder the broker-side `evaluate_split` prompt**

The split evaluator has no local `composeXPrompt`; its model-facing prompt is composed by the broker for `kind: "evaluate_split"`. Locate it:
```bash
grep -rn "evaluate_split" apps/daemon/src | grep -iv "test\|dispatch-engine\|proposals.ts"
grep -rn "selectedBranch" apps/daemon/src | grep -i "prompt\|instruction\|json\|example"
```
Trace where the `SplitEvaluationProposal` example / field list is presented to the model (the broker's per-kind prompt for `evaluate_split`). Reorder that example to `{ "reasoning": ..., "selectedBranch": ..., "reason": ..., "inputsConsidered": ... }` and add a "reason first, then select the branch" instruction.
**If the broker composes the prompt purely from the zod schema (no hand-written field-order example):** the Task 1 schema key reorder already puts `reasoning` first; in that case add the reason-first guidance to the `SplitEvaluationRequest` payload the engine builds (`dispatch-engine.ts buildSplitEvaluationRequest:1708`), e.g. a `directive: "Fill reasoning first, then selectedBranch."` field if the request schema has room, OR to the splitter node instruction surfaced in the request. Document in the commit which mechanism was used.
Add/extend a splitter prompt test asserting `reasoning` precedes `selectedBranch` in whatever literal the model sees.

- [ ] **Step 6: Run + build + commit**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator src/learning/judge.test.ts src/orchestrator-llm && pnpm --filter @orca/daemon build`
Expected: PASS; build clean.
```bash
git add apps/daemon/src
git commit -m "feat(prompts): reasoning-first ordering on the five judgment prompts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Persistence wiring — blob sinks (scoring / refute / judge)

Thread each proposal's `reasoning` into the record it already writes to an existing JSON blob (no migration).

**Files:**
- Modify: `apps/daemon/src/workflows/steps/step-result.ts:110-128` (`buildScoredStepResult`) and `apps/daemon/src/workflows/orchestrator/step-result-scoring.ts` (`scoreStepResult` — if it builds a `WorkflowStepResult` separately from `buildScoredStepResult`)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`maybeRefute`, the `RefuteFacet` literal ~`:1531`)
- Modify: `apps/daemon/src/learning/usecases.ts` (`judgeProposal`, the `CounterfactualJudgment` construction)
- Test: `step-result` test, `service.refute.test.ts`, `learning/judge-usecase.test.ts`

**Interfaces:**
- Consumes: `reasoning?` on `StepResultScoringProposal`/`RefuteCompletionProposal`/`JudgeInstructionEditProposal` and the optional `reasoning` on `WorkflowStepResult`/`RefuteFacet`/`CounterfactualJudgment` (Task 1).

- [ ] **Step 1: Write the failing tests**

`step-result.ts` test (locate the `buildScoredStepResult` test; add):
```ts
it("threads proposal.reasoning onto the scored result", () => {
  const r = buildScoredStepResult(FACTS, { reasoning: "worked it through", successScore: 1, quality: { outputCompleteness: 1, outputCorrectness: 1, instructionAdherence: 1, downstreamReadiness: 1, riskLevel: 0 }, reason: "ok", handoffReady: true });
  expect(r.reasoning).toBe("worked it through");
});
```
`service.refute.test.ts` (extend an existing refute-runs test): assert the emitted `RefuteFacet` (read `refute_json` on the `step_complete` transition) carries `reasoning` when the fake proposal includes it.
`learning/judge-usecase.test.ts` (extend the happy-path test): the fake judge proposal includes `reasoning`; assert `getProposal(...).judgment?.reasoning` equals it; and the `unavailable`/`insufficient_evidence` cases have `reasoning: null`.

- [ ] **Step 2: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/steps src/workflows/orchestrator/service.refute.test.ts src/learning/judge-usecase.test.ts`
Expected: FAIL — reasoning not threaded.

- [ ] **Step 3: Thread reasoning into each sink**

`buildScoredStepResult` (`step-result.ts:114`): add to the parsed object, after `outcome: {...}`:
```ts
    reasoning: proposal.reasoning ?? null,
```
If `scoreStepResult` (`step-result-scoring.ts`) builds a `WorkflowStepResult` without going through `buildScoredStepResult`, add the same `reasoning: proposal.reasoning ?? null` there.
`maybeRefute` (`service.ts:1531`): add to the `RefuteFacet` literal:
```ts
      reasoning: proposal?.reasoning ?? null,
```
`judgeProposal` (`learning/usecases.ts`): in the `fill`-present branch of the `CounterfactualJudgment`, add `reasoning: fill.reasoning ?? null`; in the `insufficient_evidence` and `unavailable` branches, add `reasoning: null`.

- [ ] **Step 4: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/steps src/workflows/orchestrator/service.refute.test.ts src/learning && pnpm --filter @orca/daemon build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src
git commit -m "feat(reasoning): persist reasoning onto step-result / refute facet / judgment blobs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Persistence — gate & split decision columns (migration 0054)

The gate/split verdicts persist to relational rows with scalar columns, so add a nullable `reasoning` column to each and write it from the recorders + callers.

**Files:**
- Create: `apps/daemon/migrations/0054_decision_reasoning.sql`
- Modify: `apps/daemon/src/migrations.ts` (register after `0053_learning_proposal_judgment.sql`)
- Modify: `apps/daemon/src/workflows/gates/usecases.ts` (`GateDecisionInput` + `recordGateDecision` INSERT)
- Modify: `apps/daemon/src/workflows/splitters/usecases.ts` (`SplitDecisionInput` + `recordSplitDecision` INSERT)
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (the `recordGateDecision` call ~`:2124-2135` and `recordSplitDecision` call ~`:1897-1907` — pass `reasoning: proposal.reasoning ?? null`)
- Test: `apps/daemon/src/migrations.test.ts` + the gate/split recorder tests; **update the stale applied-migration snapshot fixtures** (see Step 2).

**Interfaces:**
- Produces: `reasoning: string | null` on `GateDecisionInput` and `SplitDecisionInput`; columns `workflow_gate_decisions.reasoning`, `workflow_split_decisions.reasoning`.

- [ ] **Step 1: Write the migration + register it**

`apps/daemon/migrations/0054_decision_reasoning.sql`:
```sql
-- Reasoning-first (5.5): persist the model's pre-verdict reasoning on gate/split decisions.
ALTER TABLE workflow_gate_decisions ADD COLUMN reasoning TEXT;
ALTER TABLE workflow_split_decisions ADD COLUMN reasoning TEXT;
```
In `apps/daemon/src/migrations.ts`, add `"0054_decision_reasoning.sql",` to `migrationFiles` immediately after `"0053_learning_proposal_judgment.sql",`.

- [ ] **Step 2: Update migration tests + the enumerating snapshot fixtures**

Add to `apps/daemon/src/migrations.test.ts`:
```ts
it("0054 adds reasoning to gate + split decisions", () => {
  const g = db.prepare("PRAGMA table_info(workflow_gate_decisions)").all() as { name: string }[];
  const s = db.prepare("PRAGMA table_info(workflow_split_decisions)").all() as { name: string }[];
  expect(g.some((c) => c.name === "reasoning")).toBe(true);
  expect(s.some((c) => c.name === "reasoning")).toBe(true);
});
```
**Then update every hardcoded applied-migration list** (this repo breaks otherwise — same class as 0053). Run `grep -rn "0053_learning_proposal_judgment" apps/daemon` and append `"0054_decision_reasoning.sql"` after each `0053` entry in: `migrations.test.ts` (its internal `migrationFiles` snapshot blocks), `apps/daemon/src/migrations/suggested-orchestration.test.ts`, and `apps/daemon/test/migrations-0006.test.ts` (both occurrences). Match each array's exact quote/indent style.

- [ ] **Step 3: Write the recorder failing tests**

To the gate recorder test (locate `recordGateDecision` test; if none, add `apps/daemon/src/workflows/gates/usecases.test.ts`):
```ts
it("persists reasoning on the gate decision", () => {
  const id = recordGateDecision(db, () => "2026-07-04T00:00:00.000Z", { goalId: "g", workflowRunId: "r", nodeId: "n", traversalSeq: 1, outcome: "approved", reason: "ok", reasoning: "criteria met", selectedEdgeTo: "next", inputsConsidered: [], issueRefs: [], ledgerVersion: 1 });
  const row = db.prepare("SELECT reasoning FROM workflow_gate_decisions WHERE id = ?").get(id) as { reasoning: string | null };
  expect(row.reasoning).toBe("criteria met");
});
```
(Mirror for `recordSplitDecision`.)

- [ ] **Step 4: Run to verify red**

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts src/workflows/gates src/workflows/splitters`
Expected: FAIL — `reasoning` column/field absent.

- [ ] **Step 5: Wire the recorders + callers**

`gates/usecases.ts`: add `reasoning: string | null;` to `GateDecisionInput`; add `reasoning` to the INSERT column list + `VALUES` (one more `?`) and bind `input.reasoning` (no `.slice`).
`splitters/usecases.ts`: same for `SplitDecisionInput` + `recordSplitDecision`.
`dispatch-engine.ts`: in the `recordGateDecision({...})` call (~`:2124`) add `reasoning: proposal.reasoning ?? null,` (the automated-gate `proposal` is the `GateEvaluationProposal`); in the `recordSplitDecision({...})` call (~`:1902`) add `reasoning: proposal.reasoning ?? null,`. (Human-park paths that call the recorders with no proposal pass `reasoning: null`.)

- [ ] **Step 6: Run green + build**

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts src/migrations/suggested-orchestration.test.ts test/migrations-0006.test.ts src/workflows/gates src/workflows/splitters src/workflows/orchestrator && pnpm --filter @orca/daemon build`
Expected: PASS; build clean.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon
git commit -m "feat(reasoning): migration 0054 — reasoning on gate/split decisions + recorders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Enforce `reasoning` required on the five proposals + fixture sweep

Flip `reasoning` from optional to required on the five *proposal* schemas (records stay optional). The compiler + parse tests will enumerate every fake-proposal fixture to fix.

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (`StepResultScoringProposal`, `GateEvaluationProposal`, `RefuteCompletionProposal`, `SplitEvaluationProposal`) and `packages/contracts/src/learning/index.ts` (`JudgeInstructionEditProposal`) — `.optional()` → required
- Modify: every daemon/contracts test fixture and any production spot that builds one of these proposal literals (the compiler lists them)
- Test: contracts required-assertions + a representative degradation test

**Interfaces:** `reasoning` becomes required (`z.string().min(1).max(REASONING_MAX)`) on the five proposals; `z.infer` now requires it.

- [ ] **Step 1: Write the required-assertion + degradation tests**

Update the Task 1 contracts tests that asserted "still parses without reasoning" to now assert rejection:
```ts
it("rejects a proposal missing reasoning (now required)", () => {
  expect(GateEvaluationProposal.safeParse({ outcome: "approved", reason: "ok", inputsConsidered: [] }).success).toBe(false);
  expect(RefuteCompletionProposal.safeParse({ verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] }).success).toBe(false);
  expect(JudgeInstructionEditProposal.safeParse({ verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: [] }).success).toBe(false);
});
```
Degradation (representative — refute): in `refute-completion.test.ts`, a fake ask returning a proposal WITHOUT `reasoning` → `refuteStepCompletion` returns `null` after retry (rides the existing null→unavailable terminus):
```ts
it("returns null when the model omits the now-required reasoning", async () => {
  const bad = JSON.stringify({ verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] });
  expect(await refuteStepCompletion(ask(bad), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
});
```

- [ ] **Step 2: Flip required in contracts**

Change each of the five proposal schemas' `reasoning: z.string().max(REASONING_MAX).optional()` → `reasoning: z.string().min(1).max(REASONING_MAX)`. Leave `WorkflowStepResult`/`RefuteFacet`/`CounterfactualJudgment` reasoning OPTIONAL.

- [ ] **Step 3: Let the compiler enumerate the fixture sites, fix each**

Run `pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon build`. The daemon build now errors at every object literal typed as one of the five proposals that lacks `reasoning` (fake model outputs in tests, and any production literal). For EACH reported site, add a plausible `reasoning: "<one-line rationale fitting the case>"`. Re-run the build until clean. Then run the full touched suites:
```bash
pnpm --filter @orca/contracts exec vitest run && pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator src/learning src/orchestrator-llm
```
Fix any runtime parse failures the same way (a fake proposal built via `.parse()`/`safeParse()` at runtime rather than as a typed literal). Do NOT weaken any assertion — only add the `reasoning` field to fixtures.

- [ ] **Step 4: Full green + build**

Run: `pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon build && pnpm --filter @orca/daemon exec vitest run src/workflows src/learning src/orchestrator-llm`
Expected: PASS across the board; builds clean.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/daemon
git commit -m "feat(reasoning): require reasoning on the five judgment proposals + fixture sweep

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Docs — 5.5 landed, Phase 5 complete

**Files:** `ORCA.md`, `FUTURE_WORK.md`, `FUTURE_ARCHITECTURE.md`

- [ ] **Step 1: ORCA.md** — in the orchestrator / harness section, add the reasoning-first discipline: the five judgment schemas (scoring/gate/refute/split/judge) emit a required, leading `reasoning` field so CoT is generated before and conditions the verdict; it is persisted as an inspectable reasoning-trajectory (on `WorkflowStepResult`/`RefuteFacet`/`CounterfactualJudgment` and the gate/split decision rows, migration `0054`), while the crisp `reason`/verdict fields and their consumers are unchanged. Note the honesty caveats: reasoning adds no independence (composes with 5.4's refute + sensors) and is a stated rationale, not verified ground truth.

- [ ] **Step 2: FUTURE_WORK.md** — mark **5.5 ✅ landed (2026-07-04)**; update the at-a-glance line and the Phase-5 header table (`5.5 open` → landed); note **Phase 5 complete**. Update the Phase-5 exit-criterion note if it references 5.5 as open.

- [ ] **Step 3: FUTURE_ARCHITECTURE.md** — in the Inspectable-axis / learning bullet, note the reasoning-trajectory channel now recorded on the verdict schemas (control-plane-pure; bounded per the cost spine).

- [ ] **Step 4: Commit**

```bash
git add ORCA.md FUTURE_WORK.md FUTURE_ARCHITECTURE.md
git commit -m "docs: reasoning-first landed (5.5) — Phase 5 complete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Required leading `reasoning` on the 5 judgment schemas → Task 1 (add optional) + Task 5 (require) + Task 2 (prompt-first).
- Existing `reason`/verdict/consumers unchanged → constrained by Global Constraints; Tasks touch only additive fields.
- Prompt is the lever (zod ignores key order) → Task 2.
- Persistence: additive blobs (scoring/refute/judge) → Task 3; one migration for gate/split → Task 4; records optional + engine-null-reasoning → Task 1 (optional) + Task 3 (null branches).
- Degradation via existing fallback → Task 5 Step 1.
- Historical-parse safe → records optional (Task 1); asserted in Task 1 tests.
- Cost-spine bound (`REASONING_MAX = 2000`) → Task 1.
- Docs + Phase-5-complete → Task 6.

**Placeholder scan:** the one genuinely under-determined spot is the broker-side `evaluate_split` prompt (Task 2 Step 5) — handled as an explicit locate-via-grep with a named fallback (schema-reorder + request directive), mirroring how prior plans pinned the migration-column check. The Task 5 fixture sweep is compiler-enumerated (the build lists each site), not a vague "fix the tests."

**Type consistency:** `reasoning` field name identical across all schemas and sinks; `REASONING_MAX = 2000` single source (contracts) imported by learning/harness; `proposal.reasoning ?? null` threading identical in Tasks 3/4; `GateDecisionInput.reasoning`/`SplitDecisionInput.reasoning` match the recorder INSERTs and the dispatch-engine callers.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-reasoning-first.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, final whole-branch opus review.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
