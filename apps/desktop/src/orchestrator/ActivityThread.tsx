import { useState } from "react";
import type { Activity } from "@orca/contracts";
import type { ComponentType } from "react";

type QuestionFormProps = {
  goalId: string;
  pending: NonNullable<Activity["pendingQuestion"]>;
};

type ProviderRecoveryProps = {
  runId: string;
  recovery: NonNullable<Activity["providerRecovery"]>;
};

export function isMeaningfulCompleted(activity: Activity): boolean {
  return (
    activity.status === "completed" &&
    activity.finalSummary !== null &&
    activity.finalSummary.trim().length > 0 &&
    activity.sourceKind !== "weak_signal"
  );
}

// A turn-level agent activity that owns a persisted card (it has accumulated
// steps or a meaningful summary). step_result keeps its dedicated card.
export function isAgentActivityCard(activity: Activity): boolean {
  return (
    activity.sourceKind !== "step_result" &&
    activity.sourceKind !== "step_confirmation_pending" &&
    activity.sourceKind !== "provider_recovery_pending" &&
    (activity.steps.length > 0 || isMeaningfulCompleted(activity))
  );
}

// An activity that earns a permanent, time-ordered slot in the chat timeline:
// a terminal step-result card or an agent activity card with persisted steps.
export function isTimelineCard(activity: Activity): boolean {
  return activity.sourceKind === "step_result" || isAgentActivityCard(activity);
}

// The latest still-running activity awaiting a pause interaction (confirmation,
// provider recovery, or a pending question). Active tool_use turns are now
// rendered as persisted AgentActivity cards in the timeline, so they are
// excluded here to avoid a duplicate ephemeral tail bubble.
export function pickLiveActivity(activities: Activity[]): Activity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (
      activity?.status === "paused_for_input" &&
      (activity.sourceKind === "step_confirmation_pending" ||
        activity.sourceKind === "provider_recovery_pending" ||
        activity.pendingQuestion != null)
    ) {
      return activity;
    }
  }
  return null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function StepResultCard({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const r = activity.stepResult;
  if (!r) return null;
  const scored = r.evaluationStatus === "scored";
  // For a failed evaluation, outcome.reason is an internal diagnostic string, so
  // lead with a short label and keep the raw reason in the drawer.
  const headline = r.resultSummary ?? (scored ? r.outcome.reason : "Evaluation failed");
  const reasonInDrawer = r.resultSummary != null || !scored;
  return (
    <div className="step-result-card" data-testid="step-result-card" data-status={r.stepStatus} data-eval={r.evaluationStatus}>
      <div className="step-result-head">
        <span className="step-result-name">{activity.stepName ?? "Step"}</span>
        <button type="button" data-testid="step-result-expand" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Details"}</button>
      </div>
      <div className="step-result-summary" data-testid="step-result-summary">{headline}</div>
      {r.primaryArtifact ? (
        <div className="step-result-artifact" data-testid="step-result-artifact" title={r.primaryArtifact.reference}>
          {r.primaryArtifact.description || "Artifact"}: {r.primaryArtifact.reference}
        </div>
      ) : null}
      {open ? (
        <div className="step-result-details">
          <div className="step-result-state">
            {r.stepStatus}{scored ? ` · ${pct(r.successScore)} · ${r.outcome.handoffReady ? "Ready for handoff" : "Not ready"}` : " · Evaluation failed"}
          </div>
          {reasonInDrawer ? <div className="step-result-reason">{r.outcome.reason}</div> : null}
          <div className="step-result-counts">
            {r.outcome.producedArtifactsCount} artifacts · {r.outcome.blockingIssuesCount} blockers · {r.outcome.warningsCount} warnings
          </div>
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
        </div>
      ) : null}
    </div>
  );
}

// One terminal entry in the timeline: a scored result card or a plain summary.
export function ActivityCard({ activity }: { activity: Activity }) {
  if (activity.sourceKind === "step_result") {
    return <StepResultCard activity={activity} />;
  }
  return (
    <div className="activity-summary" data-testid="activity-summary">
      {activity.finalSummary}
    </div>
  );
}

// The live "working" bubble for the active step's agent, pinned to the tail of
// the timeline. Carries the embedded question form when the agent is paused.
export function LiveActivity({
  goalId,
  activity,
  renderQuestionForm: QuestionForm,
  renderProviderRecovery: ProviderRecovery,
  onContinue,
}: {
  goalId: string;
  activity: Activity;
  renderQuestionForm: ComponentType<QuestionFormProps>;
  renderProviderRecovery?: ComponentType<ProviderRecoveryProps>;
  onContinue?: (runId: string) => void;
}) {
  const isConfirmation =
    activity.status === "paused_for_input" &&
    activity.sourceKind === "step_confirmation_pending";
  const isProviderRecovery =
    activity.status === "paused_for_input" &&
    activity.sourceKind === "provider_recovery_pending" &&
    activity.providerRecovery != null;
  // When a question is pending, the question itself leads the card; the generic
  // "I need your call on …" voice line would just be redundant above it.
  const hasPendingQuestion =
    activity.status === "paused_for_input" && activity.pendingQuestion != null;
  return (
    <div
      className={`activity-bubble${hasPendingQuestion ? " activity-bubble--question" : ""}`}
      data-testid="activity-bubble"
      data-status={activity.status}
    >
      {hasPendingQuestion ? null : (
        <div className="activity-bubble-text">{activity.currentText}</div>
      )}
      {activity.status === "paused_for_input" && activity.pendingQuestion ? (
        <QuestionForm goalId={goalId} pending={activity.pendingQuestion} />
      ) : null}
      {isConfirmation ? (
        <div className="step-confirm-actions">
          <button
            type="button"
            data-testid="step-confirm-continue"
            className="step-confirm-continue-btn"
            onClick={() => onContinue?.(activity.workflowRunId)}
          >
            Continue
          </button>
          <span className="step-confirm-hint">
            Continue accepts this result and advances the workflow. Type revisions in chat to send it back to the agent.
          </span>
        </div>
      ) : null}
      {isProviderRecovery && ProviderRecovery && activity.providerRecovery ? (
        <ProviderRecovery
          runId={activity.workflowRunId}
          recovery={activity.providerRecovery}
        />
      ) : null}
    </div>
  );
}
