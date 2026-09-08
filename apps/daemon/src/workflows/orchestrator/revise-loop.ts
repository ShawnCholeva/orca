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

/** Chat-surface budget for escalated revision feedback. Roughly a short paragraph. */
const ESCALATION_MAX_CHARS = 420;

/**
 * Trims revision feedback down to something a person can read in the chat.
 *
 * Feedback is written FOR THE AGENT, and it is right that it is: the evidence
 * veto packs up to 600 characters of raw runner output per failing sensor
 * (service.ts, `failingSensors`) because that is what an agent needs to fix the
 * defect. At the revise cap that same text was posted verbatim to the human — a
 * screen of vitest output, cut off mid-token, under a one-line heading. The
 * codebase's rule is that developer-facing strings stay out of the UI, and a
 * truncated log tail is the most developer-facing string there is.
 *
 * The cut is a plain character budget rather than a format-aware summariser on
 * purpose. Feedback has two shapes — engine-built bullets and the judge's own
 * prose — and any rule that recognises one damages the other. A budget treats
 * both the same: short prose passes through untouched, and a log dump keeps its
 * lead (which names the failing check) and loses the payload. The agent still
 * received all of it; only the chat surface is bounded.
 */
export function summarizeEscalationFeedback(feedback: string): string {
  const collapsed = feedback.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (collapsed.length <= ESCALATION_MAX_CHARS) return collapsed;
  const head = collapsed.slice(0, ESCALATION_MAX_CHARS);
  // Prefer a clean break so the excerpt never ends mid-word.
  const brk = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
  const cut = (brk > ESCALATION_MAX_CHARS * 0.6 ? head.slice(0, brk) : head).trimEnd();
  return `${cut}…\n\n(Shortened. The agent was given the full detail.)`;
}
