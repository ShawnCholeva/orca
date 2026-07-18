import type { VerificationTier, EvidenceArtifact } from "@orca/contracts";
import type { TemplateTransition } from "./fetch.js";
import { sourcesPassed, SOURCE_CONFIDENCE, type CalibrationSource } from "./source-signals.js";

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

const CALIBRATABLE: CalibrationSource[] = ["executable", "grounding"];
const ALL_SOURCES: CalibrationSource[] = ["executable", "grounding", "independent_review", "self_report"];

// Per source: how often does an independently-concluded claim from a completion that
// PASSED this source actually survive an independent refute, versus the designed
// prior (SOURCE_CONFIDENCE) assumed for that source? independent_review is the refute
// signal itself (circular to calibrate against itself) and self_report has no
// independent check at all — both are always unmeasurable. Pure; consumed for display
// and, once measured over enough claims, by effectiveSourceConfidence scoring.
export function computeCalibration(transitions: TemplateTransition[]): CalibrationEntry[] {
  const finals = finalCompletions(transitions);
  return ALL_SOURCES.map((source): CalibrationEntry => {
    const assumed = SOURCE_CONFIDENCE[source];
    if (!CALIBRATABLE.includes(source)) {
      // review is the independent signal itself (circular); self-report has no independent check.
      return { source, assumed, measured: null, sampleSize: 0, state: "unmeasurable" };
    }
    const passedKey = source === "executable" ? "executable" : "grounding";
    const bucket = finals.filter((t) => sourcesPassed(t.transition.evidence, t.transition.refute)[passedKey]);
    const withRefute = bucket.filter((t) => t.transition.refute?.verdict === "upheld" || t.transition.refute?.verdict === "refuted");
    const upheld = withRefute.filter((t) => t.transition.refute?.verdict === "upheld").length;
    const claims = withRefute.length;
    let state: CalibrationEntry["state"];
    if (bucket.length > 0 && withRefute.length / bucket.length < CALIBRATION_COVERAGE) state = "unmeasurable";
    else if (claims < CALIBRATION_MIN) state = "insufficient";
    else state = "measured";
    return { source, assumed, sampleSize: claims, measured: state === "measured" ? upheld / claims : null, state };
  });
}

// Confidence for a source: designed prior until an independent measurement is strong
// enough (measured, ≥ CALIBRATION_SCORE_MIN claims), then the measured survival rate.
// executable is capped at its 1.0 prior — measurement can only LOWER it (a passing check
// that later got refuted was weak; nothing exceeds certainty). review/self never move.
export function effectiveSourceConfidence(source: CalibrationSource, calibration?: CalibrationEntry[]): number {
  const prior = SOURCE_CONFIDENCE[source];
  if (!CALIBRATABLE.includes(source)) return prior;
  const cal = calibration?.find((c) => c.source === source);
  if (!cal || cal.state !== "measured" || cal.measured == null || cal.sampleSize < CALIBRATION_SCORE_MIN) return prior;
  return source === "executable" ? Math.min(cal.measured, prior) : cal.measured;
}
