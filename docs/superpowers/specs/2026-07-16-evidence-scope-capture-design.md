# Evidence Scope Capture (Scoring Evolution — Phase 2a)

**Date:** 2026-07-16
**Status:** Design — approved, pending spec review
**Scope:** Phase 2a of the "honest evidence/measurement scoring" evolution. Producer-side foundation only — no scoring or UI-score change (those are 2b/2c).

---

## 1. Context & motivation

Phase 1 made gates first-class scored components. Phase 2's goal is **honest evidence/measurement scoring**: the step score should reflect not just *that* verification ran, but *what it could not verify* — the paper's central §5.2.2 abstraction, "a verification stack with explicit scope… make every accepted action carry an evidence bundle containing the checks run, the assumptions preserved, **the untested regions, and the remaining risks.**"

**The blocking discovery (verified against live `orca/adaptive-delivery` data + the producers):** Orca's `EvidenceFacet` *has* the fields for explicit scope, but two of them are never populated:

- **`untestedRegions` — never written.** Both producers hardcode `untestedRegions: []` (`apps/daemon/src/harness-sensors/runner.ts:72`, `apps/daemon/src/harness-sensors/grounding.ts:261`). It is defined in the contract, read by metrics (`aggregate.ts:487`), rendered in the UI ("What we couldn't check"), and folded into the confirmation card's `cantVerify` (`confirmation-summary.ts:68`) — but is structurally empty on every step.
- **`oracleAdequacy.gaps` — half-written.** Populated only when a *required* sensor kind has no matching script (`runner.ts:54`). For a step with **no execution oracle at all** (every reasoning/doc step), `buildEvidenceFacet` hardcodes `gaps: []` (`grounding.ts:263`), so the facet records `sufficient: false` but never says *what* the unverified surface is.

Live confirmation, every non-code Adaptive Delivery step (`triage`, `research`, `proposal`, `done`, `critique`): `oracleAdequacy.sufficient=false` but `gaps=[]`, `untestedRegions=[]`, `residualRisk=[]`.

So Orca records *that* verification is thin (a boolean) but not *what it fails to cover*. A Phase-2b scope-aware score built today would score over `[]` and deliver none of the "untested scope" value. **2a captures the scope so 2b has real signal to reflect.**

### Non-negotiable: honesty over richness

A *hallucinated* untested-regions list is worse than an empty one — it manufactures false coverage claims and would poison Phase 3's learning loop (the paper: "if the verifier is weak, the agent will learn to optimize against the wrong signal"). The paper grounds verification in **deterministic sensors** and requires any model-derived signal to **declare itself as lower-confidence**. Therefore **2a derives scope only from facts about what ran** — the write-set, detected sensor availability, and grounding results. **No LLM-generated scope in 2a.** Model-*named* untested regions are explicitly deferred to a later, confidence-marked artifact source.

---

## 2. Goals & non-goals

### Goals
- Populate `EvidenceFacet.oracleAdequacy.gaps`, `untestedRegions`, and `residualRisk` deterministically at production time.
- The content is derived purely from facts (write-set, available-vs-run sensors, grounding), so it is auditable and never hallucinated.
- The confirmation card's "What we couldn't check" and the Metrics "untested regions" stop being empty for real deliveries.

### Non-goals (2a)
- Any change to the step **score** or its formula — that is 2b (the composed compounding × calibration score).
- Any model/LLM-generated scope (reviewer-named untested regions) — deferred to a confidence-marked source in a later phase.
- Epistemic bands, gate-groundedness re-weight, deterministic-completion-gate telemetry — 2c.
- Coverage instrumentation (line/branch coverage reports) — out of scope; 2a uses file-granularity write-set vs sensor-run, not intra-file coverage.

---

## 3. Design

### 3.1 New pure function: `deriveEvidenceScope`

`apps/daemon/src/harness-sensors/scope.ts` (new):

```
deriveEvidenceScope(input: {
  writeSet: string[];              // files the step changed (repo-relative paths)
  availableSensors: WorkflowSensorKind[];  // sensor kinds detectSensors found in the workspace
  ranSensors: SensorResult[];      // sensors that actually executed (facet.sensorsRun)
  grounding: Grounding | null;     // the step's grounding result
  hasExecutionOracle: boolean;     // did any execution sensor run (ranSensors non-empty)
}): { untestedRegions: string[]; gaps: string[]; residualRisk: string[] }
```

Pure, deterministic, no I/O. Unit-testable with fixtures. All strings are plain-language (no jargon — same bar as the metrics failure-label catalog), capped in count/length to the facet's existing `.max(64)`/`.max(512)` schema limits.

**Derivation rules (facts only):**

- **`gaps`** (what adequate verification was missing):
  - For each `availableSensors` kind NOT in `ranSensors`: `"<kind> checks are available here but none ran over this change"`.
  - If `writeSet` has code files but `hasExecutionOracle` is false: `"code changed but nothing executed it"`.
  - If `writeSet` has no code files (non-code output): `"no execution oracle applies — semantic correctness is unverified"`.
  - Preserve the existing missing-required-sensor gaps from `runner.ts` (merge, dedupe).
- **`untestedRegions`** (which parts of the delivery were not exercised):
  - Each code file in `writeSet` not exercised by any run sensor: `"<path> — changed, no test or check ran over it"`. (File-granularity: "exercised" = an execution sensor ran at all when the file is in the change set; 2a does not attempt intra-file coverage.)
  - For a non-code step: the categorical unverified surface, stated deterministically (e.g. `"runtime behavior"`, `"edge cases"`) — a fixed, honest list, not invented specifics.
