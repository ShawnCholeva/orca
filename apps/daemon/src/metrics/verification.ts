import type { VerificationTier, EvidenceArtifact } from "@orca/contracts";
import type { TemplateTransition } from "./fetch.js";

export const TIER_CONFIDENCE: Record<VerificationTier, number> = {
  verified_executed: 1.0, partially_verified: 0.7, ai_reviewed: 0.55, self_reported: 0.3, unverified: 0,
};

// Calibration: how well the assumed confidences above (designed priors) match what
// independent review actually finds. Pure. Below CALIBRATION_SCORE_MIN claims the
// rate is display-only; at or above it, effectiveTierConfidence feeds the measured
// rate into scoring in place of the prior.
export const CALIBRATION_MIN = 5; // min independently-concluded claims per tier before we'll report a rate
export const CALIBRATION_COVERAGE = 0.5; // evidence tiers: refutes-run / passes floor before we trust the rate
export const CALIBRATION_DIVERGENCE = 0.2;
export const CALIBRATION_SCORE_MIN = 10; // min measured claims before calibration adjusts scoring

export type CalibrationEntry = {
  tier: VerificationTier;
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

// Same vFail semantics as aggregate.ts's finalStepCompletes scoring (replicated here,
// not imported, to avoid a cycle: aggregate imports this module).
function vFail(t: TemplateTransition): boolean {
  const tr = t.transition;
  return tr.evidence?.verdict === "failed" || tr.evidence?.verdict === "partial" ||
    (tr.evidence == null && tr.refute?.verdict === "refuted");
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

const CALIBRATION_TIERS: VerificationTier[] = ["verified_executed", "partially_verified", "ai_reviewed", "self_reported"];
const EVIDENCE_TIERS = new Set<VerificationTier>(["verified_executed", "partially_verified"]);

// Scoring weight for a tier: the designed prior until independent measurement is
// strong enough (measured state, ≥ CALIBRATION_SCORE_MIN claims), then the measured
// survival rate. Non-evidence tiers are capped at the partially_verified prior —
// consistent independent review can raise trust toward partly-verified, but never
// to run-and-tested, because nothing was executed. A low measured rate lowers the
// weight below the prior symmetrically.
export function effectiveTierConfidence(tier: VerificationTier, calibration?: CalibrationEntry[]): number {
  const prior = TIER_CONFIDENCE[tier];
  const cal = calibration?.find((c) => c.tier === tier);
  if (!cal || cal.state !== "measured" || cal.measured == null || cal.sampleSize < CALIBRATION_SCORE_MIN) return prior;
  return EVIDENCE_TIERS.has(tier) ? cal.measured : Math.min(cal.measured, TIER_CONFIDENCE.partially_verified);
}

// Per tier: how often does an independently-concluded claim actually survive, versus
// the designed prior (TIER_CONFIDENCE) assumed for that tier? "Claims" excludes
// completions with no independent conclusion at all (an evidence-failed completion
// with no refute run is weak evidence, not a concluded overturn). Pure; consumed for
// display and, once measured over enough claims, by effectiveTierConfidence scoring.
export function computeCalibration(transitions: TemplateTransition[]): CalibrationEntry[] {
  const finals = finalCompletions(transitions);
  const byTier = new Map<VerificationTier, TemplateTransition[]>();
  for (const t of finals) {
    const tier = classifyTier(t);
    if (!CALIBRATION_TIERS.includes(tier)) continue; // "unverified" carries no claim to calibrate
    (byTier.get(tier) ?? byTier.set(tier, []).get(tier)!).push(t);
  }
  return CALIBRATION_TIERS.map((tier) => {
    const completions = byTier.get(tier) ?? [];
    const passes = completions.filter((t) => !vFail(t));
    const overturned = completions.filter((t) => t.transition.refute?.verdict === "refuted");
    const claims = passes.length + overturned.length;
    const measuredRaw = claims === 0 ? null : passes.length / claims;

    let state: CalibrationEntry["state"];
    if (tier === "self_reported") {
      state = "unmeasurable"; // no independent signal exists for this tier at all
    } else if (
      EVIDENCE_TIERS.has(tier) && passes.length > 0 &&
      passes.filter((t) => t.transition.refute != null).length / passes.length < CALIBRATION_COVERAGE
    ) {
      state = "unmeasurable"; // too few of the passes had an independent refute run alongside
    } else if (claims < CALIBRATION_MIN) {
      state = "insufficient";
    } else {
      state = "measured";
    }

    return {
      tier, assumed: TIER_CONFIDENCE[tier], sampleSize: claims, state,
      measured: state === "measured" ? measuredRaw : null,
    };
  });
}
