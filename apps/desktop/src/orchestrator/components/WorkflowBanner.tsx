import type {
  WorkflowArtifact,
  WorkflowDecisionTrace,
  WorkflowRun,
  WorkflowStepRun,
} from "@orca/contracts";

type Props = {
  run: WorkflowRun;
  stepRun: WorkflowStepRun | null;
  latestDecision: WorkflowDecisionTrace | null;
  artifacts: WorkflowArtifact[];
};

export function WorkflowBanner({ run, stepRun, latestDecision, artifacts }: Props) {
  const visibleArtifacts = artifacts.slice(0, 6);

  return (
    <section className={`workflow-banner workflow-banner--${run.status}`} aria-label="Current workflow run">
      <div className="workflow-banner-head">
        <div>
          <p className="workflow-banner-label">Current run</p>
          <h3 className="workflow-banner-title">
            Engineering workflow
            {stepRun ? ` · ${formatStepLabel(stepRun.stepTemplateId)}` : ""}
          </h3>
        </div>
        <span className={`workflow-banner-status workflow-banner-status--${run.status}`}>
          {run.status}
        </span>
      </div>

      {latestDecision && (
        <div className="workflow-banner-decision">
          <p className="workflow-banner-subtitle">Next action</p>
          <p className="workflow-banner-action">{summarizeAction(latestDecision.selectedAction)}</p>
          <details className="workflow-banner-details">
            <summary>Why this action?</summary>
            <p className="workflow-banner-reason">{latestDecision.reason}</p>
            {latestDecision.influencedBy.length > 0 && (
              <ul className="workflow-banner-influences">
                {latestDecision.influencedBy.map((influence) => (
                  <li key={`${influence.kind}:${influence.id}`}>
                    <span className={`workflow-influence-effect workflow-influence-effect--${influence.effect}`}>
                      {influence.effect}
                    </span>
                    <span>{influence.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      )}

      <div className="workflow-banner-artifacts">
        <p className="workflow-banner-subtitle">Artifacts ({artifacts.length})</p>
        {visibleArtifacts.length === 0 ? (
          <p className="workflow-banner-empty">No workflow artifacts yet.</p>
        ) : (
          <ul className="workflow-banner-artifact-list">
            {visibleArtifacts.map((artifact) => (
              <li key={artifact.id} className="workflow-banner-artifact">
                <span className="workflow-banner-artifact-type">{artifact.type}</span>
                <span className="workflow-banner-artifact-title">{artifact.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function formatStepLabel(stepTemplateId: string): string {
  return stepTemplateId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarizeAction(value: string): string {
  return value
    .replace(/^recommend_/, "")
    .replace(/^request_input:/, "request input: ")
    .replace(/^recommend_advance:/, "advance: ")
    .replace(/_/g, " ");
}
