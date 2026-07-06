# Scoring-Plane Hardening (SP1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight approved gaps in the honest-scoring substrate: hard failures drag the score, `null` score stops masquerading as `0`, all failure codes get readable labels, the persisted refute/scoring reasoning is surfaced and mined, infra failures can't trigger instruction edits, the smaller aggregation-math bugs are fixed, the falsifier verifies the *targeted* improvement (paper item B), and the counterfactual judge gets hold-out discipline (paper item C).

**Architecture:** Everything is read-side/control-plane: projections over the existing `harness_transitions` / `workflow_step_runs` / `step_revision_signals` tables. **No migrations, no new LLM calls in the read path.** Contract changes are additive or type-widening (`number` → `number | null`). Daemon: `metrics/` (aggregate, verification, failure-labels) and `learning/` (diagnose, propose, canary, corpus, usecases, fetch). Desktop: `metrics-data.ts`, `StepPerformance.tsx`.

**Tech Stack:** TypeScript, zod contracts (`packages/contracts`), vitest, better-sqlite3 (test DBs in learning tests), React (desktop).

## Global Constraints

- **Read-side purity:** the score must stay a pure, deterministic function of captured evidence — no wall-clock, no randomness, no LLM calls (SP1 spec §7 replayability invariant).
- **No migrations.** All new data comes from columns that already exist.
- **Zero jargon in user-facing copy:** no "oracle", "sensor", "verdict", "refute" in any rendered string (SP1 success criterion 4). LLM-authored *data* (e.g. a refute reason) is exempt; labels/copy are not.
- **Confidence coefficients stay in one table:** `TIER_CONFIDENCE` in `apps/daemon/src/metrics/verification.ts` — no scattered magic numbers.
- **Surgical changes:** match existing style (compact, comment-dense-where-load-bearing); do not reformat neighboring code.
- Monorepo test commands: `pnpm -C apps/daemon test`, `pnpm -C apps/desktop test`, `pnpm -C packages/contracts test`. Single file: append the path, e.g. `pnpm -C apps/daemon test -- src/metrics/aggregate.steps.test.ts`.
- After every task: commit with a conventional-commit message ending in the Claude co-author trailer.

**Fixture ripple warning (applies to Tasks 3–6):** `StepMetrics` gains required fields. Every test fixture that builds a `StepMetrics` literal — `apps/daemon/src/learning/diagnose.test.ts` (`step()`), `apps/daemon/src/learning/canary.test.ts`, `apps/desktop/src/metrics/*.test.tsx` fixtures — must add: `quality.scoredSampleSize: <number>`, `verification.recentRefuteReasons: []`, `versionScoreDelta: null`, and `reconciliation` objects gain `refuteReason: null`. Run the workspace typecheck (`pnpm -C apps/daemon exec tsc --noEmit`, `pnpm -C apps/desktop exec tsc --noEmit`) after each contract-touching task to find every straggler; routes tests may also carry literals.

---

### Task 1: Complete the readable failure-label catalog

**Files:**
- Modify: `apps/daemon/src/metrics/failure-labels.ts`
- Test: `apps/daemon/src/metrics/failure-labels.test.ts`

**Interfaces:**
- Produces: `labelForFailure(code: string | null): string` (unchanged signature); `CATALOG` covers every `FailureCode` enum member.

- [ ] **Step 1: Write the failing test** — replace the existing assertions in `failure-labels.test.ts` with an enum-driven completeness + no-jargon guard (keep any existing cases that still hold):

```ts
import { describe, expect, it } from "vitest";
import { FailureCode } from "@orca/contracts";
import { labelForFailure } from "./failure-labels.js";

const BANNED = /\b(oracle|sensor|verdict|refute|veto)\b/i;

describe("labelForFailure", () => {
  it("has a curated, human-readable label for every FailureCode", () => {
    for (const code of FailureCode.options) {
      const label = labelForFailure(code);
      // Not the raw-ish fallback (code with underscores swapped for spaces)
      expect(label, code).not.toBe(code.replace(/_/g, " "));
      expect(label, code).not.toMatch(BANNED);
      expect(label.length, code).toBeGreaterThan(10);
    }
  });
  it("null → Unclassified problem", () => {
    expect(labelForFailure(null)).toBe("Unclassified problem");
  });
  it("unknown codes fall back to a de-underscored token", () => {
    expect(labelForFailure("weird_future_code")).toBe("weird future code");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/daemon test -- src/metrics/failure-labels.test.ts`
Expected: FAIL — 11 of the 14 codes hit the fallback (e.g. `refute_veto` → "refute veto", which also matches BANNED).

- [ ] **Step 3: Implement** — replace `CATALOG` in `failure-labels.ts` (delete the three dead entries `hard_constraint_violation`, `gate_rejected`, `escalated` — they are not in the `FailureCode` enum and can never fire):

```ts
// Deterministic, human-readable labels for categorical failure codes. No jargon.
// Complete over the FailureCode enum (contracts/harness) — the fallback below is
// for future codes only, and the test guards completeness.
const CATALOG: Record<string, string> = {
  invalid_output: "Produced output that didn't match what the step asked for",
  timeout: "Ran out of time before finishing",
  session_not_terminal: "Was still working when its result was requested",
  output_unavailable: "Finished without leaving a readable result",
  source_truncated: "The result was cut off before it could be read in full",
  goal_archived: "Stopped because the goal was archived",
  session_archived: "Stopped because its work session was archived",
  daemon_restart: "Interrupted by an app restart",
  guardrail_denied: "Blocked by a safety rule before it could act",
  evidence_veto: "Automated checks failed, so the completion was rejected",
  refute_veto: "An independent review rejected the completion",
  provider_error: "The AI provider failed mid-step",
  internal_error: "An internal error stopped the step",
  evaluation_failed: "Finished without producing a checkable result",
};
```

