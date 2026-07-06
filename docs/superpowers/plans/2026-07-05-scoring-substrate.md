# Honest Scoring Substrate (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the verdict-pass step score (everything reads 100/100) with a verification-strength evidence bundle, a readable failure-mode taxonomy, and one joined "claim vs verified" confidence story across the Metrics tab and the Activity-thread step card.

**Architecture:** A new pure module (`apps/daemon/src/metrics/verification.ts`) classifies each step completion into a verification tier from evidence already on the `HarnessTransition`, builds a scope-declaring evidence bundle, and computes a confidence-weighted score + false-acceptance rate. `aggregate.ts` consumes it. The contract (`@orca/contracts` metrics) gains `verification`, `failureModes`, and `reconciliation`. Three UI surfaces render the new fields in plain language and drop all jargon.

**Tech Stack:** TypeScript, Zod (contracts), better-sqlite3 (read-only here), React (desktop), Vitest + @testing-library/react.

## Global Constraints

- **No new LLM calls in the read path** — the insight is templated/deterministic (deterministic-core cost spine).
- **Control-plane pure** — no execution-plane access; derive only from already-captured `evidence`/`refute`/`telemetry`/step-run data. No producer/prompt changes.
- **Replayable** — the score MUST be a pure, deterministic function of captured evidence (no wall-clock/random inputs); recomputing over the same transitions yields an identical score.
- **Zero jargon in user-facing copy** — no "oracle", "sensor", "verdict", "refute" in any rendered string.
- **Absolute scale** — a step whose best tier is `ai_reviewed` caps at that tier's confidence; not re-baselined to 100.
- **Additive contracts** — extend `StepMetrics`; keep `failureClusters`, `quality.*` fields for internal/diagnosis consumers.
- **Per-template / per-owner only** — no cross-goal logic.
- Tier confidence coefficients live in ONE exported constant table (tunable).

**Verification tiers (canonical, used verbatim in every task):**

| Tier id | User label | Confidence |
|---|---|---|
| `verified_executed` | Run & tested | 1.0 |
| `partially_verified` | Partly verified | 0.7 |
| `ai_reviewed` | Reviewed, not proven | 0.55 |
| `self_reported` | Self-reported only | 0.3 |
| `unverified` | No check yet | 0 |

---

### Task 1: Extend the metrics contract

**Files:**
- Modify: `packages/contracts/src/metrics/index.ts:61-98` (the `StepMetrics` object)
- Test: `packages/contracts/src/metrics/metrics.contract.test.ts` (create)

**Interfaces:**
- Produces: `VerificationTier` (string union), and `StepMetrics.verification`, `StepMetrics.failureModes`, `StepMetrics.reconciliation`. Every later task depends on these names/types.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/metrics/metrics.contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { StepMetrics } from "./index.js";

const base = {
  stepTemplateId: "s", name: "X", ordinal: 0, score: 58, sampleSize: 3, confidence: "ok" as const,
  runs: 3, passedFirstTry: 3, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, sensorPassRate: null, oracleSufficientRate: 0, verifiedSampleSize: 3,
    untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [], trend: [], versionBoundaries: [], insights: [], recentReasons: [],
  verification: {
    tier: "ai_reviewed" as const, tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0,
    artifacts: [{ source: "self_report" as const, verifies: "a claim only", cannotVerify: "everything", confidence: 0.3, verdict: "pass" as const }],
  },
  failureModes: [{ label: "Reported success without an independent check", count: 3, pct: 1 }],
  reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false },
};

