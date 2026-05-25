import type { WorkflowStepRun } from "@orca/contracts";

type Props = {
  steps: WorkflowStepRun[];
  currentStepRunId: string | null;
};

export function StepTimeline({ steps, currentStepRunId }: Props) {
  return (
    <section className="workflow-panel-card" aria-label="Workflow steps">
      <div className="workflow-panel-card-header">
        <h4 className="workflow-panel-card-title">Step Timeline</h4>
        <span className="workflow-panel-card-meta">{steps.length} total</span>
      </div>
      {steps.length === 0 ? (
        <p className="workflow-panel-empty">No step runs recorded yet.</p>
      ) : (
        <ol className="workflow-step-timeline">
          {steps.map((step) => {
            const isCurrent = step.id === currentStepRunId;
            return (
              <li
                key={step.id}
                className={`workflow-step-pill workflow-step-pill--${step.status}${isCurrent ? " workflow-step-pill--current" : ""}`}
              >
                <span className="workflow-step-icon" aria-hidden="true">
                  {statusIcon(step.status)}
                </span>
                <span className="workflow-step-copy">
                  <span className="workflow-step-name">{formatStepLabel(step.stepTemplateId)}</span>
                  <span className="workflow-step-meta">
                    Attempt {step.attempt} · {step.status}
                    {isCurrent ? " · current" : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function statusIcon(status: WorkflowStepRun["status"]): string {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
      return "×";
    case "blocked":
      return "!";
    case "skipped":
      return "↷";
    case "active":
      return "●";
    case "pending":
    default:
      return "○";
  }
}

function formatStepLabel(stepTemplateId: string): string {
  return stepTemplateId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