`labelForFailure` body is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C apps/daemon test -- src/metrics/failure-labels.test.ts`
Expected: PASS. Also run `pnpm -C apps/daemon test -- src/metrics` — the aggregate tests that assert the `invalid_output` label still pass (its wording is unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/failure-labels.ts apps/daemon/src/metrics/failure-labels.test.ts
git commit -m "fix(metrics): complete readable failure-label catalog over the FailureCode enum

11 of 14 real codes fell through to raw tokens (leaking 'refute veto' etc.);
3 catalog entries were dead codes that can never fire.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `classifyTier` — inconclusive refute falls to `self_reported` (spec §6 compliance)

**Files:**
- Modify: `apps/daemon/src/metrics/verification.ts:28-33`
- Test: `apps/daemon/src/metrics/verification.test.ts`

**Interfaces:**
- Produces: `classifyTier(t: TemplateTransition): VerificationTier` — now returns `"self_reported"` when no evidence exists and a refute *ran* but was `uncertain`/`unavailable`. Bare transitions (no evidence, no refute) stay `"unverified"`.

**Why:** SP1 spec §6: *"Refute `unavailable`/`uncertain` with no evidence → `self_reported` (if a self-report exists) else `unverified`."* The implementation returns `unverified`, silently discarding ~32% of reviewed completions (live-DB refute-unavailable rate) from the score.

- [ ] **Step 1: Write the failing test** — add to `verification.test.ts` (reuse its existing transition-fixture pattern; if it builds transitions inline, mirror the shape below):

```ts
it("no evidence + inconclusive refute → self_reported, not unverified (spec §6)", () => {
  const base = {
    id: "t1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
    boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
    telemetry: null, createdAt: "2026-05-01T00:00:00.000Z",
  };
  for (const verdict of ["unavailable", "uncertain"] as const) {
    const t = { templateVersion: 1, stepTemplateId: "s", transition: { ...base, refute: { verdict, triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] } } };
    expect(classifyTier(t as never), verdict).toBe("self_reported");
  }
  // A bare claim with no refute attempted stays unverified.
  const bare = { templateVersion: 1, stepTemplateId: "s", transition: { ...base, refute: null } };
  expect(classifyTier(bare as never)).toBe("unverified");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C apps/daemon test -- src/metrics/verification.test.ts`
Expected: FAIL — `classifyTier` returns `"unverified"` for both verdicts.

- [ ] **Step 3: Implement** — in `classifyTier`, replace lines 28-33:

```ts
  const rf = tr.refute;
  if (rf?.verdict === "upheld" || rf?.verdict === "refuted") return "ai_reviewed";
  // A refute RAN but was inconclusive (uncertain/unavailable): the self-report is
  // the only signal left — record it at self_reported confidence rather than
  // dropping the completion from the score entirely (spec §6). A bare transition
  // with no refute attempted has no pass/fail signal at all → unverified.
  if (rf != null) return "self_reported";
  return "unverified";
```

- [ ] **Step 4: Run tests**

Run: `pnpm -C apps/daemon test -- src/metrics`
Expected: PASS. (No existing aggregate test builds an inconclusive-refute completion; if one fails, its expectation predates spec §6 — update it to expect `self_reported` behavior and note it in the commit.)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/verification.ts apps/daemon/src/metrics/verification.test.ts
git commit -m "fix(metrics): inconclusive refute falls to self_reported tier per spec §6

A third of live refutes are 'unavailable'; those successes vanished from the
score instead of counting at low confidence.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Honest aggregation core — hard failures, nullable score, math fixes, refute reasons, per-step version delta

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts:80-125` (`StepMetrics`)
- Modify: `apps/daemon/src/metrics/aggregate.ts:229-382`
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts`

**Interfaces:**
- Produces (contract `StepMetrics`, consumed by Tasks 4–6):
  - `score: number | null` (was `number`; `null` = nothing scoreable, distinct from 0)
  - `quality.scoredSampleSize: number` (the score denominator: conclusive completions + hard-failed runs)
  - `quality.oracleSufficientRate: number | null` (`null` when no evidence completions)
  - `verification.recentRefuteReasons: string[]` (≤3, newest first)
  - `reconciliation.refuteReason: string | null`
  - `versionScoreDelta: number | null` (top-level; latest-vs-prior version step score delta on the 0..1 scale, `null` unless both sides have ≥ `VERSION_MIN = 2` scored samples)

- [ ] **Step 1: Contract change** — in `packages/contracts/src/metrics/index.ts` edit `StepMetrics`:

```ts
  score: z.number().nullable(),
```

in `quality`:

```ts
    verdictPassRate: z.number(), sensorPassRate: z.number().nullable(), oracleSufficientRate: z.number().nullable(),
    // Denominator of `score`: conclusive completions + hard-failed runs. Workflow
    // health must weight by THIS, not sampleSize — the score was computed over it.
    scoredSampleSize: z.number().int().nonnegative(),
```

in `verification`:

```ts
    falseAcceptanceRate: z.number(), artifacts: z.array(EvidenceArtifact),
    // The independent reviewer's own words for recently overturned claims (≤3).
    recentRefuteReasons: z.array(z.string()),
```

in `reconciliation`:

```ts
  reconciliation: z.object({
    claimedComplete: z.boolean(), verifiedTierLabel: z.string(), refuted: z.boolean(),
    refuteReason: z.string().nullable(),
  }).strict().nullable(),
```

after `versionBoundaries`:

```ts
  // Latest-vs-prior template version delta of THIS step's honest score (0..1 scale);
  // null unless both versions have enough scored samples in the window.
  versionScoreDelta: z.number().nullable(),
```

- [ ] **Step 2: Write the failing tests** — append to `aggregate.steps.test.ts` (reuses the existing `sc()` helper and `names` map):

```ts
  it("hard failures drag the score: a run that dies without a step_complete counts as 0", () => {
    // One verified pass (conf 1.0 via sensors+sufficient oracle) + one hard-failed run.
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z");
    p1.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T01:00:00.000Z", finishedAt: "2026-05-01T01:05:00.000Z", blockedReason: "provider crashed", templateVersion: 1 },
    ];
    const [step] = computeStepMetrics({ transitions: [p1], stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(50); // (1.0 + 0) / 2 — not 100
    expect(step.quality.scoredSampleSize).toBe(2);
  });

  it("score is null (not 0) when nothing is scoreable", () => {
    // Only an evaluation_failed completion on a passed run: unverified, no hard fail.
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "e1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null, refute: null,
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "evaluation_failed" } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBeNull();
    expect(step.quality.scoredSampleSize).toBe(0);
  });

  it("a self_reported completion (inconclusive refute) scores 0.3, not dropped", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "u1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "unavailable", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(30);
    expect(step.verification.tier).toBe("self_reported");
  });

  it("oracleSufficientRate is null (not 0) when no evidence completions exist", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "n1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.oracleSufficientRate).toBeNull();
  });

  it("failure clusters dedupe step_complete failures to the FINAL attempt (recovered veto not double-counted)", () => {
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:10:00.000Z");
    const ts = [sc("v1", "r1", "s", "failed", true, "2026-05-01T00:00:00.000Z"), p1];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: "vetoed", templateVersion: 1 },
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:06:00.000Z", finishedAt: "2026-05-01T00:10:00.000Z", blockedReason: null, templateVersion: 1 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    // The vetoed attempt "v1" was recovered; it must not survive as a failure cluster.
    expect(step.failureClusters).toEqual([]);
  });

  it("surfaces refute reasons: recentRefuteReasons + reconciliation.refuteReason", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "x", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "refuted", triggered_by: [], risk_class: "high", reason: "claimed tests ran but none exist", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.verification.recentRefuteReasons).toEqual(["claimed tests ran but none exist"]);
    expect(step.reconciliation?.refuteReason).toBe("claimed tests ran but none exist");
  });

  it("versionScoreDelta: per-step latest-vs-prior version score delta with VERSION_MIN gating", () => {
    const mk = (id: string, run: string, verdict: "passed" | "failed", v: number, at: string) => {
      const t = sc(id, run, "s", verdict, true, at);
      t.templateVersion = v;
      return t;
    };
    // v1: two failed evidence completions (score 0); v2: two passed (conf 1.0 needs sensors — sc() has none, so ai-tier? no: evidence present, no sensors → ai_reviewed 0.55).
    const ts = [
      mk("a", "r1", "failed", 1, "2026-05-01T00:00:00.000Z"), mk("b", "r2", "failed", 1, "2026-05-01T01:00:00.000Z"),
      mk("c", "r3", "passed", 2, "2026-05-02T00:00:00.000Z"), mk("d", "r4", "passed", 2, "2026-05-02T01:00:00.000Z"),
    ];
    const runs: TemplateStepRun[] = ts.map((t) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1,
      status: t.transition.evidence!.verdict === "passed" ? "passed" : "failed",
      startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
      blockedReason: null, templateVersion: t.templateVersion,
    }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    // v2 mean = 0.55 (ai_reviewed passes), v1 mean = 0 → delta 0.55
    expect(step.versionScoreDelta).toBeCloseTo(0.55);
  });
