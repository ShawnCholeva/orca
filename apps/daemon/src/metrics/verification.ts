import type { VerificationTier, EvidenceArtifact, WorkflowGraph } from "@orca/contracts";
import type { TemplateTransition } from "./fetch.js";
import { sourcesPassed, SOURCE_CONFIDENCE, type CalibrationSource } from "./source-signals.js";
import { vindicatorWeight } from "./vindicator-weight.js";
import type { VindicationResult } from "./vindication.js";

export const TIER_CONFIDENCE: Record<VerificationTier, number> = {
  verified_executed: 1.0, partially_verified: 0.7, ai_reviewed: 0.55, self_reported: 0.3, unverified: 0,
};

// Calibration: how well the assumed confidences above (designed priors) match what
// independent review actually finds. Pure. Below CALIBRATION_SCORE_MIN claims the
// rate is display-only; at or above it, effectiveSourceConfidence feeds the measured
// rate into scoring in place of the prior.
export const CALIBRATION_MIN = 5; // min independently-concluded claims per source before we'll report a rate
export const CALIBRATION_COVERAGE = 0.5; // refutes-run / passes floor before we trust the rate
export const CALIBRATION_DIVERGENCE = 0.2;
export const CALIBRATION_SCORE_MIN = 10; // min measured claims before calibration adjusts scoring
export const PRIOR_STRENGTH = 4; // K: pseudo-count weight of the designed prior in the Beta posterior

