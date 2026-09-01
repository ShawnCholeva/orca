# Confirm-Card Evidence Section — Design

**Date:** 2026-08-31
**Status:** Design — approved (hide vacuous checks; rename the toggle to "Evidence")
**Scope:** Make the step-completion confirm card's evidence panel state only what was actually verified. Stop rendering grounding rules that never evaluated as passing checks, give the surviving rules distinguishable names, remove a duplicated "can't verify" line, and rename the panel from "Scores" to "Evidence".

---

## 1. Context & motivation

A live Triage confirm card rendered this under its "Scores" toggle:

```
CHECKS RUN
  ✓ Referenced files exist
  ✓ Recommended tier consistency
  ✓ Recommended tier consistency
  ✓ Recommended tier consistency
  ✓ Recommended tier consistency
  ✓ Recommended tier consistency
  No executable checks — this step produces reasoning, not code.
CAN'T VERIFY
  • nothing was executed to check this — semantic correctness is unverified
  • semantic correctness — nothing was executed
  • runtime behavior
```

The user's reaction: *"the scores in the card… they don't make sense."*

Three distinct defects sit behind that, and only the first is cosmetic.

### 1.1 Four of the five ticks are vacuous

`evaluateOne`'s `implies` branch (`apps/daemon/src/harness-sensors/grounding.ts:154-158`) returns `{ result: "passed", detail: "" }` when the antecedent does not match — the rule never examined its consequent.

Triage declares five `implies` rules, gated on `recommended_tier` being `approach_only` (×2), `ground_and_design` (×2), and `clarify_first` (×1). This run recommended `clarify_first`, so **one** rule evaluated anything and four short-circuited. All five rendered as identical green ticks.

This is not a display nit. It is the card overstating its own evidence at the exact moment a human is deciding whether to trust the step — the failure mode the evidence bundle exists to prevent. Paper §5.2.2: calibration must be earned, not asserted.

### 1.2 The duplicate name hides the vacuity

`evaluateGrounding` records `field: check.rule === "implies" ? check.when.field : check.field` (`grounding.ts:229`), so every `implies` result reports `recommended_tier`. `groundingCheckName` (`confirmation-summary.ts:31`) renders `implies` as `` `${humanField} consistency` ``. Five rules, one name. Had they been named distinctly, the vacuity would have been visible from the start.

### 1.3 The same sentence appears twice under "Can't verify"

`apps/daemon/src/harness-sensors/scope.ts:43-49` — the non-code, no-execution branch pushes the same fact as both a gap and an untested region:

```ts
gaps.push("nothing was executed to check this — semantic correctness is unverified");
untestedRegions.push("semantic correctness — nothing was executed");
untestedRegions.push("runtime behavior");
```

`buildEvidenceBundle` concatenates `[...oracleAdequacy.gaps, ...untestedRegions]`, so both surface. (`metrics/verification.ts:105` emits a similar sentence but feeds the metrics console, not this card — it is out of scope.)

### 1.4 "Scores" names the wrong thing

The panel contains Checks run, Can't verify, Independent check, and — nested one disclosure deeper — the model's self-scores. It is named after the one element deliberately demoted furthest, and which the existing code already labels *"its own claim — not proof"*.

---

## 2. Goals & non-goals

### Goals
- A grounding rule that did not evaluate must not render as a passed check.
- Rules that *do* evaluate must be distinguishable from one another.
- No line under "Can't verify" restates another.
- The panel is named for what it holds.

### Non-goals
- Any change to the model self-assessment block, the refute/independent-check block, or the "Brief for the next step" disclosure.
- Changing what grounding rules Triage declares, or their `mode`. Only their labels change.
- `metrics/verification.ts` copy, which serves the metrics console.
- Recomputing or backfilling historical metrics.

---

## 3. Design

### 3.1 A vacuous `implies` returns `skipped`

`grounding.ts:154-158` — when the antecedent does not match, return `skipped` with a detail naming why, instead of `passed` with an empty detail:

```ts
if (!antecedent.present || !antecedent.values.some((v) => v === check.when.equals)) {
  return { result: "skipped", detail: `rule does not apply — ${check.when.field} is not ${String(check.when.equals)}` };
}
```

**No contract change and no new enum value.** `result` stays `"passed" | "failed" | "skipped"` (`packages/contracts/src/harness/index.ts:30`), and `skipped` already carries exactly this meaning elsewhere in the same function — `"…not present in output"`, `"prior step output unavailable"`. Both downstream consumers already do the right thing:

- `confirmation-summary.ts` — `if (g.result === "skipped") continue;` omits it from the card.
- `metrics/aggregate.ts:433` — `.some((c) => c.result !== "skipped")` excludes it when deciding a completion has grounding evidence.

The grounding verdict is unaffected: `evaluateGrounding` fails only on an **enforced** check whose result is `failed`.

**Intended second-order effect.** A step whose grounding consists *entirely* of vacuous rules currently counts as "grounded" and earns grounding-verifier credit in the composed score. After this change it does not. That is the same overstatement as §1.1, one layer down, and correcting it is desirable. Triage is unaffected in practice — its `paths_exist` on `known_files` is a real check that still runs.

