/**
 * How far to move the trust prompt's highlight (`❯`) to land on the affirmative
 * row, or null when the menu has not painted yet.
 *
 * The affirmative row is NOT reliably first. Current Claude Code renders
 *
 *     ❯ No, exit
 *       Yes, I trust this folder
 *
 * defaulting the highlight to the safe choice for a human — so confirming the
 * default QUITS the agent. Never guess the row: returning null keeps the caller
 * polling, because a wrong guess kills the session.
 *
 * Shared by BOTH interactive spawn paths — the shadow orchestrator session and
 * the per-step worker. It lives here rather than in either caller so the two can
 * never drift: a fix applied to one copy and not the other silently resurrects
 * the quit-the-agent bug on whichever path was missed.
 */
export function trustPromptMoves(pane: string): number | null {
  const options = pane
    .split("\n")
    .filter((line) => /^\s*(❯\s*)?(\d+[.)]\s*)?(yes|no)\b/i.test(line));
  const selected = options.findIndex((line) => /^\s*❯/.test(line));
  const affirmative = options.findIndex(
    (line) => /\byes\b/i.test(line) && /\btrust\b/i.test(line)
  );
  if (selected < 0 || affirmative < 0) return null;
  return affirmative - selected;
}
