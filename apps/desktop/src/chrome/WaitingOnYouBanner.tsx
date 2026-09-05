import type { RunSummary } from "@orca/contracts";
import { formatDuration } from "../metrics/interval-bar";

// The founder's runs sat parked for 18 and 39 hours. Both times the laptop was
// closed and sleeping — which suspends the daemon too, so there was no process
// running to notice and no local channel could have fired. The only thing a
// desktop app can do about a closed lid is be impossible to miss when it opens.
//
// So this is deliberately NOT a notification. It is persistent state: true for as
// long as something is waiting, gone the moment nothing is, and visible from every
// screen rather than four clicks into Metrics. Two consequences follow:
//
//   No dismiss control. A banner you can dismiss is dismissed at hour one and
//   absent at hour thirty-nine, which is the failure it exists to prevent.
//
//   Not a modal, not an interrupt. He is opening his laptop to do something, and a
//   blocking dialog about a 39-hour-old park would be Orca deciding his attention
//   belongs to Orca. Persistent and visible, not demanding.

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

export function WaitingOnYouBanner({
  runs,
  onOpenGoal,
}: {
  runs: RunSummary[];
  onOpenGoal: (goalId: string) => void;
}) {
  const waiting = waitingRuns(runs);
  if (waiting.length === 0) return null;

  const lead = waiting[0]!;
  const since = formatDuration(lead.awaitingYou.sinceMs);
  const wants = lead.awaitingYou.sourceKind ? WANTS[lead.awaitingYou.sourceKind] : undefined;
  const others = waiting.length - 1;

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-4)",
        background: "var(--warn-soft)",
        borderBottom: "1px solid var(--warn)",
        fontSize: "var(--fs-3)",
        color: "var(--text)",
        flexShrink: 0,
      }}
    >
      <span>
        <strong style={{ fontWeight: 600 }}>
          {lead.goalTitle} has been waiting on you{since ? ` for ${since}` : ""}
        </strong>
        {wants ? ` — ${wants}.` : "."}
      </span>
      <button
        type="button"
        onClick={() => onOpenGoal(lead.goalId)}
        style={{
          background: "none",
          border: "none",
          color: "var(--accent)",
          cursor: "pointer",
          padding: 0,
          fontSize: "var(--fs-2)",
          fontFamily: "inherit",
        }}
      >
        Open it
      </button>
      {others > 0 && (
        <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)" }}>
          and {others} other run{others === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}