- **`residualRisk`** (remaining risk implied by the gaps):
  - Derived from the above: unexercised code files → `"<path> may contain defects no check would catch"`; a missing high-value sensor (unit/build) with a code write-set → `"a regression could ship undetected"`. Deterministic mapping from gaps, not a new judgment.

`writeSet` classification of "code file" uses a small extension allow-list (`.ts/.tsx/.js/.jsx/.py/…`) — the same notion Orca already uses elsewhere for code detection; exact list pinned in the plan.

### 3.2 Thread the facts into `buildEvidenceFacet`

`buildEvidenceFacet` (`grounding.ts:250`) gains the inputs `deriveEvidenceScope` needs and calls it, replacing the two hardcoded `[]` sites:

```
buildEvidenceFacet(args: {
  sensors: EvidenceFacet | null;
  grounding: Grounding | null;
  scope: { writeSet: string[]; availableSensors: WorkflowSensorKind[] };  // NEW
}): EvidenceFacet | null
```

- The `!args.sensors` branch (`:257-266`) computes `deriveEvidenceScope({ writeSet, availableSensors, ranSensors: [], grounding, hasExecutionOracle: false })` and uses its `untestedRegions`/`gaps`/`residualRisk` instead of `[]`.
- The sensors branch (`:267-271`) computes scope with `ranSensors = args.sensors.sensorsRun` and merges the derived `gaps` into `oracleAdequacy.gaps` (preserving the sensor-derived gaps already there), and sets `untestedRegions`/`residualRisk`.
- Sensor-verdict semantics stay untouched: `deriveEvidenceScope` never changes `verdict` or `oracleAdequacy.sufficient` — it only fills the descriptive scope. (The invariant at `grounding.ts:246-248` — "sensor semantics never diluted" — is preserved.)

### 3.3 Provide the facts at the call site

At `service.ts:1324`, `buildEvidenceFacet` currently gets `{ sensors, grounding }`. Add `scope`:

- **`writeSet`** — the Stateful-axis write-set is already derived in this completion handler (near `service.ts:1223`, "derive write_set + assumptions"). Thread that existing value in; do not recompute. (Exact variable pinned in the plan.)
- **`availableSensors`** — `detectSensors(workspacePath, required)` is currently called *inside* `runSensors` (`runner.ts:20`) and discarded. Surface the detected kinds so the call site can pass them (either return them from `runSensors` alongside the facet, or call `detectSensors` once at the site). The plan picks the lower-churn option.

### 3.4 Data & backward-compat

- Scores are **recomputed from persisted transitions on read** (Phase-1 fact), and evidence facets are persisted in `harness_transitions.evidence_json`. 2a changes *new* completions' facets going forward; historical facets keep their empty `[]` (honest — that scope was never captured). No migration, no backfill.
- The contract shape is unchanged (`untestedRegions`/`gaps`/`residualRisk` already exist and are arrays) — 2a only starts *writing* them. No contract or schema change.

---

## 4. Testing & verification

- **Unit (daemon):** fixture tests for `deriveEvidenceScope` — code write-set with no sensors → "code changed but nothing executed it" + per-file untested regions; non-code write-set → "no execution oracle applies"; available-but-unrun sensor → gap; full sensor coverage → empty gaps/untested (honest: nothing to report); dedupe with pre-existing missing-required gaps; jargon-free assertions; cap enforcement.
- **`buildEvidenceFacet` tests:** extend existing tests to assert the scope is populated in both branches and that `verdict`/`oracleAdequacy.sufficient` are unchanged (sensor semantics preserved).
- **Regression:** the full daemon suite stays green; existing evidence/grounding/metrics tests updated only where they asserted `untestedRegions: []`/`gaps: []` on a fixture that now legitimately has content (update to the correct new value, never weaken).
- **Live (per `/verify`):** re-run the Adaptive Delivery flow (or inspect a fresh completion) and confirm `untestedRegions`/`gaps` are now populated and correct — `research` → "no execution oracle applies — semantic correctness is unverified"; a code step missing tests → "unit checks are available here but none ran." Confirm the confirmation card's "What we couldn't check" renders the real content.

---

## 5. `agent-harness.pdf` alignment

| Paper mandate | 2a element |
|---|---|
| §5.2.2 evidence bundle carries "untested regions, remaining risks" | `deriveEvidenceScope` populates `untestedRegions` + `residualRisk` |
| §5.2.2 "declare what it cannot verify" | `oracleAdequacy.gaps` enriched to articulate the unverified surface |
| §3.4.4 verification grounded in deterministic sensors | scope derived from facts (write-set, sensor availability, grounding) — no model guess |
| §5.2.2 model-derived signals must declare confidence | LLM-named scope explicitly deferred to a later confidence-marked source |
| §5.2.3 don't let a weak verifier mislead learning | honest deterministic scope protects Phase 3's learning inputs |

---

## 6. Open items for the implementation plan
- The exact code-file extension allow-list for `writeSet` classification.
- Which existing variable carries the write-set at `service.ts:~1223`, and whether it is repo-relative (normalize if not).
- Lowest-churn way to surface `availableSensors` (return from `runSensors` vs a second `detectSensors` call at the site).
- The fixed categorical untested-surface list for non-code steps (keep short, honest, jargon-free).
