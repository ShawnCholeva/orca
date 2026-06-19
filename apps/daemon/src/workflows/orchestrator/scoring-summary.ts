import type { StepResultScoringProposal } from "@orca/contracts";

import { deriveTurnSummary } from "../../activities/turn-summary.js";

/** A concise statement of what the agent actually proposes, taken from its
 *  response (fenced blocks stripped, preamble skipped). Empty when the agent
 *  produced only a structured block with no prose. */
export function extractProposal(responseText: string): string {
  const prose = responseText.replace(/```[\s\S]*?```/g, "").trim();
  return prose ? deriveTurnSummary(prose) : "";
}

/** The confirmation-card summary. Leads with the agent's actual proposal so the
 *  user can decide whether to continue, then the evaluation scores. Falls back
 *  to the orchestrator's scoring reason when no proposal text is available. */
export function summarizeScoring(
  scoring: StepResultScoringProposal | undefined,
  proposal?: string
): string {
  const lead = proposal?.trim()
    ? proposal.trim()
    : scoring?.reason
      ? `Proposed result: ${scoring.reason}`
      : "Step complete.";
  if (!scoring) {
    return proposal?.trim() ? `${lead}\nEvaluation unavailable.` : "Step complete. Evaluation unavailable.";
  }
  const q = scoring.quality;
  return (
    `${lead}\n` +
    `Completeness ${Math.round(q.outputCompleteness * 100)}% · ` +
    `Correctness ${Math.round(q.outputCorrectness * 100)}% · ` +
    (scoring.handoffReady ? "Ready for handoff" : "Not ready")
  );
}
