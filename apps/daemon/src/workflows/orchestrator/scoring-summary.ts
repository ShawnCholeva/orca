import type { StepResultScoringProposal } from "@orca/contracts";

export function summarizeScoring(scoring: StepResultScoringProposal | undefined): string {
  if (!scoring) {
    return "Step complete. Evaluation unavailable.";
  }
  const q = scoring.quality;
  return (
    `Proposed result: ${scoring.reason}\n` +
    `Completeness ${Math.round(q.outputCompleteness * 100)}% · ` +
    `Correctness ${Math.round(q.outputCorrectness * 100)}% · ` +
    (scoring.handoffReady ? "Ready for handoff" : "Not ready")
  );
}