export type CalibrationEntry = {
  source: CalibrationSource;
  assumed: number;
  measured: number | null;
  sampleSize: number;
  state: "measured" | "insufficient" | "unmeasurable";
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
    // No execution — but a passed enforce-mode grounding check means part of
    // the output was mechanically verified: partly verified, never run-and-
    // tested (that branch requires sensors above).
    const groundingRan = (ev.grounding?.checks ?? []).some(
      (c) => c.mode === "enforce" && c.result !== "skipped"
    );
    if (groundingRan && ev.grounding!.verdict === "passed") return "partially_verified";
    // Evidence present but nothing executed → treat as a review-grade signal.
    return "ai_reviewed";
  }
  const rf = tr.refute;
  if (rf?.verdict === "upheld" || rf?.verdict === "refuted") return "ai_reviewed";
  // A refute RAN but was inconclusive (uncertain/unavailable): the self-report is
  // the only signal left — record it at self_reported confidence rather than
  // dropping the completion from the score entirely (spec §6). A bare transition
  // with no refute attempted has no pass/fail signal at all → unverified.
  if (rf != null) return "self_reported";
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
  hasGrounding: boolean; groundingFailed: boolean;
}): EvidenceArtifact[] {
  const out: EvidenceArtifact[] = [];
  // Grounding-only evidence replaces the old "nothing was executed" placeholder
  // with its own artifact below; evidence with neither keeps the placeholder.
  if (input.hasEvidence && (input.anySensors || !input.hasGrounding)) {
    out.push({
      source: "executable",
      verifies: input.anySensors ? "the checks that ran passed" : "nothing was executed",
      cannotVerify: input.oracleGaps.length ? input.oracleGaps.join("; ") : "untested regions",
      confidence: input.oracleSufficientRate,
      verdict: input.anySensors ? (input.oracleSufficientRate >= 1 ? "pass" : "partial") : "inconclusive",
    });
  }
  if (input.hasGrounding) {
    out.push({
      source: "grounding",
      verifies: "checkable claims in the output (paths, references, internal consistency) were mechanically verified",
      cannotVerify: "semantic correctness — nothing was executed",
      confidence: TIER_CONFIDENCE.partially_verified,
      verdict: input.groundingFailed ? "fail" : "pass",
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

// Final completion per distinct (run, step): boundary step_complete, latest by createdAt.
function finalCompletions(ts: TemplateTransition[]): TemplateTransition[] {
  const byKey = new Map<string, TemplateTransition>();
  for (const t of ts) {
    if (t.transition.boundary !== "step_complete") continue;
    const key = `${t.transition.workflowRunId ?? t.transition.id}::${t.stepTemplateId ?? ""}`;
    const prev = byKey.get(key);
    if (!prev || t.transition.createdAt > prev.transition.createdAt) byKey.set(key, t);
  }
  return [...byKey.values()];
}

// Score-applied set: sources whose confidence effectiveSourceConfidence will move off the
// designed prior once independently measured. independent_review joins here in Task 3 —
// vindication-calibrated only (never refute-calibrated, see computeCalibration below); never
// self_report (no independent check exists for it at all).
const CALIBRATABLE: CalibrationSource[] = ["executable", "grounding", "independent_review"];
// computeCalibration's own calibratable set (currently the same three sources) — kept as a
// separate constant from CALIBRATABLE since "do we compute a posterior for this source?" and
// "does the posterior move the score?" are conceptually independent questions.
const VINDICATION_CALIBRATABLE: CalibrationSource[] = ["executable", "grounding", "independent_review"];
const ALL_SOURCES: CalibrationSource[] = ["executable", "grounding", "independent_review", "self_report"];

// Per source: an empirical-Bayes Beta(alpha, beta) posterior over "does a claim from a
// completion that PASSED this source hold up?", seeded by the designed prior (SOURCE_CONFIDENCE)
// as low-weight pseudo-counts (K = PRIOR_STRENGTH) and updated by two kinds of labels:
//   - refute verdicts (weight 1.0 — a direct adversarial verdict on THIS completion).
//     executable/grounding only: independent_review IS the refute signal, so refute can
//     never label it (that would be circular).
//   - downstream vindication (weight = vindicatorWeight(...) in (0,1] — an indirect proxy,
//     attenuated by how strong the vindicating node is; `pending` contributes nothing).
// sampleSize is the SUM of label weights (the weighted effective observed count, excluding
// the prior pseudo-counts) — this is what gates state and, downstream, CALIBRATION_SCORE_MIN:
// a source vindicated only by weak vindicators needs proportionally more labels to reach the
// same effective evidence as one anchored by strong verifiers. self_report has no independent
// check at all and is always unmeasurable. Pure; consumed for display and, once measured over
// enough claims, by effectiveSourceConfidence scoring.
export function computeCalibration(
  transitions: TemplateTransition[],
  opts?: {
    vindication?: Map<string, VindicationResult>;
    graph?: WorkflowGraph;
    gateApprovedByCompletion?: (t: TemplateTransition) => boolean;
  },
): CalibrationEntry[] {
  const finals = finalCompletions(transitions);
  return ALL_SOURCES.map((source): CalibrationEntry => {
    const assumed = SOURCE_CONFIDENCE[source];
    if (!VINDICATION_CALIBRATABLE.includes(source)) {
      // self-report has no independent check at all.
      return { source, assumed, measured: null, sampleSize: 0, state: "unmeasurable" };
    }
    const bucket = finals.filter((t) => {
      const sp = sourcesPassed(t.transition.evidence, t.transition.refute);
      if (source === "executable") return sp.executable;
      if (source === "grounding") return sp.grounding;
      return sp.independentReview || opts?.gateApprovedByCompletion?.(t) === true;
    });

    let alpha = 0;
    let beta = 0;
    let labeled = 0;
    for (const t of bucket) {
      let hasLabel = false;
      // Refute labels never apply to independent_review — it IS the refute signal (circular).
      if (source !== "independent_review") {
        const verdict = t.transition.refute?.verdict;
        if (verdict === "upheld") { alpha += 1; hasLabel = true; }
        else if (verdict === "refuted") { beta += 1; hasLabel = true; }
      }
      const key = `${t.transition.workflowRunId}::${t.stepTemplateId}`;
      const v = opts?.vindication?.get(key);
      const graph = opts?.graph;
      if (v && v.outcome !== "pending") {
        const w = graph ? vindicatorWeight(v.byNodeId, graph) : 1.0;
        if (v.outcome === "vindicated") alpha += w; else beta += w;
        hasLabel = true;
      }
      if (hasLabel) labeled++;
    }

    const sampleSize = alpha + beta;
    // independent_review is vindication-only: an older-version (or otherwise unresolved)
    // completion has no vindication map entry at all and can never be labeled, so it must
    // not dilute the coverage denominator (it isn't "labelable evidence we're missing" —
    // it's simply out of scope). Fall back to the full bucket when no vindication map was
    // supplied at all (backward-compat / no-vindication callers keep prior behavior).
    // executable/grounding stay refute-based over the full bucket, unchanged.
    const coverageBucket = source === "independent_review" && opts?.vindication
      ? bucket.filter((t) => opts.vindication!.get(`${t.transition.workflowRunId}::${t.stepTemplateId}`) !== undefined)
      : bucket;
    let state: CalibrationEntry["state"];
    if (coverageBucket.length > 0 && labeled / coverageBucket.length < CALIBRATION_COVERAGE) state = "unmeasurable";
    else if (sampleSize < CALIBRATION_MIN) state = "insufficient";
    else state = "measured";

    const alpha0 = assumed * PRIOR_STRENGTH;
    const beta0 = (1 - assumed) * PRIOR_STRENGTH;
    const measured = state === "measured" ? (alpha0 + alpha) / (alpha0 + beta0 + alpha + beta) : null;
    return { source, assumed, sampleSize, measured, state };
  });
}

// Confidence for a source: designed prior until an independent measurement is strong
// enough (measured, ≥ CALIBRATION_SCORE_MIN claims), then the measured survival rate.
// executable is capped at its 1.0 prior — measurement can only LOWER it (a passing check
// that later got refuted was weak; nothing exceeds certainty). grounding/independent_review
// move freely (up or down); self_report never moves (no independent check exists for it).
export function effectiveSourceConfidence(source: CalibrationSource, calibration?: CalibrationEntry[]): number {
  const prior = SOURCE_CONFIDENCE[source];
  if (!CALIBRATABLE.includes(source)) return prior;
  const cal = calibration?.find((c) => c.source === source);
  if (!cal || cal.state !== "measured" || cal.measured == null || cal.sampleSize < CALIBRATION_SCORE_MIN) return prior;
  return source === "executable" ? Math.min(cal.measured, prior) : cal.measured;
}
