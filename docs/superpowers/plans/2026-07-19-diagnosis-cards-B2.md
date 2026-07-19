# Diagnosis Cards B2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each step row into a diagnosis-led card — instructions-derived description, data-driven verdict, and the three telemetry channels — on top of B1's ceiling-relative band.

**Architecture:** The daemon surfaces two optional fields (`description` from the step's `instructions` first sentence; `completionPolicy`) on `StepMetrics`. The desktop renders name+band → description → verdict → a three-channel scorecard, all derived from existing signals. No scoring/model change; recompute-on-read.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo (`packages/contracts`, `apps/daemon`, `apps/desktop`).

**Design spec:** `docs/superpowers/specs/2026-07-19-diagnosis-cards-B2-design.md` (§3 has the full verdict + channel copy map). **Mockup reference:** `scratchpad/metrics-redesign.html`.

## Global Constraints

- New `StepMetrics` fields `description`/`completionPolicy` are **OPTIONAL** (no required-field ripple); daemon emits them when the template has them.
- Description = the step `instructions`' **first sentence**, length-capped ≤140 chars at a word boundary (ellipsis if truncated). No LLM.
- All new copy is **jargon-free** (`no-jargon.test.tsx` must pass).
- No change to scoring, calibration, or the B1 band model. Desktop derives verdict/channels from existing signals + the two new fields.
- The collapsed row's `OutcomeBar` is retired from the row (moves to the drawer or a tooltip).

---

### Task 1: Daemon — surface `description` + `completionPolicy` (contract + daemon)

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts` (two optional `StepMetrics` fields)
- Modify: `apps/daemon/src/metrics/usecases.ts` (`stepNames` derives description/policy) + `apps/daemon/src/metrics/aggregate.ts` (thread through `computeStepMetrics`)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts` (or `usecases` test)

**Interfaces:**
- Produces: `StepMetrics.description?: string`, `StepMetrics.completionPolicy?: string`; `stepNames` map values gain `description?`/`completionPolicy?`.

- [ ] **Step 1: Contract**

In `packages/contracts/src/metrics/index.ts` add to the `StepMetrics` object (anywhere among the scalar fields):
```ts
  description: z.string().optional(),
  completionPolicy: z.string().optional(),
```

- [ ] **Step 2: Write the failing daemon test**

In `aggregate.steps.test.ts`, extend the `stepNames` fixture to carry a description + policy and assert they surface:
```ts
it("surfaces description (first sentence of instructions) + completionPolicy on the step metric", () => {
  const names = new Map([["s", { name: "Generate", ordinal: 2, description: "Assess the goal without changing code.", completionPolicy: "reasoning" }]]);
  const [step] = computeStepMetrics({ transitions: /*any scored*/, stepRuns: /*..*/, stepNames: names, nowIso, period: "7d" });
  expect(step.description).toBe("Assess the goal without changing code.");
  expect(step.completionPolicy).toBe("reasoning");
});
```
Plus a unit for the first-sentence helper (see Step 4): long instructions → capped with ellipsis; no period → whole string capped; empty → undefined.

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter @orca/daemon test -- aggregate.steps`.

- [ ] **Step 4: Implement the derivation**

Add a `firstSentence` helper (in `usecases.ts` or a small util):
```ts
function firstSentence(text: string, cap = 140): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const m = t.search(/\.\s/);
  let s = m > 0 ? t.slice(0, m + 1) : t;
  if (s.length > cap) s = s.slice(0, cap).replace(/\s+\S*$/, "") + "…";
  return s;
}
```
Extend the `StepDef` type to `{ id: string; name?: string; ordinal?: number; instructions?: string; completionPolicy?: string }` and `stepNames` to emit `description: d.instructions ? firstSentence(d.instructions) : undefined` and `completionPolicy: d.completionPolicy`. Widen the `computeStepMetrics` `stepNames` param type to include the two optional fields, and at the metric-build site (aggregate.ts ~:532) emit `description: meta.description, completionPolicy: meta.completionPolicy`.

- [ ] **Step 5: Run tests to verify they pass** — `pnpm --filter @orca/daemon test -- aggregate.steps`, then `pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/contracts typecheck`. Green (optional fields ⇒ no fixture ripple).

- [ ] **Step 6: Commit** — `git commit -m "feat(metrics): surface step description (from instructions) + completionPolicy"`

---

### Task 2: Desktop — the diagnosis card (`StepPerformance.tsx` + `metrics-data.ts`)

**Files:**
- Modify: `apps/desktop/src/metrics/metrics-data.ts` (add `verdictFor` + `channelsFor` derivation helpers)
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` (row: description + verdict + 3-channel scorecard; retire `OutcomeBar` from the collapsed row)
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx` (+ `no-jargon.test.tsx` stays green)

**Interfaces:**
- Consumes: `StepMetrics` incl. `description`/`completionPolicy` (Task 1), `verification.band`, `score`/`trend`/`runs`, `quality.limitingDimension`, `failureModes`.
- Produces: `verdictFor(step): { health: string; cause: string; tone }` and `channelsFor(step): { doing; check; wrong }` (each `{ text: string; tone: "run"|"warn"|"err"|"accent" }`), per spec §3.2.

- [ ] **Step 1: Write the failing render tests**

In `StepPerformance.test.tsx`, add cases (reuse the file's step fixture builder; set the relevant fields):
- Healthy grounded step (band strong "Reviewed", score 95, no failureModes) → renders its `description`, a verdict containing "Healthy", and "How we check it" containing "review is the right bar".
- Failing step (score 66, failureModes `[{label:"invalid_output",count:3,pct:0.15}]`) → verdict contains "Needs attention" and "invalid_output"; "Anything wrong" shows "invalid_output 3×".
- Null-score step (band needs_evidence) → verdict "Not checked yet"; "How it's doing" shows "No score yet".
- Assert the collapsed row no longer renders the `OutcomeBar` element (query by its test id / role if present, else assert the passed/recovered/failed split isn't in the collapsed row).

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @orca/desktop test -- StepPerformance`.

