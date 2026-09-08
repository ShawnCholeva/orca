import type { Activity, ActivityDiff, ActivityStep } from "@orca/contracts";

// How the tail of the thread renders once the worker is no longer streaming
// into it. Two very different things used to share one "interrupted" flag:
//   live    — the worker is mid-turn; the last step pulses.
//   settled — the turn ENDED normally and something else now holds the floor
//             (the orchestrator reviewing its output). The work finished, so
//             the last step earns a check. It must NOT show a pause: nothing
//             was halted, and the daemon marks that same step done moments
//             later, so a pause is a lie that visibly flips to a check.
//   halted  — the run actually stopped mid-flight (blocked, or a user
//             interrupt). Only this earns the pause glyph.
type ActivityTail = "live" | "settled" | "halted";

export function AgentActivity({
  activity,
  tail = "live",
  showHead = true,
  showTail = true,
}: {
  activity: Activity;
  tail?: ActivityTail;
  /** False on every segment but the first — the step name heads the turn once. */
  showHead?: boolean;
  /** False on every segment but the last — only it owns the pulse and the summary. */
  showTail?: boolean;
}) {
  const completed = activity.status === "completed";
  // An activity that reached a terminal status while still carrying an active
  // step was cut short (e.g. the user pressed Escape) — that is a halt.
  const cutShort =
    tail === "halted" || activity.status === "completed" || activity.status === "expired";
  // Anything but a live tail means nothing is streaming here any more.
  const stopped = cutShort || tail === "settled";
  // The active line is the last step still marked active; if there is none yet
  // (step opened, no tool call run), fall back to a single pulse.
  const activeStep = [...activity.steps].reverse().find((s) => s.status === "active") ?? null;
  const doneSteps = activity.steps.filter((s) => s.status === "done");
  // The turn is live but between tool calls: no step is active, and the last one
  // already earned its check. Nothing rendered here at all, because this pulse
  // used to require `steps.length === 0` — so it only ever covered the opening
  // gap of a turn. Every gap AFTER the first read as a finished, abandoned
  // thread, and OrcaChat's fallback "Working on X…" row could not fill it either:
  // that row is suppressed precisely BECAUSE this activity is active. Two guards,
  // each assuming the other had it covered, and a dead window between them.
  const showTrailingPulse = showTail && !stopped && activeStep === null;
  // The summary's top border is a divider from the steps thread above it. With
  // no steps rendered (a tool-less turn), that divider would float with nothing
  // above it — so drop it and sit the summary flush.
  const hasStepsAbove = doneSteps.length > 0 || activeStep !== null || showTrailingPulse;
  const showSummary = showTail && completed && activity.finalSummary;
  const headText = showHead ? activity.stepName : null;
  // A middle segment that ended on its diff has no rows, no pulse and no summary.
  // Rendering its bordered shell would put an empty box in the timeline.
  if (!headText && !hasStepsAbove && !showSummary) return null;

  return (
    <div className="agent-activity" data-testid="agent-activity" data-status={activity.status}>
      {headText ? <div className="agent-activity-head">{headText}</div> : null}
      <div className="agent-activity-steps">
        {doneSteps.map((step) => (
          <StepRow key={step.id} step={step} state="done" />
        ))}
        {activeStep ? (
          <StepRow
            key={activeStep.id}
            step={activeStep}
            state={cutShort ? "interrupted" : tail === "settled" ? "done" : "running"}
          />
        ) : null}
        {showTrailingPulse ? (
          <div className="agent-activity-step" data-testid="agent-activity-active">
            <Pulse />
            <span className="agent-activity-step-text">
              {/* Under rows of its own the step name is already overhead; repeating
                  it as the live line reads as a second, different thing starting. */}
              {activity.steps.length > 0 ? "Working…" : activity.stepName ?? "Working…"}
            </span>
          </div>
        ) : null}
      </div>
      {showSummary ? (
        <div className={`agent-activity-summary${hasStepsAbove ? "" : " agent-activity-summary--flush"}`}>
          {activity.finalSummary}
        </div>
      ) : null}
    </div>
  );
}

type StepRowState = "done" | "running" | "interrupted";

// A step's text is chosen when its tool STARTS, so it reads as work in progress.
// Once the step is done — and above all once the whole turn has ended — a
// present-progressive line under a check ("✓ Working on the step...") describes
// something that is not happening. Only the daemon's generic narrations need
// this; a tool's own narration ("Ran npm test", "Read package.json") is past
// tense already.
const DONE_TEXT: Record<string, string> = {
  "Reading through the codebase...": "Read through the codebase",
  "Searching the codebase...": "Searched the codebase",
  "Making changes...": "Made changes",
  "Running a command...": "Ran a command",
  "Running the test suite...": "Ran the test suite",
  "Working on the step...": "Worked on the step",
};

function StepRow({ step, state }: { step: ActivityStep; state: StepRowState }) {
  const testid =
    state === "done"
      ? "agent-activity-done"
      : state === "interrupted"
        ? "agent-activity-interrupted"
        : "agent-activity-active";
  return (
    <div className="agent-activity-step" data-testid={testid}>
      {state === "done" ? <Check /> : state === "interrupted" ? <PauseGlyph /> : <Pulse />}
      <span className={`agent-activity-step-text${state === "done" ? " is-done" : ""}`}>
        {state === "done" ? DONE_TEXT[step.text] ?? step.text : step.text}
      </span>
    </div>
  );
}

// A code change rendered as its own pre-expanded chat message (outside the
// activity thread) so diffs break up the timeline instead of hiding behind a
// toggle inside an agent activity card.
export function CodeChangeCard({ diff, caption }: { diff: ActivityDiff; caption?: string }) {
  return (
    <div className="code-change-card" data-testid="code-change-card">
      <div className="code-change-head">
        <span className="code-change-file">{diff.filePath}</span>
        <span className="agent-activity-diff-stat">
          <span className="diff-add">+{diff.additions}</span>{" "}
          <span className="diff-del">−{diff.deletions}</span>
        </span>
      </div>
      {caption ? <div className="code-change-caption">{caption}</div> : null}
      <pre className="agent-activity-diff-body">
        {diff.hunks.flatMap((hunk, hi) =>
          hunk.lines.map((line, li) => (
            <div key={`${hi}-${li}`} className={`diff-line diff-line--${line.kind}`}>
              <span className="diff-gutter">
                {line.kind === "remove" ? "-" : line.kind === "add" ? "+" : ""}
              </span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))
        )}
      </pre>
    </div>
  );
}

function Check() {
  return (
    <svg className="agent-activity-check" width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg className="agent-activity-paused" width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="9" y1="5" x2="9" y2="19" />
      <line x1="15" y1="5" x2="15" y2="19" />
    </svg>
  );
}

function Pulse() {
  return (
    <span className="thinking-dots agent-activity-pulse" aria-hidden>
      <span style={{ animationDelay: "0s" }} />
      <span style={{ animationDelay: "0.18s" }} />
      <span style={{ animationDelay: "0.36s" }} />
    </span>
  );
}
