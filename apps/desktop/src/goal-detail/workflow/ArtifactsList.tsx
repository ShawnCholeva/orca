import type { WorkflowArtifact, WorkflowStepRun } from "@orca/contracts";

type Props = {
  artifacts: WorkflowArtifact[];
  stepRuns: WorkflowStepRun[];
};

export function ArtifactsList({ artifacts, stepRuns }: Props) {
  const stepGroups = stepRuns
    .map((step) => ({
      key: step.id,
      heading: formatStepLabel(step.stepTemplateId),
      artifacts: artifacts.filter((artifact) => artifact.stepRunId === step.id),
    }))
    .filter((group) => group.artifacts.length > 0);
  const runLevelArtifacts = artifacts.filter((artifact) => artifact.stepRunId === null);

  return (
    <section className="workflow-panel-card" aria-label="Workflow artifacts">
      <div className="workflow-panel-card-header">
        <h4 className="workflow-panel-card-title">Artifacts</h4>
        <span className="workflow-panel-card-meta">{artifacts.length} total</span>
      </div>

      {artifacts.length === 0 ? (
        <p className="workflow-panel-empty">No workflow artifacts yet.</p>
      ) : (
        <div className="workflow-artifact-groups">
          {stepGroups.map((group) => (
            <ArtifactGroup
              key={group.key}
              heading={group.heading}
              artifacts={group.artifacts}
            />
          ))}
          {runLevelArtifacts.length > 0 && (
            <ArtifactGroup heading="Run-level" artifacts={runLevelArtifacts} />
          )}
        </div>
      )}
    </section>
  );
}

function ArtifactGroup(props: {
  heading: string;
  artifacts: WorkflowArtifact[];
}) {
  return (
    <section className="workflow-artifact-group">
      <div className="workflow-artifact-group-header">
        <h5>{props.heading}</h5>
        <span>{props.artifacts.length}</span>
      </div>
      <ul className="workflow-artifact-list">
        {props.artifacts.map((artifact) => (
          <li key={artifact.id} className="workflow-artifact-item">
            <details>
              <summary>
                <span className="workflow-artifact-type">{artifact.type}</span>
                <span className="workflow-artifact-title">{artifact.title}</span>
              </summary>
              <p className="workflow-artifact-links">
                {artifact.linkedTaskId ? `Task ${artifact.linkedTaskId}` : "No linked task"}
                {" · "}
                {artifact.linkedSessionId
                  ? `Session ${artifact.linkedSessionId}`
                  : "No linked session"}
              </p>
              <pre className="workflow-artifact-body">{artifact.body}</pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatStepLabel(stepTemplateId: string): string {
  return stepTemplateId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