```

Also update the two existing expectations this task intentionally changes:
- In `"does NOT credit an evaluation-failed completion as a verified pass (#8)"`: replace `expect(step.score).not.toBe(100);` with `expect(step.score).toBeNull();`.
- No other existing test in this file scores hard-failed runs, so the rest stand.

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `pnpm -C apps/daemon test -- src/metrics/aggregate.steps.test.ts`
Expected: the 7 new tests FAIL (plus the edited one); pre-existing ones pass.

- [ ] **Step 4: Implement in `aggregate.ts`.** Near line 8, add:

```ts
export const SAMPLE_MIN = 5;
// Per-side minimum of SCORED samples before a per-step version delta is emitted.
// A designed floor (not a significance test) — same spirit as SAMPLE_MIN.
export const VERSION_MIN = 2;
```

Replace the scoring region (current lines 250-266) — and **move the `finals` IIFE (current lines 273-280) up above it** (delete it from CHANNEL 2), since hard-failure detection needs it:

```ts
    // Final attempt per run (step-run rows) — used by scoring (hard failures) and cost.
    const finals = (() => {
      const byKey = new Map<string, TemplateStepRun>();
      for (const r of stepRuns) {
        const k = r.workflowRunId; const prev = byKey.get(k);
        if (!prev || r.attempt > prev.attempt) byKey.set(k, r);
      }
      return [...byKey.values()];
    })();

    // Verification-weighted score (SP1): each conclusive completion contributes its
    // tier confidence when it passed, 0 when it failed; a self_reported completion
    // (claim stands, nothing independent) contributes the self_reported confidence.
    // Hard failures — runs that died without ever emitting a step_complete — count
    // as 0 in the denominator: a step that fails often must not keep a high score
    // just because its failures never reached scoring. Pure function of evidence.
    const tierByCompletion = new Map(finalStepCompletes.map((t) => [t, classifyTier(t)] as const));
    const conclusive = finalStepCompletes.filter((t) => tierByCompletion.get(t) !== "unverified");
    const completeRunIds = new Set(finalStepCompletes.map((t) => t.transition.workflowRunId).filter((x): x is string => x != null));
    const hardFailedFinals = finals.filter((r) => FAILED_STATUSES.has(r.status) && !completeRunIds.has(r.workflowRunId));
    const contribution = (t: (typeof stepCompletes)[number]) =>
      vFail(t) ? 0 : TIER_CONFIDENCE[tierByCompletion.get(t)!];
    const scoreOver = (completes: typeof finalStepCompletes, hardFails: number): { n: number; value: number | null } => {
      const conc = completes.filter((t) => tierByCompletion.get(t) !== "unverified");
      const n = conc.length + hardFails;
      return n === 0 ? { n, value: null } : { n, value: conc.reduce((acc, t) => acc + contribution(t), 0) / n };
    };
    const headline = scoreOver(finalStepCompletes, hardFailedFinals.length);
    const scoreValue = headline.value;
    const scoredSampleSize = headline.n;
    const stepTier = strongestTier(conclusive.map((t) => tierByCompletion.get(t)!));
    const falseAccept = conclusive.filter((t) => t.transition.refute?.verdict === "refuted").length;
    const falseAcceptanceRate = conclusive.length === 0 ? 0 : falseAccept / conclusive.length;

    // Per-step, per-version score delta (latest vs prior version in the window): the
    // falsifier's "did the TARGETED step improve" signal (0..1 scale).
    let versionScoreDelta: number | null = null;
    const versionsPresent = [...new Set(finalStepCompletes.map((t) => t.templateVersion))].sort((a, b) => b - a);
    if (versionsPresent.length >= 2) {
      const [latestV, priorV] = versionsPresent;
      const forVersion = (v: number) => scoreOver(
        finalStepCompletes.filter((t) => t.templateVersion === v),
        hardFailedFinals.filter((r) => r.templateVersion === v).length,
      );
      const a = forVersion(latestV), b = forVersion(priorV);
      if (a.n >= VERSION_MIN && b.n >= VERSION_MIN && a.value != null && b.value != null) versionScoreDelta = a.value - b.value;
    }
```

Replace `oracleSufficientRate` (current lines 265-266):

```ts
    // No evidence completions → null (unknown), NEVER 0: absence of an oracle is
    // not the same fact as an inadequate oracle. (Mirrors sensorPassRate.)
    const oracleSufficientRate = evidenceCompletes.length === 0 ? null :
      evidenceCompletes.filter((t) => t.transition.evidence!.oracleAdequacy.sufficient).length / evidenceCompletes.length;
```

Replace the failure-cluster source filter (current line 292):

```ts
    // Failure clusters (categorical, deterministic). step_complete failures dedupe
    // to FINAL attempts — a recovered veto is not an outstanding failure — while
    // other boundaries (tool_gate etc.) keep every occurrence.
    const finalCompleteIds = new Set(finalStepCompletes.map((t) => t.transition.id));
    const failedTs = ts.filter((t) =>
      FAILED_OUTCOME.has(t.transition.telemetry?.outcome.status ?? "") &&
      (t.transition.boundary !== "step_complete" || finalCompleteIds.has(t.transition.id)));
```

Add refute reasons + extend reconciliation (replace current lines 317-319):

```ts
    // The independent reviewer's own words for the most recent overturned claims —
    // the WHY behind falseAcceptanceRate, surfaced to humans and mined by diagnosis.
    const recentRefuteReasons = [...finalStepCompletes]
      .filter((t) => t.transition.refute?.verdict === "refuted" && t.transition.refute.reason)
      .sort((x, y) => y.transition.createdAt.localeCompare(x.transition.createdAt))
      .slice(0, 3)
      .map((t) => t.transition.refute!.reason!);

    const reconciliation = conclusive.length === 0 ? null : {
      claimedComplete: true, verifiedTierLabel: TIER_LABEL[stepTier], refuted: falseAccept > 0,
      refuteReason: recentRefuteReasons[0] ?? null,
    };
