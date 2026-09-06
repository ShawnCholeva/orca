import type { RunSummary } from "@orca/contracts";
import { formatDuration } from "../metrics/interval-bar";

// The founder's runs sat parked for 18 and 39 hours. Both times the laptop was
// closed and sleeping — which suspends the daemon too, so there was no process
// running to notice and no local channel could have fired. The only thing a
// desktop app can do about a closed lid is be impossible to miss when it opens.
//
// So "waiting on you" is deliberately NOT a notification. It is persistent state:
// true for as long as something is waiting, gone the moment nothing is, and shown
// on the goals rail, which is on every screen. Nothing to dismiss — a badge you can
// dismiss is dismissed at hour one and absent at hour thirty-nine, which is the
// failure it exists to prevent.

/**
 * What the run actually wants, in the reader's language. "Orca is waiting on you"
 * is a sentence someone learns to ignore; "Orca needs your OK on a step" is one
 * they act on.
 *
 * `unknown` is deliberately absent rather than mapped to a vague stand-in. The
 * pause reason is read from the immutable event, and when it genuinely isn't there
 * we say how long it has been waiting and stop — inventing a plausible reason is
 * how a label outlives its evidence, and this one would send him to the wrong card.
 */
const WANTS: Partial<Record<string, string>> = {
  question_pending: "a question from the agent",
  step_confirmation_pending: "a step waiting for your OK",
  gate_decision_pending: "a review waiting for your decision",
  mark_done_pending: "the final sign-off",
  permission_pending: "a permission request",
  provider_recovery_pending: "a provider limit it needs you to resolve",
};

/** Runs with something the reader can act on right now, longest wait first. */
export function waitingRuns(runs: RunSummary[]): RunSummary[] {
  // `awaitingYou` is always present: count 0 is an observation ("we checked, nothing
  // is waiting"), not an absence, so there is no null branch to defend against.
  return runs
    .filter((r) => r.awaitingYou.count > 0)
    .sort((a, b) => (b.awaitingYou.sinceMs ?? 0) - (a.awaitingYou.sinceMs ?? 0));
}

/** The longest-waiting run per goal, so a goal card can say what its run wants. */
export function waitingByGoal(runs: RunSummary[]): Map<string, RunSummary["awaitingYou"]> {
  const byGoal = new Map<string, RunSummary["awaitingYou"]>();
  for (const r of waitingRuns(runs)) {
    if (!byGoal.has(r.goalId)) byGoal.set(r.goalId, r.awaitingYou);
  }
  return byGoal;
}

/** "Waiting on you for 39h 0m · a step waiting for your OK" — the wait, then what for. */
export function waitingLabel(w: RunSummary["awaitingYou"]): string {
  const since = formatDuration(w.sinceMs);
  const wants = w.sourceKind ? WANTS[w.sourceKind] : undefined;
  return `Waiting on you${since ? ` for ${since}` : ""}${wants ? ` · ${wants}` : ""}`;
}
