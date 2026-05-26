import type {
  OrchestrationTransportAttempt,
  WorkflowDecisionTrace,
} from "@orca/contracts";

import { summarizeAttemptStatus } from "./transportStatus";

type Props = {
  decisions: WorkflowDecisionTrace[];
  attempts: OrchestrationTransportAttempt[];
  onOpenTransportDebug: (attemptId: string) => void;
};

export function DecisionTraceTimeline({ decisions, attempts, onOpenTransportDebug }: Props) {
  return (
    <section className="workflow-panel-card" aria-label="Workflow decisions">
      <div className="workflow-panel-card-header">
        <h4 className="workflow-panel-card-title">Decision Trace</h4>
        <span className="workflow-panel-card-meta">{decisions.length} recorded</span>
      </div>

      {decisions.length === 0 ? (
        <p className="workflow-panel-empty">No workflow decisions yet.</p>
      ) : (
        <ol className="workflow-decision-timeline">
          {decisions.map((decision) => (
            <li key={decision.decisionId} className="workflow-decision-item">
              <div className="workflow-decision-head">
                <div className="workflow-decision-heading">
                  <span className="workflow-decision-badge">{decision.decisionType}</span>
                  <span className="workflow-decision-action">
                    {summarizeAction(decision.selectedAction)}
                  </span>
                </div>
                {decision.transportSummary && (
                  <button
                    type="button"
                    className="goal-action-button goal-action-button--secondary"
                    onClick={() => onOpenTransportDebug(decision.transportSummary!.attemptId)}
                  >
                    Debug transport
                  </button>
                )}
              </div>
              {decision.transportSummary && (
                <p className="workflow-decision-transport">
                  <span
                    className={`workflow-transport-status-chip workflow-transport-status-chip--${resolveTransportTone(decision.transportSummary.attemptId, attempts)}`}
                  >
                    {resolveTransportLabel(decision.transportSummary.attemptId, attempts)}
                  </span>
                </p>
              )}
              <p className="workflow-decision-reason">{decision.reason}</p>
              {decision.influencedBy.length > 0 && (
                <ul className="workflow-decision-influences" aria-label="Influenced by">
                  {decision.influencedBy.map((influence) => (
                    <li key={`${decision.decisionId}:${influence.kind}:${influence.id}`}>
                      {influence.kind}:{influence.label} ({influence.effect})
                    </li>
                  ))}
                </ul>
              )}
              {decision.operatorSelectionJson && (
                <p className="workflow-decision-operator">
                  Operator: {decision.operatorSelectionJson.operatorId} (
                  {decision.operatorSelectionJson.operatorKind})
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function summarizeAction(value: string): string {
  return value
    .replace(/^recommend_advance:/, "advance: ")
    .replace(/^recommend_/, "")
    .replace(/^request_input:/, "request input: ")
    .replace(/_/g, " ");
}

function resolveTransportLabel(
  attemptId: string,
  attempts: OrchestrationTransportAttempt[],
): string {
  const attempt = attempts.find((item) => item.id === attemptId);
  if (!attempt) return "Transport recorded";
  return summarizeAttemptStatus(attempt, attempts).label;
}

function resolveTransportTone(
  attemptId: string,
  attempts: OrchestrationTransportAttempt[],
): "success" | "warning" | "danger" | "neutral" {
  const attempt = attempts.find((item) => item.id === attemptId);
  if (!attempt) return "neutral";
  return summarizeAttemptStatus(attempt, attempts).tone;
}
