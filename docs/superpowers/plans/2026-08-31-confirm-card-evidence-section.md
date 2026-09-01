# Confirm-Card Evidence Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the step-completion confirm card's evidence panel state only what was actually verified — stop rendering grounding rules that never evaluated as passing checks, name the surviving rules distinguishably, de-duplicate the "can't verify" copy, and rename the panel from "Scores" to "Evidence".

**Architecture:** Four independent changes. The load-bearing one is a single early-return in the `implies` grounding evaluator: returning `skipped` instead of `passed` when the antecedent does not match. No contract change is needed — `skipped` already means "this check produced no evidence", and both consumers (the card builder, the metrics aggregate) already handle it correctly. The other three are authored labels in the template catalog, reworded copy in the evidence-scope deriver, and a visible-text rename in one React component.

**Tech Stack:** TypeScript, Vitest (daemon + desktop), React + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-31-confirm-card-evidence-section-design.md` (committed on `main` as `e5f50d7`)

## Global Constraints

- **`skipped` is reused deliberately — do NOT add a new enum value.** `result` stays `z.enum(["passed", "failed", "skipped"])` (`packages/contracts/src/harness/index.ts:30`). No contract file is modified by this plan.
- **This is a scoring change, not only a display change.** After Task 1, a completion whose grounding is *entirely* vacuous no longer counts as grounded in `apps/daemon/src/metrics/aggregate.ts:433` and loses grounding-verifier credit in the composed score. That is intended. Say so in the Task 1 commit message.
- **Persisted history does not move.** Evidence facets are stored per completion; existing rows keep their recorded `passed` values. Nothing is backfilled.
- **Two existing tests pin the OLD behavior and must be rewritten, not "fixed".** `grounding.test.ts:81` ("vacuously passes when the antecedent does not hold") and two assertions in `scope.test.ts:21,23`. These are expected updates — an implementer who sees them fail has not broken anything.
- **Copy in `scope.ts` renders directly in the UI and must stay jargon-free** — no "oracle", "sensor", "facet". The comment at `scope.ts:44-45` states this rule.
- **Shared worktree.** Parallel agents are editing this tree; ~19 modified files are not yours. **Stage explicit paths only — never `git add -A`.**
- Test commands: `pnpm --filter @orca/daemon test`, `pnpm --filter @orca/desktop test`. Typecheck: `pnpm typecheck`.

---

### Task 1: A non-applicable `implies` rule reports `skipped`

**Files:**
- Modify: `apps/daemon/src/harness-sensors/grounding.ts:154-158`
- Test: `apps/daemon/src/harness-sensors/grounding.test.ts:80-87`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: an `implies` check whose antecedent does not match now yields `{ result: "skipped", detail: "rule does not apply — <when.field> is not <when.equals>" }`. Task 2 depends on this to keep Triage's card to one visible tier check.

**Background the implementer needs.** `evaluateOne` in `grounding.ts` evaluates one grounding rule against a step's structured output. The `implies` rule means "if `when.field` equals `when.equals`, then `then.field` must satisfy the constraint". Today, when the antecedent does *not* hold, the rule returns `passed` — so a rule that examined nothing renders on the confirm card as a green tick identical to one that verified something. Triage declares five such rules gated on mutually-exclusive values of `recommended_tier`, so at most two ever apply and the rest render as unearned ticks.

Both downstream consumers already treat `skipped` correctly and need no change:
- `apps/daemon/src/workflows/orchestrator/confirmation-summary.ts` — `if (g.result === "skipped") continue;` omits it from the card.
- `apps/daemon/src/metrics/aggregate.ts:433` — `.some((c) => c.result !== "skipped")` excludes it when deciding a completion has grounding evidence.

`evaluateGrounding`'s verdict logic is also unaffected: it fails only when an **enforced** check has result `failed`.

- [ ] **Step 1: Rewrite the test that pins the old behavior**

Replace the existing test at `apps/daemon/src/harness-sensors/grounding.test.ts:81-87` — currently named `"vacuously passes when the antecedent does not hold"` — with:

```ts
  it("skips when the antecedent does not hold, and says why", () => {
    const g = run(
      [{ rule: "implies", when: { field: "verdict", equals: "needs_work" }, then: { field: "concerns", nonEmpty: true }, mode: "enforce" }],
      { verdict: "sound", concerns: [] },
    );
    // A rule that never examined its consequent must not read as a passed check —
    // the confirm card renders passes as green ticks and would overstate its evidence.
    expect(g.checks[0]!.result).toBe("skipped");
    expect(g.checks[0]!.detail).toBe("rule does not apply — verdict is not needs_work");
    expect(g.verdict).toBe("passed");
  });

  it("skips when the antecedent field is missing from the output entirely", () => {
    const g = run(
      [{ rule: "implies", when: { field: "verdict", equals: "needs_work" }, then: { field: "concerns", nonEmpty: true }, mode: "enforce" }],
      { concerns: [] },
    );
    expect(g.checks[0]!.result).toBe("skipped");
  });

  it("still evaluates normally when the antecedent holds", () => {
    const g = run(
      [{ rule: "implies", when: { field: "verdict", equals: "needs_work" }, then: { field: "concerns", nonEmpty: true }, mode: "enforce" }],
      { verdict: "needs_work", concerns: ["missing error path"] },
    );
    expect(g.checks[0]!.result).toBe("passed");
    expect(g.verdict).toBe("passed");
  });
