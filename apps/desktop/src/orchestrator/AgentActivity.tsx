import { useState } from "react";
import type { Activity, ActivityDiff, ActivityStep } from "@orca/contracts";

export function AgentActivity({ activity }: { activity: Activity }) {
  const completed = activity.status === "completed";
  // The active line is the last step still marked active; if there is none yet
  // (step opened, no tool call run), fall back to a single pulse.
  const activeStep = [...activity.steps].reverse().find((s) => s.status === "active") ?? null;
  const doneSteps = activity.steps.filter((s) => s.status === "done");
  const showInitialPulse = !completed && activeStep === null && activity.steps.length === 0;

  return (
    <div className="agent-activity" data-testid="agent-activity" data-status={activity.status}>
      {activity.stepName ? <div className="agent-activity-head">{activity.stepName}</div> : null}
      <div className="agent-activity-steps">
        {doneSteps.map((step) => (
          <StepRow key={step.id} step={step} done />
        ))}
        {activeStep ? <StepRow key={activeStep.id} step={activeStep} done={false} /> : null}
        {showInitialPulse ? (
          <div className="agent-activity-step" data-testid="agent-activity-active">
            <Pulse />
            <span className="agent-activity-step-text">{activity.stepName ?? "Working…"}</span>
          </div>
        ) : null}
      </div>
      {completed && activity.finalSummary ? (
        <div className="agent-activity-summary">{activity.finalSummary}</div>
      ) : null}
    </div>
  );
}

function StepRow({ step, done }: { step: ActivityStep; done: boolean }) {
  return (
    <div
      className="agent-activity-step"
      data-testid={done ? "agent-activity-done" : "agent-activity-active"}
    >
      {done ? <Check /> : <Pulse />}
      <span className={`agent-activity-step-text${done ? " is-done" : ""}`}>{step.text}</span>
      {step.diff ? <DiffBlock diff={step.diff} /> : null}
    </div>
  );
}

function DiffBlock({ diff }: { diff: ActivityDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-activity-diff">
      <button
        type="button"
        className="agent-activity-diff-toggle"
        data-testid="agent-activity-diff-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="agent-activity-diff-chevron">{open ? "▾" : "▸"}</span>
        <span className="agent-activity-diff-file">{diff.filePath}</span>
        <span className="agent-activity-diff-stat">
          <span className="diff-add">+{diff.additions}</span>{" "}
          <span className="diff-del">−{diff.deletions}</span>
        </span>
      </button>
      {open ? (
        <pre className="agent-activity-diff-body">
          {diff.hunks.flatMap((hunk, hi) =>
            hunk.lines.map((line, li) => {
              const oldNo = hunk.oldStart;
              const newNo = hunk.newStart;
              return (
                <div key={`${hi}-${li}`} className={`diff-line diff-line--${line.kind}`}>
                  <span className="diff-gutter">
                    {newNo === null ? "" : line.kind === "remove" ? "-" : "+"}
                  </span>
                  <span className="diff-text">{line.text}</span>
                </div>
              );
            })
          )}
        </pre>
      ) : null}
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

function Pulse() {
  return (
    <span className="thinking-dots agent-activity-pulse" aria-hidden>
      <span style={{ animationDelay: "0s" }} />
      <span style={{ animationDelay: "0.18s" }} />
      <span style={{ animationDelay: "0.36s" }} />
    </span>
  );
}