describe("StepMetrics contract", () => {
  it("accepts the new verification bundle, failureModes, reconciliation", () => {
    expect(() => StepMetrics.parse(base)).not.toThrow();
  });
  it("allows nullable sensorPassRate (no sensors ran)", () => {
    expect(StepMetrics.parse(base).quality.sensorPassRate).toBeNull();
  });
  it("allows null reconciliation", () => {
    expect(() => StepMetrics.parse({ ...base, reconciliation: null })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts exec vitest run src/metrics/metrics.contract.test.ts`
Expected: FAIL — `verification`/`failureModes` are unknown keys (`.strict()`), and `sensorPassRate: null` is rejected (currently `z.number()`).

- [ ] **Step 3: Add the contract fields**

In `packages/contracts/src/metrics/index.ts`, immediately above `export const StepMetrics`, add:

```ts
export const VerificationTier = z.enum([
  "verified_executed", "partially_verified", "ai_reviewed", "self_reported", "unverified",
]);
export type VerificationTier = z.infer<typeof VerificationTier>;

export const EvidenceArtifact = z.object({
  source: z.enum(["executable", "independent_review", "self_report"]),
  verifies: z.string(),
  cannotVerify: z.string(),
  confidence: z.number(),
  verdict: z.enum(["pass", "fail", "partial", "inconclusive"]),
}).strict();
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;

export const FailureMode = z.object({
  label: z.string(), count: z.number().int().nonnegative(), pct: z.number(),
}).strict();
export type FailureMode = z.infer<typeof FailureMode>;
```

Then inside the `StepMetrics` object: change the quality line
`verdictPassRate: z.number(), sensorPassRate: z.number(), oracleSufficientRate: z.number(),`
to
`verdictPassRate: z.number(), sensorPassRate: z.number().nullable(), oracleSufficientRate: z.number(),`

and add these three keys (e.g. right after `failureClusters: z.array(FailureCluster),`):

```ts
  verification: z.object({
    tier: VerificationTier, tierLabel: z.string(), confidence: z.number(),
    falseAcceptanceRate: z.number(), artifacts: z.array(EvidenceArtifact),
  }).strict(),
  failureModes: z.array(FailureMode),
  reconciliation: z.object({
    claimedComplete: z.boolean(), verifiedTierLabel: z.string(), refuted: z.boolean(),
  }).strict().nullable(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts exec vitest run src/metrics/metrics.contract.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/metrics/index.ts packages/contracts/src/metrics/metrics.contract.test.ts
git commit -m "feat(contracts): add verification bundle, failureModes, reconciliation to StepMetrics"
```

---

### Task 2: Verification classification + evidence bundle (new pure module)

**Files:**
- Create: `apps/daemon/src/metrics/verification.ts`
- Test: `apps/daemon/src/metrics/verification.test.ts`

**Interfaces:**
- Consumes: `TemplateTransition` from `./fetch.js`; `VerificationTier`, `EvidenceArtifact` from `@orca/contracts`.
- Produces:
  - `TIER_CONFIDENCE: Record<VerificationTier, number>`
  - `TIER_LABEL: Record<VerificationTier, string>`
  - `classifyTier(t: TemplateTransition): VerificationTier`
  - `strongestTier(tiers: VerificationTier[]): VerificationTier`
  - `buildArtifacts(input: { hasEvidence: boolean; anySensors: boolean; oracleSufficientRate: number; oracleGaps: string[]; hasRefute: boolean; falseAccept: number }): EvidenceArtifact[]`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/metrics/verification.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TemplateTransition } from "./fetch.js";
import { classifyTier, strongestTier, TIER_CONFIDENCE, buildArtifacts } from "./verification.js";

function tx(over: Partial<TemplateTransition["transition"]>): TemplateTransition {
  return {
    templateVersion: 1, stepTemplateId: "s",
    transition: {
      id: "t", goalId: "g", workflowRunId: "r", workflowStepRunId: "r-s",
      boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
      telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
        outcome: { status: "succeeded", failure_code: null } },
      createdAt: "2026-05-01T00:00:00.000Z", ...over,
    },
  };
}

describe("classifyTier", () => {
  it("verified_executed: sensors ran and oracle sufficient", () => {
    expect(classifyTier(tx({ evidence: { sensorsRun: [{ kind: "test", command: "t", exitCode: 0, durationMs: 1, result: "passed", summary: null, artifactRef: null }], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } } }))).toBe("verified_executed");
  });
  it("partially_verified: sensors ran but oracle not sufficient", () => {
    expect(classifyTier(tx({ evidence: { sensorsRun: [{ kind: "test", command: "t", exitCode: 1, durationMs: 1, result: "failed", summary: null, artifactRef: null }], verdict: "partial", untestedRegions: ["x"], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: ["no integ test"] } } }))).toBe("partially_verified");
  });
  it("ai_reviewed: no evidence, refute upheld", () => {
    expect(classifyTier(tx({ evidence: null, refute: { verdict: "upheld", triggered_by: [], risk_class: "low", reason: null, issue_refs: [] } }))).toBe("ai_reviewed");
  });
  it("unverified: no evidence and refute inconclusive (a bare self-claim)", () => {
    // No executable evidence and no conclusive independent review → nothing to score.
    // (self_reported stays in the enum for the self-report ARTIFACT + future producer
    // enrichment, but classifyTier does not emit it in SP1 — a bare claim has no pass/
    // fail signal without joining the self-report numbers, which SP1 defers.)
    expect(classifyTier(tx({ evidence: null, refute: { verdict: "uncertain", triggered_by: [], risk_class: "low", reason: null, issue_refs: [] } }))).toBe("unverified");
  });
  it("unverified: evaluation_failed", () => {
    expect(classifyTier(tx({ evidence: null, telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "evaluation_failed" } } }))).toBe("unverified");
  });
});

describe("strongestTier", () => {
  it("picks the strongest present", () => {
    expect(strongestTier(["self_reported", "ai_reviewed", "unverified"])).toBe("ai_reviewed");
  });
  it("unverified when list empty", () => {
    expect(strongestTier([])).toBe("unverified");
  });
});

describe("buildArtifacts", () => {
  it("always includes a low-confidence self_report artifact", () => {
    const a = buildArtifacts({ hasEvidence: false, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: false, falseAccept: 0 });
    expect(a.some((x) => x.source === "self_report")).toBe(true);
  });
  it("marks the independent_review verdict fail when a pass was overturned", () => {
    const a = buildArtifacts({ hasEvidence: false, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: true, falseAccept: 2 });
    expect(a.find((x) => x.source === "independent_review")?.verdict).toBe("fail");
  });
});

describe("TIER_CONFIDENCE", () => {
  it("is monotonic and absolute (ai_reviewed caps below executed)", () => {
    expect(TIER_CONFIDENCE.verified_executed).toBeGreaterThan(TIER_CONFIDENCE.ai_reviewed);
    expect(TIER_CONFIDENCE.ai_reviewed).toBeGreaterThan(TIER_CONFIDENCE.self_reported);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/verification.test.ts`
Expected: FAIL — `./verification.js` does not exist.

- [ ] **Step 3: Write the module**

Create `apps/daemon/src/metrics/verification.ts`:

```ts
import type { VerificationTier, EvidenceArtifact } from "@orca/contracts";
import type { TemplateTransition } from "./fetch.js";

export const TIER_CONFIDENCE: Record<VerificationTier, number> = {
  verified_executed: 1.0, partially_verified: 0.7, ai_reviewed: 0.55, self_reported: 0.3, unverified: 0,
};
export const TIER_LABEL: Record<VerificationTier, string> = {
  verified_executed: "Run & tested", partially_verified: "Partly verified",
  ai_reviewed: "Reviewed, not proven", self_reported: "Self-reported only", unverified: "No check yet",
};

const TIER_RANK: VerificationTier[] = [
  "unverified", "self_reported", "ai_reviewed", "partially_verified", "verified_executed",
];

// Classify one step completion from data already on the transition. Pure.
export function classifyTier(t: TemplateTransition): VerificationTier {
  const tr = t.transition;
  if (tr.telemetry?.outcome.failure_code === "evaluation_failed") return "unverified";
  const ev = tr.evidence;
  if (ev) {
    const anySensors = ev.sensorsRun.length > 0;
    if (anySensors && ev.oracleAdequacy.sufficient) return "verified_executed";
    if (anySensors) return "partially_verified";
    // Evidence present but nothing executed → treat as a review-grade signal.
    return "ai_reviewed";
  }
  const rf = tr.refute;
  if (rf?.verdict === "upheld" || rf?.verdict === "refuted") return "ai_reviewed";
  // No evidence and no conclusive independent review → nothing to score. (self_reported
  // remains a valid tier for the self-report ARTIFACT, but is not emitted from a bare
  // transition in SP1: a claim alone has no pass/fail signal without the self-report join.)
  return "unverified";
}

export function strongestTier(tiers: VerificationTier[]): VerificationTier {
  let best: VerificationTier = "unverified";
  for (const t of tiers) if (TIER_RANK.indexOf(t) > TIER_RANK.indexOf(best)) best = t;
  return best;
}

export function buildArtifacts(input: {
  hasEvidence: boolean; anySensors: boolean; oracleSufficientRate: number;
  oracleGaps: string[]; hasRefute: boolean; falseAccept: number;
}): EvidenceArtifact[] {
  const out: EvidenceArtifact[] = [];
  if (input.hasEvidence) {
    out.push({
      source: "executable",
      verifies: input.anySensors ? "the checks that ran passed" : "nothing was executed",
      cannotVerify: input.oracleGaps.length ? input.oracleGaps.join("; ") : "untested regions",
      confidence: input.oracleSufficientRate,
      verdict: input.anySensors ? (input.oracleSufficientRate >= 1 ? "pass" : "partial") : "inconclusive",
    });
  }
  if (input.hasRefute) {
    out.push({
      source: "independent_review",
      verifies: "a second model reviewed the result",
      cannotVerify: "anything that was not executed",
      confidence: TIER_CONFIDENCE.ai_reviewed,
      verdict: input.falseAccept > 0 ? "fail" : "pass",
    });
  }
  out.push({
    source: "self_report",
    verifies: "nothing independently — the model's own claim",
    cannotVerify: "everything",
    confidence: TIER_CONFIDENCE.self_reported,
    verdict: "pass",
  });
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/verification.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/verification.ts apps/daemon/src/metrics/verification.test.ts
git commit -m "feat(metrics): verification tier classification + evidence bundle"
```

---

### Task 3: Verification-weighted score + false-acceptance rate + sensor-default fix

**Files:**
- Modify: `apps/daemon/src/metrics/aggregate.ts:230-255` (the quality channel) and `:330-344` (the `StepMetrics` assembly)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts` (add cases)

**Interfaces:**
- Consumes: `classifyTier`, `strongestTier`, `TIER_CONFIDENCE`, `TIER_LABEL`, `buildArtifacts` from `./verification.js`.
- Produces: honest `step.score`, `step.verification`, and `quality.sensorPassRate: number | null`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/daemon/src/metrics/aggregate.steps.test.ts` (reuse the file's `sc` helper). Append inside `describe("computeStepMetrics", ...)`:

```ts
  it("scores a passing AI-reviewed step in the mid-range, not 100", () => {
    // No evidence, refute upheld → ai_reviewed (conf 0.55).
    const ts: TemplateTransition[] = ["r1", "r2", "r3"].map((r, i) => ({
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: `a${i}`, goalId: "g", workflowRunId: r, workflowStepRunId: `${r}-s`,
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: `2026-05-01T0${i}:00:00.000Z`,
      },
    }));
    const runs: TemplateStepRun[] = ts.map((t) => ({ workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(55); // round(0.55 * 100)
    expect(step.verification.tier).toBe("ai_reviewed");
    expect(step.verification.tierLabel).toBe("Reviewed, not proven");
  });

  it("does not report sensorPassRate=1 when no sensors ran", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")]; // sc builds evidence with sensorsRun: []
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.sensorPassRate).toBeNull();
  });

  it("false-acceptance: a refuted self-reported pass lowers the score and is counted", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: { id: "x", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s", boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "refuted", triggered_by: [], risk_class: "high", reason: "broke a rule", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z" },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.verification.falseAcceptanceRate).toBe(1);
    expect(step.score).toBe(0); // refuted → isFail → contributes 0
  });

  it("is replayable: same evidence yields the same score twice", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const args = { transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" as const };
    expect(computeStepMetrics(args)[0].score).toBe(computeStepMetrics(args)[0].score);
  });
```

Also update the existing `"rolls up a step's three channels"` test: change `expect(step.quality.sensorPassRate)` expectations if present (it isn't asserted there — no change needed), and the `sc` helper produces `sensorsRun: []`, so those completions are now `ai_reviewed`/`partially_verified` depending on evidence — the existing assertion `verdictPassRate` toBeCloseTo(1/3) stays valid (verdictPassRate is unchanged logic). Leave other assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/aggregate.steps.test.ts`
Expected: FAIL — `step.verification` is undefined; `sensorPassRate` is `1` not `null`; new score expectations unmet.

- [ ] **Step 3: Implement in `aggregate.ts`**

At the top of `aggregate.ts`, add the import:

```ts
import { classifyTier, strongestTier, TIER_CONFIDENCE, TIER_LABEL, buildArtifacts } from "./verification.js";
```

In `computeStepMetrics`, after `finalStepCompletes` is built (line ~228) and after `vPass`/`vFail` are defined (line ~240), replace the block that computes `verificationValue`/`verdictPassRate`/`verification`/`sensorPassRate`/`oracleSufficientRate` (lines ~245-255) with:

```ts
    const isUnverifiedEval = (t: (typeof stepCompletes)[number]) =>
      t.transition.telemetry?.outcome.failure_code === "evaluation_failed";
    const verifiedCompletes = finalStepCompletes.filter((t) => !isUnverifiedEval(t) && (vPass(t) || vFail(t)));
    const verificationValue = verifiedCompletes.length === 0 ? null :
      verifiedCompletes.filter(vPass).length / verifiedCompletes.length;
    const verdictPassRate = verificationValue ?? 0;

    // Verification-weighted score (SP1): each conclusive completion contributes its
    // tier confidence when it passed, 0 when it failed. Pure function of evidence.
    const tierByCompletion = new Map(finalStepCompletes.map((t) => [t, classifyTier(t)] as const));
    const conclusive = finalStepCompletes.filter((t) => tierByCompletion.get(t) !== "unverified");
    const scoreValue = conclusive.length === 0 ? null :
      conclusive.reduce((acc, t) => acc + (vPass(t) ? TIER_CONFIDENCE[tierByCompletion.get(t)!] : 0), 0) / conclusive.length;
    const stepTier = strongestTier(conclusive.map((t) => tierByCompletion.get(t)!));
    const falseAccept = conclusive.filter((t) => t.transition.refute?.verdict === "refuted").length;
    const falseAcceptanceRate = conclusive.length === 0 ? 0 : falseAccept / conclusive.length;

    const allSensors = evidenceCompletes.flatMap((t) => t.transition.evidence!.sensorsRun);
    // No sensors ran → null (unknown), NEVER 1. Absence of a check is not a perfect check.
    const sensorPassRate = allSensors.length === 0 ? null :
      allSensors.filter((s) => s.result === "passed").length / allSensors.length;
    const oracleSufficientRate = evidenceCompletes.length === 0 ? 0 :
      evidenceCompletes.filter((t) => t.transition.evidence!.oracleAdequacy.sufficient).length / evidenceCompletes.length;
```

The replacement block above intentionally drops the old `const verification = verificationValue ?? 0;` local (its only consumer was the score line). The trend channel uses `dimsFromTransitions(...).verification_strength` and is unaffected. Change the `score:` line (was `Math.round(verification * 100)` at ~332) to:

```ts
      score: scoreValue == null ? 0 : Math.round(scoreValue * 100),
```

In the `quality: { ... }` object (line ~334), keep `verdictPassRate` and change `sensorPassRate` to the new nullable value (already assigned above). `verifiedSampleSize: verifiedCompletes.length` stays (drives the `unverified` UI state) — note `conclusive.length` equals `verifiedCompletes.length` for non-eval-failed completions.

Add the `verification` block to the `StepMetrics` object (e.g. after `failureClusters,`):

```ts
      verification: {
        tier: stepTier, tierLabel: TIER_LABEL[stepTier], confidence: scoreValue ?? 0, falseAcceptanceRate,
        artifacts: buildArtifacts({
          hasEvidence: evidenceCompletes.length > 0, anySensors: allSensors.length > 0,
          oracleSufficientRate, oracleGaps: uniqueCapped(evidenceCompletes.flatMap((t) => t.transition.evidence!.oracleAdequacy.gaps)),
          hasRefute: finalStepCompletes.some((t) => t.transition.refute != null), falseAccept,
        }),
      },
```

Where the old code referenced `verification` for the trend (`dimsFromTransitions`), leave it — the trend channel is unchanged. `failureModes` and `reconciliation` are added in Task 4; add temporary placeholders now so the object parses: `failureModes: [],` and `reconciliation: null,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/aggregate.steps.test.ts`
Expected: PASS. Also run the sibling suite to catch fallout: `pnpm --filter @orca/daemon exec vitest run src/metrics/aggregate.test.ts` — fix any snapshot/shape expectations that now include the added fields.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.steps.test.ts
git commit -m "feat(metrics): verification-weighted score, false-acceptance rate, sensor-default fix"
```

---

### Task 4: Readable failure-mode taxonomy + templated insight + reconciliation

**Files:**
- Create: `apps/daemon/src/metrics/failure-labels.ts`
- Modify: `apps/daemon/src/metrics/aggregate.ts` (`deriveInsights` → templated; assemble `failureModes` + `reconciliation`)
- Test: `apps/daemon/src/metrics/aggregate.steps.test.ts` (update the `deriveInsights` describe block + add a failureModes case)

**Interfaces:**
- Consumes: `TIER_LABEL` from `./verification.js`.
- Produces: `labelForFailure(code: string | null): string`; populated `step.failureModes`, `step.reconciliation`, and a templated `step.insights`.

- [ ] **Step 1: Write the failing tests**

Create `apps/daemon/src/metrics/failure-labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { labelForFailure } from "./failure-labels.js";

describe("labelForFailure", () => {
  it("maps a known code to a plain sentence (no jargon)", () => {
    const s = labelForFailure("evaluation_failed");
    expect(s).toMatch(/checkable result|without producing/i);
    expect(s).not.toMatch(/oracle|sensor|verdict/i);
  });
  it("falls back readably for an unknown code", () => {
    expect(labelForFailure("some_new_code")).toMatch(/some new code|unclassified/i);
  });
});
```

In `aggregate.steps.test.ts`, replace the `describe("deriveInsights", ...)` block's expectations that assert `/oracle/i` (the current false-confidence test at ~90-101 asserts an insight matching `/oracle/i` — now forbidden). Change that test to:

```ts
  it("flags a passing-but-weakly-verified step in plain language (no jargon)", () => {
    const insights = deriveInsights({ /* ...same base object as the existing test... */ } as any);
    expect(insights.join(" ")).not.toMatch(/oracle|sensor|verdict/i);
  });
```

**Important:** the new `deriveInsights` reads `step.verification.*` and `step.failureModes`, so **every** `deriveInsights` test fixture in this block must gain those two fields or it throws. Add to each fixture object: `verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0, artifacts: [] }, failureModes: [],` (adjust `tier`/`falseAcceptanceRate` per what each test intends to assert). Keep the retry/churn and cost tests; ensure their asserted phrases don't rely on jargon. Add a failureModes case inside `describe("computeStepMetrics", ...)`:

```ts
  it("surfaces a refuted pass as a readable failure mode", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: { id: "x", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s", boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "refuted", triggered_by: [], risk_class: "high", reason: "broke a rule", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z" },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.failureModes.some((f) => /overturned|independent check/i.test(f.label))).toBe(true);
    expect(step.reconciliation?.refuted).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/failure-labels.test.ts src/metrics/aggregate.steps.test.ts`
Expected: FAIL — `failure-labels.js` missing; `failureModes` empty; insight still contains "oracle".

- [ ] **Step 3: Implement the catalog**

Create `apps/daemon/src/metrics/failure-labels.ts`:

```ts
// Deterministic, human-readable labels for categorical failure codes. No jargon.
const CATALOG: Record<string, string> = {
  evaluation_failed: "Finished without producing a checkable result",
  invalid_output: "Produced output that didn't match what the step asked for",
  hard_constraint_violation: "Broke a rule the goal required",
  gate_rejected: "A reviewer sent it back",
  timeout: "Ran out of time before finishing",
  escalated: "Had to hand off to a human",
};

export function labelForFailure(code: string | null): string {
  if (code == null) return "Unclassified problem";
  return CATALOG[code] ?? code.replace(/_/g, " ");
}
```

- [ ] **Step 4: Implement failureModes + reconciliation + templated insight in `aggregate.ts`**

Add the import: `import { labelForFailure } from "./failure-labels.js";`

Replace the `deriveInsights` function (lines ~170-185) with a templated version:

```ts
export function deriveInsights(step: StepMetrics): string[] {
  const out: string[] = [];
  const far = step.verification.falseAcceptanceRate;
  if (far >= 0.2) {
    out.push(`Approves work without proof ${Math.round(far * 100)}% of the time — bad output can slip through.`);
  }
  if (step.verification.tier === "ai_reviewed" || step.verification.tier === "self_reported") {
    out.push("Consistently passes but is never independently proven — if later steps fail on this output, that's the signal to strengthen it.");
  }
  const top = step.failureModes[0];
  if (top && top.count > 0) out.push(`Most common problem: ${top.label.toLowerCase()} (${top.count}×).`);
  if ((step.cost.meanRetries ?? 0) >= 1.5) out.push("Loops between failed attempts — high retry churn.");
  return out;
}
```

Then, in `computeStepMetrics`, build `failureModes` and `reconciliation` before assembling the `StepMetrics` object. After `failureClusters` is computed (line ~292), add:

```ts
    // Readable taxonomy: categorical failures (mapped to plain labels) + verification weaknesses.
    const verifWeaknesses: { label: string; count: number }[] = [];
    if (falseAccept > 0) verifWeaknesses.push({ label: "Approved something the independent check overturned", count: falseAccept });
    const rawModes = [
      ...failureClusters.map((c) => ({ label: labelForFailure(c.failureCode), count: c.count })),
      ...verifWeaknesses,
    ].filter((m) => m.count > 0);
    const modeTotal = rawModes.reduce((n, m) => n + m.count, 0) || 1;
    const failureModes = rawModes
      .map((m) => ({ label: m.label, count: m.count, pct: m.count / modeTotal }))
      .sort((a, b) => b.count - a.count);

    const reconciliation = conclusive.length === 0 ? null : {
      claimedComplete: true, verifiedTierLabel: TIER_LABEL[stepTier], refuted: falseAccept > 0,
    };
```

Replace the temporary `failureModes: [],` and `reconciliation: null,` placeholders from Task 3 with `failureModes,` and `reconciliation,`. `step.insights = deriveInsights(step);` already runs at the end (line ~345) — leave it (it now reads the new fields, which are already on `step`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/metrics/`
Expected: PASS across the metrics suite.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/metrics/failure-labels.ts apps/daemon/src/metrics/failure-labels.test.ts apps/daemon/src/metrics/aggregate.ts apps/daemon/src/metrics/aggregate.steps.test.ts
git commit -m "feat(metrics): readable failure-mode taxonomy, templated insight, reconciliation"
```

---

### Task 5: Presentation helpers — tiers, "No check yet", re-anchored status

**Files:**
- Modify: `apps/desktop/src/metrics/metrics-data.ts`
- Test: `apps/desktop/src/metrics/metrics-data.test.ts` (create)

**Interfaces:**
- Produces: `statusMeta.unverified.label === "No check yet"`; `verificationMeta: Record<VerificationTier, { label: string; color: string }>`; `workflowHealthFromSteps(steps): number | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/metrics-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { statusMeta, statusForStep, workflowHealthFromSteps } from "./metrics-data";
import type { StepMetrics } from "@orca/contracts";

const step = (over: Partial<StepMetrics>): StepMetrics => ({
  stepTemplateId: "s", name: "X", ordinal: 0, score: 62, sampleSize: 3, confidence: "ok",
  runs: 3, passedFirstTry: 3, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, sensorPassRate: null, oracleSufficientRate: 0, verifiedSampleSize: 3, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 1, meanTokens: 1, meanUsd: 0, meanRetries: 0 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [], trend: [], versionBoundaries: [], insights: [], recentReasons: [],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.62, falseAcceptanceRate: 0, artifacts: [] },
  failureModes: [], reconciliation: null, ...over,
});

describe("metrics-data", () => {
  it("labels the unverified state 'No check yet'", () => {
    expect(statusMeta.unverified.label).toBe("No check yet");
  });
  it("statusForStep is unverified when verifiedSampleSize is 0", () => {
    expect(statusForStep(step({ quality: { ...step({}).quality, verifiedSampleSize: 0 } }))).toBe("unverified");
  });
  it("workflow health is the sample-weighted mean of conclusive step scores", () => {
    const h = workflowHealthFromSteps([
      step({ score: 90, sampleSize: 2 }),
      step({ score: 60, sampleSize: 2 }),
    ]);
    expect(h).toBe(75);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/metrics/metrics-data.test.ts`
Expected: FAIL — label is "Unverified"; `workflowHealthFromSteps` undefined.

- [ ] **Step 3: Implement**

In `apps/desktop/src/metrics/metrics-data.ts`:
- Change the `unverified` entry to actionable blue: `unverified: { tone: "warn", color: "var(--accent)", label: "No check yet" },`
- Add after `import type ...`:

```ts
import type { StepMetrics as _StepMetrics, VerificationTier } from "@orca/contracts";

export const verificationMeta: Record<VerificationTier, { label: string; color: string }> = {
  verified_executed: { label: "Run & tested", color: "var(--run)" },
  partially_verified: { label: "Partly verified", color: "var(--warn)" },
  ai_reviewed: { label: "Reviewed, not proven", color: "var(--warn)" },
  self_reported: { label: "Self-reported only", color: "var(--warn)" },
  unverified: { label: "No check yet", color: "var(--accent)" },
};

// Sample-weighted mean of conclusive step scores (unverified steps excluded).
export function workflowHealthFromSteps(steps: _StepMetrics[]): number | null {
  const scored = steps.filter((s) => s.quality.verifiedSampleSize > 0);
  const wsum = scored.reduce((n, s) => n + s.sampleSize, 0);
  if (wsum === 0) return null;
  return Math.round(scored.reduce((n, s) => n + s.score * s.sampleSize, 0) / wsum);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop exec vitest run src/metrics/metrics-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/metrics-data.ts apps/desktop/src/metrics/metrics-data.test.ts
git commit -m "feat(metrics-ui): 'No check yet' state, tier labels, workflow health from steps"
```

---

### Task 6: Step row — plain status pill, honest headline, drop the jargon line

**Files:**
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx:61-146` (`StepRow`) and `:148-165` (`StepPerformancePanel` attention filter)

**Interfaces:**
- Consumes: `verificationMeta`, `statusForStep`, `statusMeta`, `gradeFor` from `./metrics-data`; `step.verification`, `step.failureModes`, `step.reconciliation`.

- [ ] **Step 1: Update the row pill + headline**

In `StepRow`, the status pill currently renders `{m.label}` (Healthy/Watch/Degraded). Change the `<Pill>` to show the tier label with the status color. Replace the `<Pill tone={m.tone} size="xs">{m.label}</Pill>` line with:

```tsx
<Pill tone={m.tone} size="xs">{status === "unverified" ? "No check yet" : step.verification.tierLabel}</Pill>
```

In the score cell (lines ~85-94), change the `unverified` branch label from "not verified" to "needs a check":

```tsx
{status === "unverified" ? (
  <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: m.color }} title="No independent check ran for this step yet — it's an opportunity to strengthen, not a failing grade.">needs a check</span>
) : (
  <>
    <span style={{ fontSize: 20, fontWeight: 600, color: m.color, letterSpacing: -0.5 }}>{step.score}</span>
    <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100 {gradeFor(step.score)}</span>
  </>
)}
```

- [ ] **Step 2: Delete the jargon "Verification scope" line**

In the expanded block (lines ~110-113), DELETE the `<SectionLabel>Verification scope</SectionLabel>` and the `<div>Verdict pass … oracle adequate …</div>` entirely. (Replaced by Task 7's evidence bundle.) Also delete the `Chips` for `oracleGaps` if it duplicates Task 7 (keep untestedRegions/residualRisk for now; Task 7 restructures).

- [ ] **Step 3: Include "No check yet" in the attention count**

In `StepPerformancePanel` (line ~151), change the attention filter to include unverified:

```tsx
const attention = steps.filter((s) => { const st = statusForStep(s); return st === "watch" || st === "degraded" || st === "unverified"; }).length;
```

- [ ] **Step 4: Verify it compiles + typechecks**

Run: `pnpm --filter @orca/desktop exec tsc --noEmit`
Expected: no type errors in `StepPerformance.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/StepPerformance.tsx
git commit -m "feat(metrics-ui): plain tier pill, honest headline, drop verification-scope jargon"
```

---

### Task 7: Expanded step detail — rung bar, four-part evidence bundle, readable failures, reconciliation

**Files:**
- Modify: `apps/desktop/src/metrics/StepPerformance.tsx` (the `open && (...)` expanded block, ~98-143)
- Test: `apps/desktop/src/metrics/StepPerformance.test.tsx` (create)

**Interfaces:**
- Consumes: `step.verification.{tier,artifacts,falseAcceptanceRate}`, `step.failureModes`, `step.reconciliation`, `step.quality.{untestedRegions,residualRisk}`, `step.insights`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/metrics/StepPerformance.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepRow } from "./StepPerformance";
import type { StepMetrics } from "@orca/contracts";

const step: StepMetrics = {
  stepTemplateId: "s", name: "Proposal", ordinal: 1, score: 62, sampleSize: 3, confidence: "ok",
  runs: 3, passedFirstTry: 3, recovered: 0, failed: 0,
  quality: { verdictPassRate: 1, sensorPassRate: null, oracleSufficientRate: 0, verifiedSampleSize: 3, untestedRegions: ["whether the plan works"], residualRisk: [], oracleGaps: [], limitingDimension: null },
  cost: { p50LatencyMs: 1, meanTokens: 1, meanUsd: 0, meanRetries: 0 },
  risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
  failureClusters: [], trend: [], versionBoundaries: [], insights: ["Consistently passes but is never independently proven."], recentReasons: [],
  verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.62, falseAcceptanceRate: 0,
    artifacts: [{ source: "independent_review", verifies: "a second model reviewed the result", cannotVerify: "anything not executed", confidence: 0.55, verdict: "pass" }] },
  failureModes: [], reconciliation: { claimedComplete: true, verifiedTierLabel: "Reviewed, not proven", refuted: false },
};

describe("StepRow expanded", () => {
  it("renders plain-language sections and no jargon", () => {
    render(<StepRow step={step} index={1} isLast open onToggle={() => {}} />);
    expect(screen.getByText(/Checks run/i)).toBeTruthy();
    expect(screen.getByText(/a second model reviewed/i)).toBeTruthy();
    expect(screen.queryByText(/oracle|sensor|verdict/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/metrics/StepPerformance.test.tsx`
Expected: FAIL — "Checks run" not present.

- [ ] **Step 3: Implement the expanded detail**

Replace the content inside the expanded card (`<div style={{ background: "var(--panel-2)", ... }}>` … `</div>`) with, in order:

1. A 5-segment rung bar (fill up to the tier's rank):

```tsx
{(() => {
  const rank = ["unverified","self_reported","ai_reviewed","partially_verified","verified_executed"].indexOf(step.verification.tier) + 1;
  return (
    <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
      {[0,1,2,3,4].map((i) => <div key={i} style={{ height: 6, flex: 1, borderRadius: 3, background: i < rank ? "var(--warn)" : "rgba(255,255,255,0.08)" }} />)}
    </div>
  );
})()}
```

2. **Failure modes** (readable) — replace the old `failureClusters` map with `step.failureModes`:

```tsx
<SectionLabel style={{ paddingTop: 0 }}>What's going wrong</SectionLabel>
{step.failureModes.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>}
{step.failureModes.map((f, i) => (
  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
    <span>{f.label}</span>
    <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{f.count}× · {Math.round(f.pct * 100)}%</span>
  </div>
))}
```

3. **Checks run** (the evidence bundle):

```tsx
<SectionLabel>Checks run</SectionLabel>
{step.verification.artifacts.map((a, i) => (
  <div key={i} style={{ fontSize: 12, color: "var(--text-2)", padding: "2px 0" }}>
    {a.verifies}{a.cannotVerify ? <span style={{ color: "var(--text-4)" }}> — couldn't check: {a.cannotVerify}</span> : null}
  </div>
))}
```

4. Keep the existing `Chips` for **Untested regions** and **Residual risk** (relabel headers to plain words if not already): `<Chips label="What we couldn't check" items={step.quality.untestedRegions} />` and `<Chips label="Remaining risks" items={step.quality.residualRisk} />`. Remove the `oracleGaps` Chips (folded into "Checks run").

5. **Reconciliation** line (below insights):

```tsx
{step.reconciliation && (
  <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)", fontSize: 12, color: step.reconciliation.refuted ? "var(--err)" : "var(--text-2)" }}>
    The AI <b>claimed</b> this step complete. Independently verified: <b>{step.reconciliation.verifiedTierLabel.toLowerCase()}</b>{step.reconciliation.refuted ? " — but the independent check overturned it." : "."}
  </div>
)}
```

Keep the existing insights map (lines ~124-133) — it now renders the templated insight.

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `pnpm --filter @orca/desktop exec vitest run src/metrics/StepPerformance.test.tsx && pnpm --filter @orca/desktop exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/metrics/StepPerformance.tsx apps/desktop/src/metrics/StepPerformance.test.tsx
git commit -m "feat(metrics-ui): rung bar, four-part evidence bundle, readable failures, reconciliation"
```

---

### Task 8: Workflow health tile reflects honest step scores

**Files:**
- Modify: `apps/desktop/src/metrics/MetricsPage.tsx:46-69` (health color + `StatTile label="Workflow health"`)

**Interfaces:**
- Consumes: `workflowHealthFromSteps` from `./metrics-data`; `detail.steps`.

- [ ] **Step 1: Wire the honest health value**

In `MetricsPage.tsx`, where "Workflow health" is computed/rendered (~46-69), replace the summary-derived health with the step-derived one. Add near the top of the component body:

```tsx
const health = workflowHealthFromSteps(detail?.steps ?? []);
```

Use `health` for the tile value and color (color: `health == null ? "var(--text-3)" : health >= 80 ? "var(--run)" : health >= 60 ? "var(--warn)" : "var(--err)"`). If `health` is null, render "—". Import `workflowHealthFromSteps` from `./metrics-data`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @orca/desktop exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/metrics/MetricsPage.tsx
git commit -m "feat(metrics-ui): workflow health tile reflects honest step scores"
```

---

### Task 9: Join the second surface — reconcile the Activity-thread step-result card

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx` (the scores `<dl>` ~204-213 and the refute chip ~75-90; `StepResultCard` ~307-310)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx` (add a case)

**Interfaces:**
- Consumes: `summary.scoring` (self-report) and `summary.refute` (already present — `ConfirmationSummary.refute`, `REFUTE_VERDICT_LABEL`).

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/orchestrator/ActivityThread.test.tsx`, add (mirror the existing scoring-panel test setup at ~182-188, 375):

```tsx
it("frames the self-report as a claim and reconciles against the independent check", () => {
  // ...render the step-result card with scoring present and refute.verdict "upheld"...
  expect(screen.getByText(/its own claim/i)).toBeTruthy();
  expect(screen.getByText(/reviewed it and agreed|independent check/i)).toBeTruthy();
});
```

(Fill the render setup by copying the existing scoring-panel test's harness in this file; pass a `summary` with `scoring` non-null and `refute: { verdict: "upheld", ... }`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/ActivityThread.test.tsx`
Expected: FAIL — "its own claim" not present.

- [ ] **Step 3: Implement the reconciled card**

In the scores panel (`<dl>` region), add a heading/tag above the grid: replace the note line with a title row **"How this step scored itself"** + a muted tag **"its own claim — not proof"**. Gloss each `<dt>` term in plain words (Complete / Correct / Followed instructions) — update the existing labels.

Change the refute rendering so it ALWAYS shows (not just `verdict !== "upheld"`): add an "Independent check" line. Extend `REFUTE_VERDICT_LABEL`:

```ts
const REFUTE_VERDICT_LABEL: Record<string, string> = {
  upheld: "A second AI reviewed it and agreed — but nothing was run or tested",
  refuted: "Independent review disputes this",
  uncertain: "Independent review was inconclusive",
  unavailable: "No independent review ran",
};
```

Render, below the claim grid:

```tsx
{refute && (
  <div data-testid="step-confirm-independent" style={{ marginTop: 8, fontSize: 12, color: refute.verdict === "refuted" ? "var(--err)" : "var(--text-2)" }}>
    <span className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)" }}>Independent check</span>
    <div>{REFUTE_VERDICT_LABEL[refute.verdict] ?? "No independent review ran"}</div>
  </div>
)}
```

Add the reconciliation callout under it:

```tsx
{scoring && (
  <div style={{ marginTop: 8, fontSize: 12, color: refute?.verdict === "refuted" ? "var(--err)" : "var(--text-3)" }}>
    The AI <b>claimed</b> this step complete. See the Metrics tab for how it trends and how strongly it's verified.
  </div>
)}
```

Apply the same to `StepResultCard` (~307-310) if it renders the grid independently.

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `pnpm --filter @orca/desktop exec vitest run src/orchestrator/ActivityThread.test.tsx && pnpm --filter @orca/desktop exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(orchestrator-ui): reconcile step-result card — claim vs independent check"
```

---

### Task 10: No-jargon guard + end-to-end verification

**Files:**
- Create: `apps/desktop/src/metrics/no-jargon.test.tsx`

- [ ] **Step 1: Write the jargon-guard test**

Create `apps/desktop/src/metrics/no-jargon.test.tsx` — render the metrics step detail with representative data and assert none of the banned words appear:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepRow } from "./StepPerformance";
// reuse the `step` fixture shape from StepPerformance.test.tsx (copy it in)

describe("no jargon in the metrics step detail", () => {
  it("renders no 'oracle', 'sensor', or 'verdict'", () => {
    const { container } = render(<StepRow step={/* the ai_reviewed fixture */ {} as any} index={0} isLast open onToggle={() => {}} />);
    expect(container.textContent).not.toMatch(/\b(oracle|sensor|verdict)\b/i);
  });
});
```

(Use the same fully-populated `StepMetrics` fixture as Task 7.)

- [ ] **Step 2: Run the full test suites**

Run: `pnpm --filter @orca/contracts exec vitest run && pnpm --filter @orca/daemon exec vitest run src/metrics/ && pnpm --filter @orca/desktop exec vitest run src/metrics/ src/orchestrator/ActivityThread.test.tsx`
Expected: all PASS.

- [ ] **Step 3: End-to-end in the running app**

Restart/confirm the daemon (tmux session `daemon-terminal`), run `pnpm dev:browser`, open the Metrics tab for **Adaptive Delivery**, and confirm against spec §8:
- No step reads a green `100/100` unless genuinely `verified_executed`; several now show "Reviewed, not proven" / "No check yet".
- Workflow health dropped from ~94.
- Expanding a step shows plain sections (What's going wrong / Checks run / What we couldn't check / Remaining risks / reconciliation) and no "oracle/sensor/verdict".
- The Orchestrator/Activity step-result card frames the grid as "its own claim" with an Independent-check line.

Take a screenshot of the Metrics tab and the step-result card as evidence.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/metrics/no-jargon.test.tsx
git commit -m "test(metrics-ui): guard against oracle/sensor/verdict jargon in step detail"
```

---

## Notes for the implementer

- **Assumptions preserved** (spec §3.6, the paper's 4th bundle element) is intentionally **not** implemented here: no confirmed `assumptions` field exists on `EvidenceFacet` today. If the field is present when you reach Task 7, add a fourth section reading `evidence.assumptions`; otherwise leave the three sections (Checks run / What we couldn't check / Remaining risks) and note it for a follow-up.
- **`fetch.ts` is unchanged.** The Metrics-tab reconciliation derives "claimed complete" from the existence of a `step_complete` (implicit claim) + the verified tier + refuted flag — no self-report join needed. (The numeric self-report grid lives only on the Activity-thread card, where it's already available.)
- If `aggregate.test.ts` (the summary suite) asserts a full `StepMetrics` shape, update those fixtures to include the three new fields; don't weaken assertions.
- Keep the tier confidence coefficients in `verification.ts` as the single source of truth — they are the calibration target for SP2/SP3.
