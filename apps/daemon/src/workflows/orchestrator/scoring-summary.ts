import type { StepResultScoringProposal } from "@orca/contracts";

export function summarizeScoring(scoring: StepResultScoringProposal | undefined): string {
  if (!scoring) {
    return "Step complete — evaluation unavailable. Continue or send revisions.";
  }
  const q = scoring.quality;
  return (
    `Completeness ${Math.round(q.outputCompleteness * 100)}% · ` +
    `Correctness ${Math.round(q.outputCorrectness * 100)}% · ` +
    (scoring.handoffReady ? "Ready for handoff" : "Not ready") +
    " — Continue or send revisions."
  );
}