**History does not move.** Evidence facets are persisted per completion; existing rows keep their recorded `passed` values. Only completions after this change are scored the new way.

### 3.2 Label Triage's five `implies` rules

`buildEvidenceBundle` already prefers an authored label: `g.label ?? groundingCheckName(g.rule, g.field)`. The catalog already labels other rule types (`"Referenced files exist"`, `"Chosen approach is one you proposed"`). These five are the only `implies` rules in the entire catalog and none carries a label.

| when | then | label |
|---|---|---|
| `approach_only` | `has_product_intent = true` | Approach-only requires clear intent |
| `approach_only` | `codebase_state = existing_understood` | Approach-only requires understood code |
| `ground_and_design` | `has_product_intent = true` | Ground-and-design requires clear intent |
| `ground_and_design` | `codebase_state ≠ existing_understood` | Ground-and-design requires ungrounded code |
| `clarify_first` | `has_product_intent = false` | Clarify-first requires unclear intent |

Labels are still required after §3.1: two rules share `when: approach_only` and two share `ground_and_design`, so two can legitimately evaluate together and would otherwise both render as "Recommended tier consistency".

Authoring labels is preferred over changing `grounding.ts:229` to report `check.then.field`. That field is recorded on every persisted grounding result; repurposing it to fix a display name would change stored data for a presentation concern.

Requires bumping `orca/adaptive-delivery` **15 → 16**. Verify the installed version first (`sqlite3 ~/.orca/orca.db "SELECT id, version FROM workflow_templates;"`) — the boot upgrade only installs when the catalog version exceeds the installed one, and a learning-applied proposal has previously occupied a forward version.

### 3.3 De-duplicate the "can't verify" lines

`scope.ts:46-48` becomes:

```ts
gaps.push("nothing was executed to check this");
untestedRegions.push("semantic correctness");
untestedRegions.push("runtime behavior");
```

**Reworded, not removed, deliberately.** `oracleAdequacy.gaps` is *counted* by the oracle-adequacy metric; dropping an entry would shift `oracleSufficientRate` and change scoring. Changing wording is free.

Accepted residue: "nothing was executed to check this" still mildly echoes the panel's own footer, "No executable checks — this step produces reasoning, not code." Suppressing it would require the card to match on the string, which is brittle and would silently stop working if the copy changed. The small echo is preferable to a fragile match.

### 3.4 Rename the toggle to "Evidence"

`apps/desktop/src/orchestrator/ActivityThread.tsx:223` (live confirm card) and `:361` (persisted step-result card). Both are `<span>Scores</span>`.

The sibling gate-review toggle at `:589` already reads **"Evidence reviewed"**, and the panel's own container is `data-testid="step-confirm-evidence"`, built by `buildEvidenceBundle` from a `ConfirmationSummaryEvidence`. The rename aligns the visible label with vocabulary the codebase already uses rather than introducing new terminology.

Visible text only — the `step-confirm-scores-toggle` class and all `data-testid`s stay as they are, so the diff stays about the words. One existing assertion changes: `ActivityThread.test.tsx:560` asserts `toHaveTextContent("Scores")`.

### 3.5 Resulting card

```
Evidence ⌃
CHECKS RUN
  ✓ Referenced files exist
  ✓ Clarify-first requires unclear intent
  No executable checks — this step produces reasoning, not code.
CAN'T VERIFY
  • nothing was executed to check this
  • semantic correctness
  • runtime behavior
INDEPENDENT CHECK
  A second AI reviewed it and agreed — but nothing was run or tested
```

Six ticks become two, and both were earned.

---

## 4. Testing

- **`grounding.test.ts`** — an `implies` whose antecedent does not match yields `skipped` with a detail naming the antecedent; one whose antecedent matches still yields `passed` or `failed` as before; a `skipped` implies does not change the grounding verdict, and an enforced `failed` still does.
- **`confirmation-summary.test.ts`** — a facet mixing evaluated and skipped grounding checks renders only the evaluated ones; an authored `label` wins over the generated name.
- **`catalog.test.ts`** — all five Triage `implies` rules carry a non-empty, **unique** label; `orca/adaptive-delivery` is version 16.
- **`scope.test.ts`** — for a non-code step with no execution, the emitted `gaps` and `untestedRegions` contain no duplicated statement, and `gaps` still has length 1 so the oracle-adequacy count is unchanged.
- **`ActivityThread.test.tsx`** — the toggle reads "Evidence"; the existing `"Scores"` assertion at :560 is updated.
- **Metrics regression** — `aggregate` tests still pass, confirming a step retaining at least one evaluated grounding check still counts as grounded.

---

## 5. Risks

- **Composed-score movement (intended).** §3.1 removes grounding-verifier credit from completions whose grounding was entirely vacuous. Desired, but it is a scoring change, not just a display change, and should be called out in the commit message.
- **Version bump must clear the installed version.** As with the previous change, an un-bumped or under-bumped template silently fails to install and the new labels never appear — with no test failure to signal it.
- **Shared worktree.** Parallel agents are working in this tree. Stage explicit paths; never `git add -A`.
- **Wording is user-facing.** The `scope.ts` strings render directly in the UI and must stay jargon-free — the existing comment at `scope.ts:45` says so explicitly.
