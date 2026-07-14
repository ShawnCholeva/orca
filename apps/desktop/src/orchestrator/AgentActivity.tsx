import type { Activity, ActivityDiff, ActivityStep } from "@orca/contracts";

export function AgentActivity({
  activity,
  interrupted = false,
}: {
  activity: Activity;
  // Forces the active line to render paused instead of pulsing. Set when the run
  // is no longer making progress (e.g. blocked) so the UI never shows a live
  // spinner over work that has actually stopped (honest, inspectable status).
  interrupted?: boolean;
}) {
  const completed = activity.status === "completed";
  // A finished activity (completed/expired/interrupted) that still carries an
  // active step was cut short — render that step as paused, not running.
  const finished = interrupted || activity.status === "completed" || activity.status === "expired";
  // The active line is the last step still marked active; if there is none yet
  // (step opened, no tool call run), fall back to a single pulse.
  const activeStep = [...activity.steps].reverse().find((s) => s.status === "active") ?? null;
  const doneSteps = activity.steps.filter((s) => s.status === "done");
  const showInitialPulse = !finished && activeStep === null && activity.steps.length === 0;
  // The summary's top border is a divider from the steps thread above it. With
  // no steps rendered (a tool-less turn), that divider would float with nothing
  // above it — so drop it and sit the summary flush.
  const hasStepsAbove = doneSteps.length > 0 || activeStep !== null || showInitialPulse;

  return (
    <div className="agent-activity" data-testid="agent-activity" data-status={activity.status}>
      {activity.stepName ? <div className="agent-activity-head">{activity.stepName}</div> : null}
      <div className="agent-activity-steps">
        {doneSteps.map((step) => (
          <StepRow key={step.id} step={step} state="done" />
        ))}
        {activeStep ? (
          <StepRow key={activeStep.id} step={activeStep} state={finished ? "interrupted" : "running"} />
        ) : null}
        {showInitialPulse ? (
          <div className="agent-activity-step" data-testid="agent-activity-active">
            <Pulse />
            <span className="agent-activity-step-text">{activity.stepName ?? "Working…"}</span>
          </div>
        ) : null}
      </div>
      {completed && activity.finalSummary ? (
        <div className={`agent-activity-summary${hasStepsAbove ? "" : " agent-activity-summary--flush"}`}>
          {activity.finalSummary}
        </div>
      ) : null}
    </div>
  );
}

type StepRowState = "done" | "running" | "interrupted";

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
      <span className={`agent-activity-step-text${state === "done" ? " is-done" : ""}`}>{step.text}</span>
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