```

Update the `step` literal (current lines 357-381):
- `score: scoreValue == null ? null : Math.round(scoreValue * 100),`
- add `scoredSampleSize,` inside `quality` (after `verifiedSampleSize`)
- add `recentRefuteReasons,` inside `verification` (after `artifacts: buildArtifacts({...})`)
- in the `buildArtifacts` call, pass `oracleSufficientRate: oracleSufficientRate ?? 0,` (the artifact is only built when `hasEvidence`, where the rate is non-null; the `?? 0` is for the type)
- add `versionScoreDelta,` next to `versionBoundaries`

- [ ] **Step 5: Run daemon metrics tests + typecheck**

Run: `pnpm -C apps/daemon test -- src/metrics && pnpm -C apps/daemon exec tsc --noEmit`
Expected: metrics tests PASS. Typecheck will flag downstream consumers (`learning/diagnose.ts` reading `score`/`oracleSufficientRate`, desktop later). For **this task**, patch only what daemon typecheck demands with behavior-preserving guards (Task 5 does the real diagnosis work): in `diagnose.ts`, temporarily `step.score != null && step.score < 80` for R1, `(step.quality.oracleSufficientRate ?? 0) < 0.5` for R4, `(a.evidence.metricSnapshot.score ?? 101) - (b.evidence.metricSnapshot.score ?? 101)` for the sort, and widen `DiagnosisBundle.metricSnapshot.score`/`oracleSufficientRate` types to `number | null` **plus** the same nullable widening in `EvidenceSnapshot.metricSnapshot` (`packages/contracts/src/learning/index.ts:34-39`). Update `diagnose.test.ts`/routes fixtures for the new required `StepMetrics` fields (`scoredSampleSize`, `recentRefuteReasons`, `versionScoreDelta`, `reconciliation.refuteReason`).

Run: `pnpm -C apps/daemon test`
Expected: full daemon suite PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/metrics/index.ts packages/contracts/src/learning/index.ts apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.steps.test.ts apps/daemon/src/learning/diagnose.ts apps/daemon/src/learning/diagnose.test.ts
git commit -m "feat(metrics): honest score core — hard failures count, null≠0, refute reasons, per-step version delta

- runs that die without a step_complete now enter the score denominator as 0
- StepMetrics.score is nullable: 'nothing scoreable' no longer renders as 0
- oracleSufficientRate null when no evidence (absence ≠ inadequacy)
- step_complete failure clusters dedupe to final attempts
- recentRefuteReasons + reconciliation.refuteReason expose the reviewer's WHY
- versionScoreDelta: per-step latest-vs-prior version honest-score delta

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Desktop — nullable score, aligned workflow-health weights, refute reason in the step detail

**Files:**
- Modify: `apps/desktop/src/metrics/metrics-data.ts:26-47`
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx:85-95,146-150`
- Test: `apps/desktop/src/metrics/metrics-data.test.ts`, `apps/desktop/src/metrics/StepPerformance.test.tsx`, `apps/desktop/src/metrics/no-jargon.test.tsx`

**Interfaces:**
- Consumes: `StepMetrics.score: number | null`, `quality.scoredSampleSize`, `reconciliation.refuteReason` (Task 3).
- Produces: `statusForStep` keys off `score == null`; `workflowHealthFromSteps` weights by `scoredSampleSize`.

- [ ] **Step 1: Update fixtures + write failing tests.** All `StepMetrics` fixtures in desktop tests gain `scoredSampleSize` (set it to the old `verifiedSampleSize` value), `recentRefuteReasons: []`, `versionScoreDelta: null`, and `refuteReason: null` on any `reconciliation`. Then add to `metrics-data.test.ts`:

```ts
it("statusForStep: null score → unverified; 0 score → degraded", () => {
  expect(statusForStep(step({ score: null, quality: { ...step().quality, scoredSampleSize: 0, verifiedSampleSize: 0 } }))).toBe("unverified");
  expect(statusForStep(step({ score: 0 }))).toBe("degraded");
});

it("workflowHealthFromSteps weights by scoredSampleSize and skips null-score steps", () => {
  const a = step({ score: 100, sampleSize: 50, quality: { ...step().quality, scoredSampleSize: 2 } });
  const b = step({ score: 0, sampleSize: 2, quality: { ...step().quality, scoredSampleSize: 8 } });
  const c = step({ score: null, sampleSize: 40, quality: { ...step().quality, scoredSampleSize: 0 } });
  // (100*2 + 0*8) / 10 = 20 — NOT dominated by a's 50 unscored runs.
  expect(workflowHealthFromSteps([a, b, c])).toBe(20);
});
```

(If `metrics-data.test.ts` has no `step()` fixture builder, copy the one from `StepPerformance.test.tsx` / `diagnose.test.ts` shape with all required fields.)

Add to `StepPerformance.test.tsx`:

```ts
it("renders the reviewer's reason when a claim was overturned", () => {
  const s = step({
    reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: true, refuteReason: "claimed tests ran but none exist" },
  });
  render(<StepRow step={s} index={0} isLast open onToggle={() => {}} />);
  expect(screen.getByText(/claimed tests ran but none exist/)).toBeInTheDocument();
  expect(screen.getByText(/overturned/i)).toBeInTheDocument();
});

it("renders 'needs a check' for a null score and a number for 0", () => {
  const { rerender } = render(<StepRow step={step({ score: null })} index={0} isLast open={false} onToggle={() => {}} />);
  expect(screen.getByText(/needs a check/i)).toBeInTheDocument();
  rerender(<StepRow step={step({ score: 0 })} index={0} isLast open={false} onToggle={() => {}} />);
  expect(screen.getByText("0")).toBeInTheDocument();
});
```

