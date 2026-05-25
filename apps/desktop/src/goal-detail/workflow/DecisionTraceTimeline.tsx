import type { WorkflowDecisionTrace } from "@orca/contracts";

type Props = {
  decisions: WorkflowDecisionTrace[];
};

export function DecisionTraceTimeline({ decisions }: Props) {
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
                <span className="workflow-decision-badge">{decision.decisionType}</span>
                <span className="workflow-decision-action">
                  {summarizeAction(decision.selectedAction)}
                </span>
              </div>
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
