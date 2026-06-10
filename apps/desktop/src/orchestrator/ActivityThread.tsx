import { useState } from "react";
import type { Activity } from "@orca/contracts";
import type { ComponentType } from "react";

type QuestionFormProps = {
  goalId: string;
  pending: NonNullable<Activity["pendingQuestion"]>;
};

type ActivityThreadProps = {
  goalId: string;
  activities: Activity[];
  renderQuestionForm: ComponentType<QuestionFormProps>;
};

function isMeaningfulCompleted(activity: Activity): boolean {
  return (
    activity.status === "completed" &&
    activity.finalSummary !== null &&
    activity.finalSummary.trim().length > 0 &&
    activity.sourceKind !== "weak_signal"
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function StepResultCard({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const r = activity.stepResult;
  if (!r) return null;
  const scored = r.evaluationStatus === "scored";
  return (
    <div className="step-result-card" data-testid="step-result-card" data-status={r.stepStatus} data-eval={r.evaluationStatus}>
      <div className="step-result-head">
        <span className="step-result-name">{activity.stepName ?? "Step"}</span>
        <span className="step-result-state">{r.stepStatus}</span>
        {scored ? <span className="step-result-score">{pct(r.successScore)}</span> : <span className="step-result-eval-failed">Evaluation failed</span>}
        {scored ? <span className="step-result-handoff">{r.outcome.handoffReady ? "Ready for handoff" : "Not ready"}</span> : null}
        <button type="button" data-testid="step-result-expand" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Details"}</button>
      </div>
      <div className="step-result-reason">{r.outcome.reason}</div>
      <div className="step-result-counts">
        {r.outcome.producedArtifactsCount} artifacts · {r.outcome.blockingIssuesCount} blockers · {r.outcome.warningsCount} warnings
      </div>
      {open ? (
        <dl className="step-result-metrics">
          {scored ? (
            <>
              <div><dt>Output completeness</dt><dd>{pct(r.quality.outputCompleteness)}</dd></div>
              <div><dt>Output correctness</dt><dd>{pct(r.quality.outputCorrectness)}</dd></div>
              <div><dt>Instruction adherence</dt><dd>{pct(r.quality.instructionAdherence)}</dd></div>
              <div><dt>Downstream readiness</dt><dd>{pct(r.quality.downstreamReadiness)}</dd></div>
              <div><dt>Risk level (higher = riskier)</dt><dd>{pct(r.quality.riskLevel)}</dd></div>
            </>
          ) : null}
          <div><dt>Duration</dt><dd>{r.performance.durationSeconds}s</dd></div>
          <div><dt>Retries</dt><dd>{r.performance.retries}</dd></div>
          {r.performance.totalTurns !== undefined ? <div><dt>Total turns</dt><dd>{r.performance.totalTurns}</dd></div> : null}
          {r.performance.toolCalls !== undefined ? <div><dt>Tool calls</dt><dd>{r.performance.toolCalls}</dd></div> : null}
        </dl>
      ) : null}
    </div>
  );
}

export function ActivityThread({
  goalId,
  activities,
  renderQuestionForm: QuestionForm,
}: ActivityThreadProps) {
  const terminalCards = activities.filter(
    (a) => isMeaningfulCompleted(a) || a.sourceKind === "step_result"
  );
  let live: Activity | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.status === "active" || activity?.status === "paused_for_input") {
      live = activity;
      break;
    }
  }

  return (
    <div className="activity-thread">
      {terminalCards.map((activity) =>
        activity.sourceKind === "step_result" ? (
          <StepResultCard key={activity.id} activity={activity} />
        ) : (
          <div key={activity.id} className="activity-summary" data-testid="activity-summary">
            {activity.finalSummary}
          </div>
        )
      )}
      {live ? (
        <div
          className="activity-bubble"
          data-testid="activity-bubble"
          data-status={live.status}
        >
          <div className="activity-bubble-text">{live.currentText}</div>
          {live.status === "paused_for_input" && live.pendingQuestion ? (
            <QuestionForm goalId={goalId} pending={live.pendingQuestion} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
