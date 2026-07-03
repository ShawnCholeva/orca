import type { WorkflowRun } from "@orca/contracts";

type Props = {
  parentRun: WorkflowRun;
  childRun: WorkflowRun;
  activeRunId: string;
  onSelect: (runId: string) => void;
};

export function DelegationBreadcrumb({ parentRun, childRun, activeRunId, onSelect }: Props) {
  return (
    <nav className="delegation-breadcrumb" aria-label="Delegation">
      <button
        type="button"
        className={`delegation-breadcrumb-crumb${activeRunId === parentRun.id ? " delegation-breadcrumb-crumb--active" : ""}`}
        onClick={() => onSelect(parentRun.id)}
        aria-current={activeRunId === parentRun.id ? "page" : undefined}
      >
        {parentRun.templateId}
      </button>
      <span className="delegation-breadcrumb-sep" aria-hidden="true">›</span>
      <button
        type="button"
        className={`delegation-breadcrumb-crumb${activeRunId === childRun.id ? " delegation-breadcrumb-crumb--active" : ""}`}
        onClick={() => onSelect(childRun.id)}
        aria-current={activeRunId === childRun.id ? "page" : undefined}
      >
        {childRun.templateId}
      </button>
    </nav>
  );
}
