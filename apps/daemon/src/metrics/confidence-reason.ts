import type { ConfidenceReason } from "@orca/contracts";

// Deterministic, evidence-only derivation of WHY a step's confidence is below full.
// Consumes the same signals the score already computed (band, verifier mix, downstream
// vindication) — display-only, never moves the score. Returns null when nothing limits
// confidence (strong & clean) or when hard failures already populate failureClusters.
export function deriveConfidenceReason(input: {
  bandLevel: "strong" | "weak" | "needs_evidence";
  verifierMix: { executable: number; grounding: number; independentReview: number; selfReportOnly: number };
  verifiedSampleSize: number;
  vindication?: { vindicated: number; bounced: number; pending: number };
  hasFailureClusters: boolean;
  verifyingGateName?: string;
}): ConfidenceReason | null {
  const { bandLevel, verifierMix, verifiedSampleSize, vindication, hasFailureClusters, verifyingGateName } = input;

  // Hard failures already speak in the failureClusters list — don't double up.
  if (hasFailureClusters) return null;

  // Never independently checked → the coverage gap, in plain words.
  if (verifiedSampleSize === 0 || bandLevel === "needs_evidence") return { code: "no_check_yet" };

  // A completion that got sent back downstream is the strongest limiter.
  if (vindication && vindication.bounced > 0) return { code: "downstream_bounced" };

  const pendingUnaccepted = !!vindication && vindication.pending > 0 && vindication.vindicated === 0;

  if (bandLevel === "strong") {
    // Strong verification; only an unaccepted downstream can still limit it.
    if (pendingUnaccepted) return { code: "vindication_pending" };
    return null; // strong, verified, accepted → nothing limiting
  }

  // Weak band: verified, but not by a hard anchor.
  const onlyReview = verifierMix.independentReview > 0 && verifierMix.executable === 0 && verifierMix.grounding === 0;
  if (onlyReview && verifyingGateName) return { code: "weak_verifier", nodeName: verifyingGateName };
  if (pendingUnaccepted) return { code: "vindication_pending" };
  return { code: "review_only" };
}
