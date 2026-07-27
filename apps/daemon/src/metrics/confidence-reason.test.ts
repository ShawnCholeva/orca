import { describe, it, expect } from "vitest";
import { deriveConfidenceReason } from "./confidence-reason.js";

const mix = (o: Partial<{ executable: number; grounding: number; independentReview: number; selfReportOnly: number }>) =>
  ({ executable: 0, grounding: 0, independentReview: 0, selfReportOnly: 0, ...o });

describe("deriveConfidenceReason", () => {
  it("returns null when hard failure clusters already tell the story", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 3 }), verifiedSampleSize: 3, hasFailureClusters: true })).toBeNull();
  });

  it("no_check_yet when nothing was independently verified", () => {
    expect(deriveConfidenceReason({ bandLevel: "needs_evidence", verifierMix: mix({ selfReportOnly: 5 }), verifiedSampleSize: 0, hasFailureClusters: false }))
      .toEqual({ code: "no_check_yet" });
  });

  it("downstream_bounced dominates when a completion was sent back", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 4 }), verifiedSampleSize: 4, vindication: { vindicated: 1, bounced: 2, pending: 0 }, hasFailureClusters: false, verifyingGateName: "Critique" }))
      .toEqual({ code: "downstream_bounced" });
  });

  it("weak_verifier names the gate when only a review verified it", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 5 }), verifiedSampleSize: 5, vindication: { vindicated: 0, bounced: 0, pending: 3 }, hasFailureClusters: false, verifyingGateName: "Critique" }))
      .toEqual({ code: "weak_verifier", nodeName: "Critique" });
  });

  it("review_only when review-verified but no named gate", () => {
    expect(deriveConfidenceReason({ bandLevel: "weak", verifierMix: mix({ independentReview: 5 }), verifiedSampleSize: 5, hasFailureClusters: false }))
      .toEqual({ code: "review_only" });
  });

  it("vindication_pending when a real check ran but downstream hasn't accepted it", () => {
    expect(deriveConfidenceReason({ bandLevel: "strong", verifierMix: mix({ executable: 6 }), verifiedSampleSize: 6, vindication: { vindicated: 0, bounced: 0, pending: 4 }, hasFailureClusters: false }))
      .toEqual({ code: "vindication_pending" });
  });

  it("null when strong, verified, and clean — nothing limiting", () => {
    expect(deriveConfidenceReason({ bandLevel: "strong", verifierMix: mix({ executable: 6 }), verifiedSampleSize: 6, vindication: { vindicated: 5, bounced: 0, pending: 0 }, hasFailureClusters: false }))
      .toBeNull();
  });
});