- [ ] **Step 3: Implement `verdictFor` + `channelsFor` in `metrics-data.ts`**

Follow spec §3.2 exactly:
- **verdict health**: band `needs_evidence` → "Not checked yet"; else `score == null` → "Not scored yet"; `failureModes.length || (score < 60)` → "Needs attention"; `score < 70` → "Holding, with gaps"; else "Healthy". **cause**: `failureModes[0]?.label` else `quality.limitingDimension` else `score != null && score < 70 ? "low score (${score})"` else "nothing failing this period".
- **How it's doing**: `score == null ? "No score yet — needs more runs" : "${word} · ${score} across ${runs} runs"` where word = score≥80 "Strong" / ≥60 "Holding" / else "Struggling"; append " · falling"/" · rising" from `trend` (compare last vs first). tone by score band.
- **How we check it**: switch on `band.label` — `Run & tested`→"Ran the tests and they passed."; `Reviewed`→"Its claims are checked; no code to run, so review is the right bar."; `Not tested`→"Reviewed but not run — a step like this can be tested; it wasn't."; `Only self-reported`→"Nothing independent checked it — add a grounding check or a reviewer."; `Not checked yet`→"No check has run yet." tone from band level (strong→run, weak→warn, needs_evidence→accent).
- **Anything wrong**: `failureModes[0] ? "${label} ${count}× · ${Math.round(pct*100)}%" : "Nothing this period"`. tone err if present else run.

- [ ] **Step 4: Implement the row**

In `StepPerformance.tsx` collapsed row: after the name+band line, render `step.description` (muted subtitle, omit if absent), then the verdict line (`verdictFor`), then a three-cell scorecard (`channelsFor`) with micro-labels `How it's doing` / `How we check it` / `Anything wrong`, a status dot per cell, and the cell text. Remove the `OutcomeBar` from the collapsed row (move it into the drawer's detail or a "How it's doing" title tooltip). Keep the right-side sparkline + score. Keep the existing drawer sections.

- [ ] **Step 5: Run tests + no-jargon + typecheck** — `pnpm --filter @orca/desktop test && pnpm --filter @orca/desktop typecheck`. `no-jargon` must pass with the new copy (choose plainer synonyms if any term trips it). Green.

- [ ] **Step 6: Commit** — `git commit -m "feat(desktop): diagnosis-led step card — description, verdict, three channels"`

---

### Task 3: Verify — full workspace, whole-branch review, live check

- [ ] **Step 1:** `pnpm -w typecheck && pnpm --filter @orca/contracts test && pnpm --filter @orca/daemon test && pnpm --filter @orca/desktop test` — all green.
- [ ] **Step 2:** Whole-branch review (base = commit before Task 1 .. HEAD). Verify: `description`/`completionPolicy` optional (no ripple); first-sentence derivation correct + capped; verdict/channel derivation matches spec §3.2; `How we check it` keys off the B1 band label; no scoring/model change; `no-jargon` passes; `OutcomeBar` retired from the collapsed row. Feed the ledger's Minor list.
- [ ] **Step 3:** Live check (needs daemon restart — ask user). On Adaptive Delivery: Triage shows its instructions-derived description + "Healthy — nothing failing" + three channels; Research shows "Needs attention — invalid output ×3"; the cards read like a human understands them, close to the mockup. Screenshot.
- [ ] **Step 4:** Mark B2 complete in the ledger + update `metrics-health-console-redesign.md`. Next: B3 (fused pipeline).

---

## Self-Review

**Spec coverage:** description+policy surfaced (Task 1), verdict + three channels derived per §3.2 (Task 2 Step 3), row restructure + OutcomeBar retirement (Task 2 Step 4), live confirmation (Task 3). All spec §3 items map to a task.

**Placeholder scan:** the `firstSentence` helper and the verdict/channel derivation rules are concrete (health thresholds, the band-label→copy map, the "Anything wrong" format). Test bodies name concrete expected substrings. The step-fixture builders reuse each test file's existing helpers.

**Type consistency:** `description?: string`/`completionPolicy?: string` optional on `StepMetrics` and on the `stepNames` map value; `verdictFor`/`channelsFor` return typed `{text, tone}` shapes consumed by the row; band-label strings match B1's exact labels (`Run & tested`/`Reviewed`/`Not tested`/`Only self-reported`/`Not checked yet`).