```

Leave every other test in this file alone — in particular the `"fails when the antecedent holds and the consequent is empty"` test at line 89 must keep passing unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/daemon test -- grounding`
Expected: FAIL — the first new test reports `expected 'passed' to be 'skipped'`.

- [ ] **Step 3: Write the implementation**

In `apps/daemon/src/harness-sensors/grounding.ts`, in the `case "implies":` block, replace the early return at lines 156-158:

```ts
      if (!antecedent.present || !antecedent.values.some((v) => v === check.when.equals)) {
        return { result: "skipped", detail: `rule does not apply — ${check.when.field} is not ${String(check.when.equals)}` };
      }
```

(The previous body was `return { result: "passed", detail: "" };`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- grounding`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Run the metrics suites for the intended scoring change**

Run: `pnpm --filter @orca/daemon test -- metrics`
Expected: PASS. If a metrics test fails, read it before changing anything: a test asserting that a step with only vacuous grounding counts as "grounded" is asserting the behavior this task deliberately corrects, and should be updated with a comment explaining why. A failure about anything else is a real regression — stop and report it.

- [ ] **Step 6: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/harness-sensors/grounding.ts apps/daemon/src/harness-sensors/grounding.test.ts
git commit -m "fix(daemon): a non-applicable implies rule reports skipped, not passed

A rule whose antecedent does not match never examined its consequent, but
returned passed -- so the confirm card rendered it as a green tick
identical to a rule that actually verified something. Triage showed five
such ticks where one check had run.

This also changes scoring: a completion whose grounding is entirely
vacuous no longer counts as grounded in the metrics aggregate and loses
grounding-verifier credit in the composed score. Intended -- it is the
same overstatement one layer down. Persisted facets keep their recorded
values, so history does not move."
```

---

### Task 2: Label Triage's five `implies` rules

**Files:**
- Modify: `apps/daemon/src/workflows/templates/catalog.ts` (Triage's `grounding` array; the `orca/adaptive-delivery` version at line 821)
- Test: `apps/daemon/src/workflows/templates/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1's `skipped` behavior (which is what keeps a `clarify_first` run to one visible tier check).
- Produces: five uniquely-labelled grounding rules. No new symbols.

**Background the implementer needs.** `buildEvidenceBundle` in `apps/daemon/src/workflows/orchestrator/confirmation-summary.ts` names each check `g.label ?? groundingCheckName(g.rule, g.field)`. The generated fallback for `implies` is `` `${humanField} consistency` ``, built from the recorded `field` — and `evaluateGrounding` records `check.when.field` for every `implies` rule (`grounding.ts:229`). All five of Triage's rules are gated on `recommended_tier`, so all five generate the identical name "Recommended tier consistency".

Labels are still needed after Task 1: two rules share `when: approach_only` and two share `when: ground_and_design`, so two can legitimately evaluate together on the same run.

The catalog already labels other rule types — see `{ rule: "member_of", …, mode: "enforce", label: "Chosen approach is one you proposed" }`. Match that placement: `label` goes last, after `mode`.

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/workflows/templates/catalog.test.ts`:

```ts
describe("Triage grounding labels", () => {
  const triage = BUILTIN_TEMPLATE_CATALOG
    .flatMap((t) => t.steps)
    .find((s) => s.id === "triage")!;

  it("gives every implies rule a distinct label", () => {
    const implies = (triage.grounding ?? []).filter((g) => g.rule === "implies");
    expect(implies).toHaveLength(5);
    const labels = implies.map((g) => g.label);
    // Without labels these all render as "Recommended tier consistency", because
    // evaluateGrounding records the `when` field and every rule is gated on
    // recommended_tier.
    expect(labels).toEqual([
      "Approach-only requires clear intent",
      "Approach-only requires understood code",
      "Ground-and-design requires clear intent",
      "Ground-and-design requires ungrounded code",
      "Clarify-first requires unclear intent",
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("bumps adaptive-delivery so the labels actually install", () => {
    const t = BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === "orca/adaptive-delivery")!;
    expect(t.version).toBe(16);
  });
});
```

`BUILTIN_TEMPLATE_CATALOG` is already imported at the top of this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- catalog`
Expected: FAIL — labels are all `undefined`, and the version is 15.

- [ ] **Step 3: Add the labels**

In `apps/daemon/src/workflows/templates/catalog.ts`, in Triage's `grounding` array, add a `label` to each of the five `implies` entries. Preserve every existing comment in that array verbatim — they document real routing decisions (OBS-6, the ground_and_design rationale). The five entries become:

```ts
      { rule: "implies", when: { field: "recommended_tier", equals: "approach_only" }, then: { field: "has_product_intent", equals: true }, mode: "enforce", label: "Approach-only requires clear intent" },
      { rule: "implies", when: { field: "recommended_tier", equals: "approach_only" }, then: { field: "codebase_state", equals: "existing_understood" }, mode: "enforce", label: "Approach-only requires understood code" },
      { rule: "implies", when: { field: "recommended_tier", equals: "ground_and_design" }, then: { field: "has_product_intent", equals: true }, mode: "enforce", label: "Ground-and-design requires clear intent" },
      { rule: "implies", when: { field: "recommended_tier", equals: "ground_and_design" }, then: { field: "codebase_state", excludes: ["existing_understood"] }, mode: "enforce", label: "Ground-and-design requires ungrounded code" },
      { rule: "implies", when: { field: "recommended_tier", equals: "clarify_first" }, then: { field: "has_product_intent", equals: false }, mode: "enforce", label: "Clarify-first requires unclear intent" },
```

- [ ] **Step 4: Bump the template version**

Change `version: 15,` to `version: 16,` at `apps/daemon/src/workflows/templates/catalog.ts:821` (the `orca/adaptive-delivery` entry), and append a `v16:` note to that block's existing comment history, matching the voice of the `v10:`–`v15:` entries above it:

```ts
    // v16: Triage's five `implies` grounding rules carry explicit labels. They are
    // all gated on `recommended_tier`, and the evaluator records the `when` field,
    // so without labels every one of them rendered on the confirm card as the same
    // "Recommended tier consistency" row.
```

- [ ] **Step 5: Verify the installed version before trusting the bump**

The boot upgrade installs a template only when the catalog version **exceeds** the installed one, and a learning-applied proposal has previously occupied a forward version (see the `v10:` note in this file).

Run: `sqlite3 ~/.orca/orca.db "SELECT id, version, catalog_version FROM workflow_templates;"`

Expected: `orca/adaptive-delivery|15|15`. If the installed version is already ≥ 16, raise the catalog value above it **and** update the version assertion in Step 1 to match.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @orca/daemon test -- catalog`
Expected: PASS.

- [ ] **Step 7: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS. `catalog.triage-greenfield.test.ts` and `validate-graph.test.ts` both read these rules.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/workflows/templates/catalog.ts apps/daemon/src/workflows/templates/catalog.test.ts
git commit -m "feat(daemon): label Triage's implies grounding rules distinctly"
```

---

### Task 3: De-duplicate the "can't verify" copy

**Files:**
- Modify: `apps/daemon/src/harness-sensors/scope.ts:46-48`
- Test: `apps/daemon/src/harness-sensors/scope.test.ts:19-24`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `deriveEvidenceScope` returns `gaps: ["nothing was executed to check this"]` and `untestedRegions: ["semantic correctness", "runtime behavior"]` for a non-code step that executed nothing. Signature unchanged.

**Background the implementer needs.** `buildEvidenceBundle` renders the card's "Can't verify" list as `[...oracleAdequacy.gaps, ...untestedRegions]`. The non-code, no-execution branch of `deriveEvidenceScope` currently states the same fact twice — once as a gap and once as an untested region — so the card shows "nothing was executed to check this — semantic correctness is unverified" immediately followed by "semantic correctness — nothing was executed".

**Reword, do not remove.** `gaps` is *counted* by the oracle-adequacy metric; dropping an entry would shift `oracleSufficientRate` and change scoring. The array lengths must stay 1 and 2.

- [ ] **Step 1: Update the test**

In `apps/daemon/src/harness-sensors/scope.test.ts`, replace the test at lines 19-24 (currently named `"non-code output, no execution → 'nothing was executed to check this', NOT dinged for unrun sensors"`) with:

```ts
  it("non-code output, no execution → distinct, non-duplicating lines; NOT dinged for unrun sensors", () => {
    const r = deriveEvidenceScope({ writeSet: ["docs/plan.md"], availableSensors: ["unit", "typecheck"], ranSensors: [] });
    expect(r.gaps).toEqual(["nothing was executed to check this"]);
    expect(r.gaps.some((g) => g.includes("available here but none ran"))).toBe(false); // gated on code write-set
    expect(r.untestedRegions).toEqual(["semantic correctness", "runtime behavior"]);
    // These three render as one list on the confirm card; no entry may restate another.
    const rendered = [...r.gaps, ...r.untestedRegions];
    expect(new Set(rendered).size).toBe(rendered.length);
    expect(rendered.filter((s) => s.includes("nothing was executed"))).toHaveLength(1);
  });
```

Leave the other tests in this file unchanged — in particular the code-files cases, whose strings are not being touched.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- scope`
Expected: FAIL — `gaps` still holds the long "— semantic correctness is unverified" string.

- [ ] **Step 3: Reword the three strings**

In `apps/daemon/src/harness-sensors/scope.ts`, in the `else if (!hasExecutionOracle)` branch, replace lines 46-48:

```ts
    gaps.push("nothing was executed to check this");
    untestedRegions.push("semantic correctness");
    untestedRegions.push("runtime behavior");
```

Leave the explanatory comment above them (lines 44-45, about no-jargon UI strings) in place.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- scope`
Expected: PASS.

- [ ] **Step 5: Run the full daemon suite**

Run: `pnpm --filter @orca/daemon test`
Expected: PASS. Other suites assert on evidence-scope output; if one fails on these exact strings, update it — but report which, so the copy change's blast radius is recorded.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/harness-sensors/scope.ts apps/daemon/src/harness-sensors/scope.test.ts
git commit -m "fix(daemon): stop stating the same can't-verify fact twice"
```

---

### Task 4: Rename the card's toggle from "Scores" to "Evidence"

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx:223` and `:361`
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx:560`

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: no new symbols. Visible text only.

**Background the implementer needs.** The toggle opens a panel containing Checks run, Can't verify, Independent check, and — one disclosure deeper — the model's self-scores, which the panel itself labels "its own claim — not proof". "Scores" names the element deliberately demoted furthest.

The sibling gate-review toggle in the same file (around line 589) already reads **"Evidence reviewed"**, and the panel container is `data-testid="step-confirm-evidence"`, built by `buildEvidenceBundle`. This rename aligns the label with vocabulary already in the file.

**Change the visible text only.** Leave the `step-confirm-scores-toggle` class name and every `data-testid` (`step-confirm-scores-toggle`, `step-result-expand`, the `scoresTestid` variable) exactly as they are, and leave the `ScoresCaret` component name alone. Renaming them would balloon the diff and break selectors for no user-visible gain.

- [ ] **Step 1: Update the test that asserts the old label**

In `apps/desktop/src/orchestrator/ActivityThread.test.tsx`, line 560 currently reads:

```ts
    expect(screen.getByTestId("step-result-expand")).toHaveTextContent("Scores");
```

Change it to:

```ts
    expect(screen.getByTestId("step-result-expand")).toHaveTextContent("Evidence");
```

Also update the comment on line 559, which currently says `// The expander is now a bottom "Scores" toggle (was a top "Details" button).` — change `"Scores"` to `"Evidence"` in that sentence so the comment does not contradict the assertion below it.

Then add a test covering the live confirm card's toggle, placed beside the other confirm-card tests:

```ts
  it("labels the evidence toggle 'Evidence', not 'Scores'", () => {
    render(
      <LiveActivity
        activity={{
          ...confirmActivity,
          confirmationSummary: {
            ...confirmActivity.confirmationSummary,
            evidence: {
              executed: false,
              checks: [{ name: "Referenced files exist", status: "passed", kind: "grounding", detail: null }],
              cantVerify: [],
            },
          },
        }}
      />,
    );
    const toggle = screen.getByTestId("step-confirm-scores-toggle");
    expect(toggle).toHaveTextContent("Evidence");
    expect(toggle).not.toHaveTextContent("Scores");
  });
```

If `step-confirm-scores-toggle` is not the testid actually rendered for the live card, read the `scoresTestid` variable near `ActivityThread.tsx:218` and use the value it resolves to for that call site.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @orca/desktop test -- ActivityThread`
Expected: FAIL — both the updated assertion and the new test report the element still reads "Scores".

- [ ] **Step 3: Rename both labels**

In `apps/desktop/src/orchestrator/ActivityThread.tsx`, change line 223 and line 361. Both currently read:

```tsx
          <span>Scores</span>
```

Both become:

```tsx
          <span>Evidence</span>
```

Note the two sites have different indentation — line 223 is inside the live confirm card's button, line 361 inside the persisted step-result card's button. Change the text only; leave surrounding attributes untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @orca/desktop test -- ActivityThread`
Expected: PASS.

- [ ] **Step 5: Run the full desktop suite and typecheck**

Run: `pnpm --filter @orca/desktop test` then `pnpm --filter @orca/desktop typecheck`
Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(desktop): rename the confirm card's Scores toggle to Evidence"
```

---

### Task 5: Full verification and live check

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Typecheck the monorepo**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 2: Run every package's tests**

Run: `pnpm test`
Expected: all suites pass. The worktree contains files modified by other agents. If something fails, attribute it — inspect the failing test and the relevant `git diff` — rather than assuming it is yours. **`git stash` is not allowed; it would disrupt the other agents.** Report attribution; do not fix another agent's failure.

- [ ] **Step 3: Verify the card in the browser**

Run `pnpm dev:browser` in the background (it prints a Local URL) and drive the app with the `mcp__playwright__*` tools. This proxies to the real daemon — no mocks.

The live daemon runs `tsx watch src/`, so editing `catalog.ts` in Task 2 will already have restarted it and installed v16. Confirm with `sqlite3 ~/.orca/orca.db "SELECT id, version FROM workflow_templates;"`.

Open a Triage step's confirm card and confirm:
1. The toggle reads **Evidence**, not Scores.
2. Under CHECKS RUN there are **two** rows — "Referenced files exist" and exactly one tier rule named for the recommended tier (e.g. "Clarify-first requires unclear intent" on a `clarify_first` run) — not six, and no repeated names.
3. Under CAN'T VERIFY, no line restates another.
4. The independent-check block and the nested model self-assessment are unchanged.

A pre-existing card (from a run completed before this change) is rendered from the live catalog, so it will also show the new labels — that is expected, not a bug.

If no Triage card is reachable in reasonable time, say so plainly rather than inventing a result, and fall back to reporting what the suites verified.

- [ ] **Step 4: Shut down the dev server and report**

Stop anything started in Step 3. Report the four observations, or an honest account of which could not be checked and why.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3.1 vacuous `implies` returns `skipped` | Task 1 |
| §3.1 intended scoring change, history unmoved | Task 1, Steps 5 and 7 (commit message) |
| §3.2 five authored labels | Task 2, Step 3 |
| §3.2 version bump 15→16 + verify installed first | Task 2, Steps 4-5 |
| §3.3 reworded (not removed) scope copy | Task 3 |
| §3.4 rename to "Evidence", testids untouched | Task 4 |
| §4 testing (grounding, catalog, scope, ActivityThread, metrics regression) | Tasks 1-4, each Step 1; Task 1 Step 5 |
| §5 shared-worktree staging discipline | Global Constraints; every commit stages explicit paths |

No gaps. `confirmation-summary.test.ts` from §4 is deliberately *not* given its own task: Task 1 changes no code in that file, and its existing tests already cover both the `skipped` skip and `g.label ?? …` precedence. Adding tests there would duplicate coverage Task 1 and Task 2 already establish at their sources.

**Placeholder scan:** every code step carries the actual code. Three steps are deliberately conditional rather than placeholder, each stating the exact check and the corrective action: Task 1 Step 5 (a metrics test asserting the old scoring should be updated with a comment; anything else is a real regression), Task 2 Step 5 (raise the version if the live DB already holds a higher one), and Task 4 Step 1 (use the value `scoresTestid` resolves to if the live-card testid differs).

**Type consistency:** `result: "skipped"` matches the existing `z.enum(["passed", "failed", "skipped"])` — no contract file is touched. The five label strings are identical between Task 2's test (Step 1) and its implementation (Step 3). `deriveEvidenceScope`'s return shape is unchanged in Task 3; only string values differ, and the test asserts the same array lengths the metric counts.