(Match the file's existing render/import idiom exactly — it already renders `StepRow`.)

- [ ] **Step 2: Run to verify failures**

Run: `pnpm -C apps/desktop test -- src/metrics`
Expected: new tests FAIL (plus type errors until Step 3).

- [ ] **Step 3: Implement.** `metrics-data.ts` — replace `workflowHealthFromSteps` and `statusForStep`:

```ts
// Sample-weighted mean of scored step scores. Weight by scoredSampleSize — the
// denominator each score was actually computed over — not raw sampleSize, so a
// step with 50 runs but 2 scored ones doesn't put weight-50 on a 2-sample score.
export function workflowHealthFromSteps(steps: StepMetrics[]): number | null {
  const scored = steps.filter((s) => s.score != null);
  const wsum = scored.reduce((n, s) => n + s.quality.scoredSampleSize, 0);
  if (wsum === 0) return null;
  return Math.round(scored.reduce((n, s) => n + s.score! * s.quality.scoredSampleSize, 0) / wsum);
}
```

```ts
// score === null ⇔ nothing was scoreable (no conclusive verdicts AND no hard
// failures) — that's a coverage gap, not a grade. A numeric 0 is a real grade.
export function statusForStep(step: StepMetrics): StepStatus {
  return step.score == null ? "unverified" : statusForScore(step.score);
}
```

`StepPerformance.tsx` — in the score cell (lines 85-95), change the condition so TypeScript narrows the nullable score:

```tsx
        <div style={{ textAlign: "right" }}>
          {step.score == null ? (
            // No conclusive verdict — show the coverage gap, not a failing grade it didn't earn.
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: m.color }} title="No independent check ran for this step yet — it's an opportunity to strengthen, not a failing grade.">needs a check</span>
          ) : (
            <>
              <span style={{ fontSize: 20, fontWeight: 600, color: m.color, letterSpacing: -0.5 }}>{step.score}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100 {gradeFor(step.score)}</span>
            </>
          )}
        </div>
```

In the reconciliation block (lines 146-150), append the reviewer's reason:

```tsx
            {step.reconciliation && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)", fontSize: 12, color: step.reconciliation.refuted ? "var(--err)" : "var(--text-2)" }}>
                The AI <b>claimed</b> this step complete. Independently verified: <b>{step.reconciliation.verifiedTierLabel.toLowerCase()}</b>{step.reconciliation.refuted ? " — but the independent check overturned it." : "."}
                {step.reconciliation.refuted && step.reconciliation.refuteReason && (
                  <div style={{ marginTop: 4 }}>Why it was overturned: “{step.reconciliation.refuteReason}”</div>
                )}
              </div>
            )}
```

- [ ] **Step 4: Run the desktop suite + typecheck**

Run: `pnpm -C apps/desktop test && pnpm -C apps/desktop exec tsc --noEmit`
Expected: PASS — including `no-jargon.test.tsx` (the new copy "Why it was overturned" contains no banned words) and `MetricsPage.test.tsx` (health tile still consumes `number | null`).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics
git commit -m "feat(metrics-ui): nullable score, health weighted by scored samples, reviewer reason on overturned claims

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Diagnosis mines the WHY and refuses infra-caused instruction edits

**Files:**
- Modify: `apps/daemon/src/learning/fetch.ts`
- Modify: `apps/daemon/src/learning/diagnose.ts`
- Modify: `apps/daemon/src/learning/propose.ts:16-24`
- Test: `apps/daemon/src/learning/fetch.test.ts`, `apps/daemon/src/learning/diagnose.test.ts`, `apps/daemon/src/learning/propose.test.ts`

**Interfaces:**
- Consumes: `StepMetrics.verification.recentRefuteReasons`, `StepMetrics.versionScoreDelta` (Task 3).
- Produces:
  - `TemplateRevisionSignal` gains `supersededReason: string | null` (the superseded scoring's own `reason`).
  - `DiagnosisBundle.evidence` gains `refuteReasons: string[]` and `supersededReasons: string[]`; `metricSnapshot.versionDelta` becomes the **step's** `versionScoreDelta` (no longer the template-level verificationStrength delta).
  - `chooseRule`: R1 requires non-null score AND not infra-dominated failures.
  - `buildProposePayload` forwards `refuteReasons` + `supersededReasons` to the proposal LLM.

- [ ] **Step 1: Write the failing tests.** In `diagnose.test.ts` add (extend the `step()`/`detail()` fixtures with the Task-3 fields if Step 5 of Task 3 didn't already):

```ts
  it("R1 does not fire on a null score (no gradient) nor on infra-dominated failures", () => {
    const nullScore = step({ score: null, failureClusters: [] });
    expect(diagnoseTemplate({ detail: detail([nullScore]), signals: [], stepInstructions: instr })).toHaveLength(0);

    const infra = step({
      score: 40,
      failureClusters: [
        { failureCode: "provider_error", boundary: "step_complete", count: 6, sampleTransitionIds: ["t1"] },
        { failureCode: "invalid_output", boundary: "step_complete", count: 2, sampleTransitionIds: ["t2"] },
      ],
    });
    // invalid_output count (2) < K, so R2 can't fire; R1 must refuse: infra majority.
    expect(diagnoseTemplate({ detail: detail([infra]), signals: [], stepInstructions: instr })).toHaveLength(0);

    const addressable = step({ score: 40, failureClusters: [{ failureCode: "invalid_output", boundary: "step_complete", count: 2, sampleTransitionIds: ["t2"] }] });
    const out = diagnoseTemplate({ detail: detail([addressable]), signals: [], stepInstructions: instr });
    expect(out).toHaveLength(1);
    expect(out[0].targetedFailureMode.rule).toBe("R1");
  });

  it("bundle carries refute reasons, superseded reasons, and the step's own version delta", () => {
    const s = step({
      verification: { ...step().verification, recentRefuteReasons: ["claimed tests ran but none exist"] },
      versionScoreDelta: 0.25,
    });
    const signals = [
      { id: "rs1", stepTemplateId: "s1", feedbackText: "fix the schema", supersededReason: "output missed the acceptance list", createdAt: "2026-05-01T00:00:00.000Z" },
      { id: "rs2", stepTemplateId: "s1", feedbackText: "still wrong", supersededReason: null, createdAt: "2026-05-01T00:01:00.000Z" },
      { id: "rs3", stepTemplateId: "s1", feedbackText: "again", supersededReason: null, createdAt: "2026-05-01T00:02:00.000Z" },
    ];
    const out = diagnoseTemplate({ detail: detail([s]), signals, stepInstructions: instr });
    expect(out[0].evidence.refuteReasons).toEqual(["claimed tests ran but none exist"]);
    expect(out[0].evidence.supersededReasons).toEqual(["output missed the acceptance list"]);
    expect(out[0].evidence.metricSnapshot.versionDelta).toBe(0.25);
  });
```

(Existing `signals` fixtures in this file gain `supersededReason: null`.)

In `fetch.test.ts`, extend the existing revision-signal round-trip test: insert a row whose `superseded_scoring_json` is `'{"successScore":0.9,"reason":"output missed the acceptance list"}'` and one with malformed JSON `'not json'`, then assert `supersededReason` is `"output missed the acceptance list"` and `null` respectively (follow the file's existing in-memory DB setup pattern).

In `propose.test.ts`, extend the payload test:

```ts
  expect(payload.refuteReasons).toEqual(bundle.evidence.refuteReasons);
  expect(payload.supersededReasons).toEqual(bundle.evidence.supersededReasons);
```

- [ ] **Step 2: Run to verify failures**

Run: `pnpm -C apps/daemon test -- src/learning`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement.** `learning/fetch.ts` — full replacement:

```ts
import type Database from "better-sqlite3";

export type TemplateRevisionSignal = {
  id: string;
  stepTemplateId: string;
  feedbackText: string | null;
  // The superseded scoring's own `reason` — why the pre-revision result was
  // considered done. Paired with feedbackText (why the user disagreed), it is
  // the claim-vs-correction pair the proposal LLM learns from.
  supersededReason: string | null;
  createdAt: string;
};

function supersededReasonFrom(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason : null;
  } catch {
    return null;
  }
}

// Portable JSON-free join: step_revision_signals -> workflow_step_runs (step_template_id)
// -> workflow_runs (template_id), windowed on the signal's created_at.
export function listRevisionSignalsByTemplate(
  db: Database.Database, templateId: string, sinceIso: string, untilIso: string,
): TemplateRevisionSignal[] {
  const rows = db.prepare(
    `SELECT srs.id AS id, wsr.step_template_id AS step_template_id,
            srs.feedback_text AS feedback_text, srs.superseded_scoring_json AS superseded_scoring_json,
            srs.created_at AS created_at
     FROM step_revision_signals srs
     JOIN workflow_step_runs wsr ON wsr.id = srs.step_run_id
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     WHERE wr.template_id = ? AND srs.created_at >= ? AND srs.created_at < ?
     ORDER BY srs.created_at ASC, srs.id ASC`
  ).all(templateId, sinceIso, untilIso) as {
    id: string; step_template_id: string; feedback_text: string | null;
    superseded_scoring_json: string | null; created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id, stepTemplateId: r.step_template_id, feedbackText: r.feedback_text,
    supersededReason: supersededReasonFrom(r.superseded_scoring_json), createdAt: r.created_at,
  }));
}
```

`learning/diagnose.ts` — full replacement:

```ts
import type { StepMetrics, TargetedFailureMode, TemplateMetricsDetail } from "@orca/contracts";
import type { TemplateRevisionSignal } from "./fetch.js";

export const SAMPLE_MIN = 5;
const K = 3; // R2 min cluster count
const M = 3; // R3 min feedback-signal count
const TOP_N = 3;

export const INSTRUCTION_ADDRESSABLE: ReadonlySet<string> = new Set([
  "invalid_output", "output_unavailable", "source_truncated", "evidence_veto", "guardrail_denied",
]);

// Failure codes whose cause is the environment/provider, not the step's
// instructions — an instruction edit cannot fix these.
export const INFRA_CODES: ReadonlySet<string> = new Set([
  "provider_error", "internal_error", "daemon_restart", "timeout",
  "session_not_terminal", "goal_archived", "session_archived",
]);

export type DiagnosisBundle = {
  stepTemplateId: string;
  currentInstructions: string;
  targetedFailureMode: TargetedFailureMode;
  evidence: {
    sampleTransitionIds: string[];
    revisionSignalIds: string[];
    revisionFeedbackTexts: string[];
    // The independent reviewer's stated reasons for overturning claims (Task 3).
    refuteReasons: string[];
    // The superseded scorings' own `reason` — the claim the user then corrected.
    supersededReasons: string[];
    metricSnapshot: { score: number | null; verdictPassRate: number; oracleSufficientRate: number | null; versionDelta: number | null };
  };
};

// R1 is cause-agnostic, so gate it: when the step's clustered failures are mostly
// infrastructure, a low score is not an instructions problem — proposing an
// instruction edit would optimize against the wrong signal.
function infraDominated(step: StepMetrics): boolean {
  let infra = 0, other = 0;
  for (const c of step.failureClusters) {
    if (c.failureCode != null && INFRA_CODES.has(c.failureCode)) infra += c.count;
    else other += c.count;
  }
  return infra > other;
}

function chooseRule(step: StepMetrics, feedbackSignals: TemplateRevisionSignal[]): TargetedFailureMode | null {
  // R3 — revision-signal density (highest signal; instruction-related regardless of code).
  if (feedbackSignals.length >= M) {
    return { rule: "R3", failureCode: null, clusterCount: null, signalCount: feedbackSignals.length };
  }
  // R2 — dominant instruction-addressable cluster.
  const cluster = step.failureClusters
    .filter((c) => c.failureCode != null && INSTRUCTION_ADDRESSABLE.has(c.failureCode) && c.count >= K)
    .sort((a, b) => b.count - a.count)[0];
  if (cluster) {
    return { rule: "R2", failureCode: cluster.failureCode, clusterCount: cluster.count, signalCount: null };
  }
  // R4 — false confidence (high pass, low/absent oracle).
  if (step.quality.verdictPassRate >= 0.8 && (step.quality.oracleSufficientRate ?? 0) < 0.5) {
    return { rule: "R4", failureCode: null, clusterCount: null, signalCount: null };
  }
  // R1 — underperforming headline (degraded/watch ~ score < 80). Needs a real score
  // (null = no gradient to act on) and a non-infra failure picture.
  if (step.score != null && step.score < 80 && !infraDominated(step)) {
    return { rule: "R1", failureCode: null, clusterCount: null, signalCount: null };
  }
  return null;
}

export function diagnoseTemplate(input: {
  detail: TemplateMetricsDetail;
  signals: TemplateRevisionSignal[];
  stepInstructions: Map<string, string>;
}): DiagnosisBundle[] {
  const signalsByStep = new Map<string, TemplateRevisionSignal[]>();
  for (const s of input.signals) {
    if (s.feedbackText == null) continue;
    (signalsByStep.get(s.stepTemplateId) ?? signalsByStep.set(s.stepTemplateId, []).get(s.stepTemplateId)!).push(s);
  }

  const eligible = input.detail.steps.filter((s) => s.confidence === "ok" && s.sampleSize >= SAMPLE_MIN);
  const bundles: DiagnosisBundle[] = [];
  for (const step of eligible) {
    const feedback = signalsByStep.get(step.stepTemplateId) ?? [];
    const mode = chooseRule(step, feedback);
    if (!mode) continue;
    const sampleTransitionIds = step.failureClusters.flatMap((c) => c.sampleTransitionIds).slice(0, 6);
    bundles.push({
      stepTemplateId: step.stepTemplateId,
      currentInstructions: input.stepInstructions.get(step.stepTemplateId) ?? "",
      targetedFailureMode: mode,
      evidence: {
        sampleTransitionIds,
        revisionSignalIds: feedback.map((f) => f.id),
        revisionFeedbackTexts: feedback.map((f) => f.feedbackText!).slice(0, 5),
        refuteReasons: step.verification.recentRefuteReasons.slice(0, 3),
        supersededReasons: feedback.map((f) => f.supersededReason).filter((r): r is string => r != null).slice(0, 5),
        // The step's OWN honest-score delta across versions — not the template-level
        // verificationStrength delta the old code hardcoded regardless of diagnosis.
        metricSnapshot: { score: step.score, verdictPassRate: step.quality.verdictPassRate, oracleSufficientRate: step.quality.oracleSufficientRate, versionDelta: step.versionScoreDelta },
      },
    });
  }
  // Worst-first (null scores last — they carry no gradient), capped.
  return bundles.sort((a, b) => (a.evidence.metricSnapshot.score ?? 101) - (b.evidence.metricSnapshot.score ?? 101)).slice(0, TOP_N);
}
```

`learning/propose.ts` — extend `buildProposePayload`:

```ts
export function buildProposePayload(bundle: DiagnosisBundle): Record<string, unknown> {
  return {
    instruction: INSTRUCTION,
    currentInstructions: bundle.currentInstructions,
    targetedFailureMode: bundle.targetedFailureMode,
    revisionFeedbackTexts: bundle.evidence.revisionFeedbackTexts,
    refuteReasons: bundle.evidence.refuteReasons,
    supersededReasons: bundle.evidence.supersededReasons,
    metricSnapshot: bundle.evidence.metricSnapshot,
  };
}
```

- [ ] **Step 4: Run learning tests + full daemon suite**

Run: `pnpm -C apps/daemon test -- src/learning && pnpm -C apps/daemon test`
Expected: PASS. (`usecases.ts` line 95 copies `bundle.evidence.metricSnapshot` into the proposal's `EvidenceSnapshot` — the contract was widened to nullable in Task 3 Step 5, so it parses.)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning packages/contracts/src/learning/index.ts
git commit -m "feat(learning): diagnosis mines refute + superseded reasons; R1 refuses infra-caused edits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Falsifier verifies the targeted improvement (paper item B)

**Files:**
- Modify: `packages/contracts/src/learning/index.ts:114-117` (`TemplateInstructionProposal` enrichment fields)
- Modify: `apps/daemon/src/learning/canary.ts`
- Modify: `apps/daemon/src/learning/usecases.ts:105-109` (`listProposalsEnriched`)
- Test: `apps/daemon/src/learning/canary.test.ts`

**Interfaces:**
- Consumes: `StepMetrics.versionScoreDelta` (Task 3).
- Produces: enriched proposals gain `targetDelta: number | null` and `targetImproved: boolean | null`; `enrichWithRegression(proposals, summary, steps)` gains a third parameter (default `[]`).

- [ ] **Step 1: Contract** — in `TemplateInstructionProposal`, after `watchedDeltas`:

```ts
  // server-enriched (F4): the applied version's effect on the TARGETED step's own
  // honest score (0..1 delta). The invariants check above guards against regression;
  // this guards against a proposal that fails its own purpose.
  targetDelta: z.number().nullable().optional(),
  targetImproved: z.boolean().nullable().optional(),
```

- [ ] **Step 2: Write the failing test** — add to `canary.test.ts` (reuse its existing proposal/summary fixtures; extend the summary fixture's `versions` so the applied version has ≥5 runs, as the existing regression test already does):

```ts
  it("enriches with targetDelta/targetImproved from the targeted step's versionScoreDelta", () => {
    const steps = [
      { ...stepFixture, stepTemplateId: "s1", versionScoreDelta: 0.2 },
      { ...stepFixture, stepTemplateId: "other", versionScoreDelta: -0.4 },
    ];
    const [p] = enrichWithRegression([appliedProposal], summaryWithComparison, steps as never);
    expect(p.targetDelta).toBeCloseTo(0.2);
    expect(p.targetImproved).toBe(true);
  });

  it("targetImproved is null when the step has no version delta yet", () => {
    const steps = [{ ...stepFixture, stepTemplateId: "s1", versionScoreDelta: null }];
    const [p] = enrichWithRegression([appliedProposal], summaryWithComparison, steps as never);
    expect(p.targetDelta).toBeNull();
    expect(p.targetImproved).toBeNull();
  });
```

(`stepFixture`/`appliedProposal`/`summaryWithComparison` = the file's existing fixture names — match whatever it actually calls them; `appliedProposal.stepTemplateId` must be `"s1"`.)

- [ ] **Step 3: Run to verify failure**

Run: `pnpm -C apps/daemon test -- src/learning/canary.test.ts`
Expected: FAIL — `targetDelta` is `undefined`.

- [ ] **Step 4: Implement** — `canary.ts` full replacement:

```ts
import type { StepMetrics, TemplateInstructionProposal, TemplateMetricsSummary } from "@orca/contracts";

export const REGRESSION_THRESHOLD = 0.1;
export const SAMPLE_MIN = 5;

export function enrichWithRegression(
  proposals: TemplateInstructionProposal[], summary: TemplateMetricsSummary, steps: StepMetrics[] = [],
): TemplateInstructionProposal[] {
  const vc = summary.versionComparison;
  return proposals.map((p) => {
    if (p.status !== "applied" || p.appliedAsVersion == null) return p;
    // Only judge once the applied version has accrued enough runs.
    const versionRuns = summary.versions.find((v) => v.version === p.appliedAsVersion)?.runs ?? 0;
    if (versionRuns < SAMPLE_MIN || !vc || vc.latest !== p.appliedAsVersion) {
      return { ...p, regressionDetected: false, watchedDeltas: {}, targetDelta: null, targetImproved: null };
    }
    const watchedDeltas: Record<string, number | null> = {};
    let regressed = false;
    for (const dim of p.invariantsPreserved) {
      const delta = vc.byDimension[dim] ?? null;
      watchedDeltas[dim] = delta;
      if (delta != null && delta < -REGRESSION_THRESHOLD) regressed = true;
    }
    // The falsifier must also check the proposal's own goal: did the TARGETED step's
    // honest score move under the applied version? Invariants alone let a proposal
    // fail its purpose and still read as a success.
    const targetDelta = steps.find((s) => s.stepTemplateId === p.stepTemplateId)?.versionScoreDelta ?? null;
    return { ...p, regressionDetected: regressed, watchedDeltas, targetDelta, targetImproved: targetDelta == null ? null : targetDelta > 0 };
  });
}
```

`usecases.ts` `listProposalsEnriched` — pass the steps:

```ts
  return detail ? enrichWithRegression(proposals, detail.summary, detail.steps) : proposals;
```

- [ ] **Step 5: Run tests**

Run: `pnpm -C apps/daemon test -- src/learning && pnpm -C packages/contracts test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/learning/index.ts apps/daemon/src/learning/canary.ts apps/daemon/src/learning/usecases.ts apps/daemon/src/learning/canary.test.ts
git commit -m "feat(learning): falsifier verifies the targeted step improved, not just invariants held

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Judge hold-out discipline (paper item C)

**Files:**
- Modify: `apps/daemon/src/learning/corpus.ts`
- Modify: `apps/daemon/src/learning/usecases.ts:27-28`
- Test: `apps/daemon/src/learning/corpus.test.ts`, `apps/daemon/src/learning/judge-usecase.test.ts`

**Interfaces:**
- Produces: `SOLVED_MIN = 2`, `FAILURE_MIN = 2`; `buildJudgeCorpus` failure bucket = up to `DIAGNOSED_CAP = 3` diagnosed cases + held-out ground-truth failures topping up to `K_PER_BUCKET = 5` (diagnosed back-fill only if no held-out exist). `JudgeCorpus` shape unchanged.

- [ ] **Step 1: Write the failing tests.** In `corpus.test.ts`, following the file's existing sqlite fixture setup (it seeds `workflow_templates`/`workflow_runs`/`workflow_step_runs`/`workflow_artifacts`/`harness_transitions`), add:

```ts
  it("failure bucket tops up with held-out ground-truth failures beyond the diagnosed cases", () => {
    // Seed 2 diagnosed failing runs (referenced by the proposal's sampleTransitionIds)
    // AND 2 additional refuted runs NOT referenced by the proposal.
    // (Use the file's existing insert helpers; refuted runs carry
    //  refute_json = JSON.stringify({ verdict: "refuted", triggered_by: [], risk_class: "high", reason: "r", issue_refs: [] });)
    const corpus = buildJudgeCorpus(db, proposal);
    const ids = corpus.failure.map((c) => c.stepRunId);
    expect(ids).toEqual(expect.arrayContaining([diagnosedRun1, diagnosedRun2, heldOutRun1, heldOutRun2]));
    expect(corpus.failure.length).toBe(4);
  });

  it("caps diagnosed cases at 3 so held-out failures always get slots when they exist", () => {
    // Seed 5 diagnosed failing runs + 2 held-out refuted runs.
    const corpus = buildJudgeCorpus(db, proposal5);
    const ids = corpus.failure.map((c) => c.stepRunId);
    expect(ids.filter((id) => heldOutIds.includes(id)).length).toBe(2);
    expect(corpus.failure.length).toBe(5);
  });
```

(The exact seeding calls must reuse the helpers already in `corpus.test.ts` — copy the insert pattern of its existing "failure bucket" test verbatim and vary ids/refute_json.)

In `judge-usecase.test.ts`: the existing test that judges with 1 solved + 1 failure case now expects `insufficient_evidence`; add/extend a case with 2+2 that reaches the shadow. Update its assertions accordingly.

- [ ] **Step 2: Run to verify failures**

Run: `pnpm -C apps/daemon test -- src/learning/corpus.test.ts src/learning/judge-usecase.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** `usecases.ts`:

```ts
// Paper §3.5.2: evaluate on held-out traces; 1-vs-1 corpora overfit the diagnosis.
export const SOLVED_MIN = 2;
export const FAILURE_MIN = 2;
```

`corpus.ts` — rename `buildFailure` → `buildDiagnosedFailures` (body unchanged), add after it:

```ts
export const DIAGNOSED_CAP = 3;

// Held-out failures: ground-truth-failed step runs for this step that were NOT part
// of the diagnosis sample. Judging improvement only on the diagnosed cases overfits —
// the edit was authored against exactly those cases (paper §3.5.2: evaluate on
// held-out traces). Same ground-truth rules as buildSolved, inverted.
function buildHeldOutFailures(db: Database.Database, templateId: string, stepTemplateId: string, exclude: Set<string>): JudgeCase[] {
  const rows = db.prepare(
    `SELECT wa.step_run_id AS step_run_id, wa.body AS body,
            ht.evidence_json AS evidence_json, ht.refute_json AS refute_json
     FROM workflow_artifacts wa
     JOIN workflow_step_runs wsr ON wsr.id = wa.step_run_id
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     JOIN harness_transitions ht ON ht.workflow_step_run_id = wa.step_run_id AND ht.boundary = 'step_complete'
     WHERE wr.template_id = ? AND wsr.step_template_id = ? AND wa.type = 'step_output'
     ORDER BY wa.created_at DESC, wa.rowid DESC`
  ).all(templateId, stepTemplateId) as { step_run_id: string; body: string; evidence_json: string | null; refute_json: string | null }[];
  const seen = new Set<string>();
  const out: JudgeCase[] = [];
  for (const r of rows) {
    if (seen.has(r.step_run_id)) continue;
    seen.add(r.step_run_id);
    if (exclude.has(r.step_run_id)) continue;
    let failed: boolean;
    if (r.refute_json != null) {
      const parsed = safeJsonParse(r.refute_json);
      const refute = parsed === undefined ? null : RefuteFacet.safeParse(parsed);
      failed = !!refute && refute.success && refute.data.verdict === "refuted";
    } else {
      const parsed = r.evidence_json ? safeJsonParse(r.evidence_json) : undefined;
      const evidence = parsed === undefined ? null : EvidenceFacet.safeParse(parsed);
      failed = !!evidence && evidence.success && (evidence.data.verdict === "failed" || evidence.data.verdict === "partial");
    }
    if (!failed) continue;
    out.push({ stepRunId: r.step_run_id, output: compact(r.body) });
    if (out.length >= K_PER_BUCKET) break;
  }
  return out;
}
```

Replace `buildJudgeCorpus`:

```ts
export function buildJudgeCorpus(db: Database.Database, proposal: TemplateInstructionProposal): JudgeCorpus {
  const diagnosed = buildDiagnosedFailures(db, proposal);
  const diagnosedIds = new Set(diagnosed.map((c) => c.stepRunId));
  const heldOut = buildHeldOutFailures(db, proposal.templateId, proposal.stepTemplateId, diagnosedIds);
  // Diagnosed cases define the targeted failure mode (cap them); held-out cases keep
  // the judge honest. Back-fill with extra diagnosed cases only when no held-out exist.
  const failure = [...diagnosed.slice(0, DIAGNOSED_CAP), ...heldOut].slice(0, K_PER_BUCKET);
  for (const c of diagnosed.slice(DIAGNOSED_CAP)) {
    if (failure.length >= K_PER_BUCKET) break;
    if (!failure.some((f) => f.stepRunId === c.stepRunId)) failure.push(c);
  }
  const failureIds = new Set(failure.map((c) => c.stepRunId));
  const solved = buildSolved(db, proposal.templateId, proposal.stepTemplateId, failureIds);
  return { solved, failure };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm -C apps/daemon test -- src/learning`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/learning/corpus.ts apps/daemon/src/learning/usecases.ts apps/daemon/src/learning/corpus.test.ts apps/daemon/src/learning/judge-usecase.test.ts
git commit -m "feat(learning): judge hold-out discipline — 2+2 minimums, held-out failures in the corpus

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Repo-wide verification + live check

**Files:** none new.

- [ ] **Step 1: Full typecheck + test sweep**

Run: `pnpm -C packages/contracts test && pnpm -C apps/daemon exec tsc --noEmit && pnpm -C apps/daemon test && pnpm -C apps/desktop exec tsc --noEmit && pnpm -C apps/desktop test`
Expected: all PASS. Fix any straggler fixture (routes tests, `MetricsPage.test.tsx`) that still builds pre-Task-3 `StepMetrics` literals.

- [ ] **Step 2: Replayability spot-check** — confirm the SP1 purity test (recompute-twice-equality in the aggregate tests) still passes and no new nondeterminism was introduced (no `Date.now()`/`Math.random()` in any diff: `git diff main --stat` + `git diff main | grep -E "Date.now|Math.random"` → no hits).

- [ ] **Step 3: Live verification against the running daemon** (the daemon is live; browse via `pnpm dev:browser` + Playwright MCP, or hit the API through the proxy):
  - `GET /v1/metrics/templates/<adaptive-delivery-id>?period=30d` — every step's `score` is either `null` (rendered "needs a check") or an integer; `quality.scoredSampleSize` present; the two known `evaluation_failed` runs still don't score; no step shows `oracleSufficientRate: 0` merely because it has no evidence.
  - In the browser Metrics tab: the health tile renders (or shows the empty state), no `NaN`/blank cells, step details show plain-language failure labels only.
  - Screenshot the metrics tab for the record.

- [ ] **Step 4: Final commit (if verification produced fixes)** and report: summarize score movements observed on live data (expected: some steps drop from a number to "needs a check"; nothing flatlines at 100 that isn't `verified_executed`).

---

## Self-Review Notes

- **Spec coverage:** fix 1 → Task 3 (hard failures); fix 2 → Tasks 3+4 (nullable score end-to-end); fix 3 → Task 1 (catalog); fix 4 → Tasks 3+4 (surface refute reason) and 5 (mine reasons); fix 5 → Task 5 (INFRA_CODES + R1 gate); fix 6 → Tasks 2+3+4 (tier §6 fix, cluster dedupe, health weights, oracle-rate null); item B → Tasks 3 (versionScoreDelta) + 6 (canary); item C → Task 7.
- **Deliberately out of scope** (approved sequencing): widening proposal revision targets beyond instructions (item A), cost-vs-verification telemetry (D), revise-loop mining (E), storage-layer truncation loosening (F).
- **Type consistency:** `scoredSampleSize` lives under `quality`; `recentRefuteReasons` under `verification`; `versionScoreDelta` top-level on `StepMetrics`; `targetDelta`/`targetImproved` optional enrichment on `TemplateInstructionProposal`; `EvidenceSnapshot.metricSnapshot.score`/`.oracleSufficientRate` nullable (Task 3 Step 5) — Task 5's `DiagnosisBundle` and Task 6's canary use exactly these names.
