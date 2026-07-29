export const REVISE_CAP = 3;

/**
 * Frames a user-authored revision for delivery to the step worker. The engine's
 * own revisions (grounding failures, refute) already carry framing; the user's
 * text arrives raw, and a bare user turn reads as a fresh instruction rather than
 * a revision bounded by the step's contract — which is how a Research worker came
 * to write and run a file after a "resolve the blocking constraint" revision.
 */
export function formatRevisionForWorker(args: {
  stepName: string;
  feedback: string;
  readOnly: boolean;
}): string {
  const contract = args.readOnly
    ? ` Stay pre-implementation: make no code changes — this step is read-only.`
    : "";
  return (
    `The user revised your ${args.stepName} completion. You are still in the ${args.stepName} step; ` +
    `its instructions and output contract still apply.${contract} Address this, then re-emit the step completion.\n\n` +
    args.feedback
  );
}

export function incrementReviseAttempt(currentAttempts: number): { nextAttempt: number; capReached: boolean } {
  const nextAttempt = currentAttempts + 1;
  return { nextAttempt, capReached: nextAttempt >= REVISE_CAP };
}
