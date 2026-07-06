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
