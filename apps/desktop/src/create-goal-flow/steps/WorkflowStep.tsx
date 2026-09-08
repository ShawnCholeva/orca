import { useState, useEffect, type CSSProperties, type Dispatch } from "react";
import type { FlowAction, FlowState } from "../state";
import type { WorkflowTemplate } from "@orca/contracts";
import { listWorkflowTemplates, toErrorMessage } from "../../api";
import { FieldGroup, Pill } from "../../workspaces/primitives";
import { Icon } from "../../workspaces/icons";

type Props = {
  state: Extract<FlowState, { phase: "workflow" }>;
  dispatch: Dispatch<FlowAction>;
};

const mutedStyle: CSSProperties = { fontSize: 12, color: "var(--text-3)", margin: 0 };
const errorStyle: CSSProperties = { fontSize: 12, color: "var(--err)", margin: 0 };

// ── Workflow card ──────────────────────────────────────────────
function WorkflowCard({
  template,
  selected,
  onSelect,
}: {
  template: WorkflowTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={"wf-card" + (selected ? " wf-card--selected" : "")}
    >
      <div className="wf-card-head">
        <span className="wf-card-icon" aria-hidden="true">
          <Icon.workflow size={15} />
        </span>
        <span className="wf-card-name">{template.name}</span>
        {template.isBuiltIn && (
          <Pill tone="accent" size="xs">
            built-in
          </Pill>
        )}
        <span className="wf-card-radio" aria-hidden="true">
          {selected && <Icon.check size={11} />}
        </span>
      </div>
      {template.description && <span className="wf-card-desc">{template.description}</span>}
      <div className="wf-card-meta">
        <Pill tone="info" size="xs">
          {template.category}
        </Pill>
      </div>
    </button>
  );
}

// ── Main WorkflowStep ──────────────────────────────────────────
export function WorkflowStep({ state, dispatch }: Props) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    listWorkflowTemplates()
      .then((res) => {
        if (!cancelled) {
          setTemplates(res.templates);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(toErrorMessage(err, "Failed to load workflows."));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = [...new Set(templates.map((t) => t.category))].sort();
  const visible = category === "all" ? templates : templates.filter((t) => t.category === category);

  let body;
  if (loading) {
    body = <p style={mutedStyle}>Loading workflows…</p>;
  } else if (loadError) {
    body = <p style={errorStyle}>{loadError}</p>;
  } else if (templates.length === 0) {
    body = <p style={mutedStyle}>No workflows available. Create one in the Workflows tab.</p>;
  } else {
    body = (
      <>
        <div role="group" aria-label="Filter by type" className="wf-pick-filter">
          {[["all", "All types"] as const, ...categories.map((c) => [c, c] as const)].map(([id, label]) => {
            const count = id === "all" ? templates.length : templates.filter((t) => t.category === id).length;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={category === id}
                className={"wf-pick-chip" + (category === id ? " wf-pick-chip--active" : "")}
                onClick={() => setCategory(id)}
              >
                {label}
                <span className="wf-pick-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div role="radiogroup" aria-label="Workflow" className="wf-pick-grid">
          {visible.map((t) => (
            <WorkflowCard
              key={t.id}
              template={t}
              selected={t.id === state.workflowTemplateId}
              onSelect={() => dispatch({ type: "setWorkflowTemplateId", workflowTemplateId: t.id })}
            />
          ))}
        </div>
        {visible.length === 0 && <p style={mutedStyle}>No workflows of this type.</p>}
      </>
    );
  }

  const noWorkflow = state.workflowTemplateId === null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <FieldGroup label="Workflow" hint="Pick the workflow this Goal will run.">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{body}</div>
      </FieldGroup>

      {state.error && <p style={errorStyle}>{state.error}</p>}

      {/* Footer actions */}
      <div className="flow-step-actions">
        <button
          type="button"
          className="back-button"
          onClick={() => dispatch({ type: "backToCoordinate" })}
        >
          ← Back
        </button>
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "submitRequested" })}
          disabled={noWorkflow}
          title={noWorkflow ? "Select a workflow to continue" : undefined}
        >
          Create Goal
        </button>
      </div>
    </div>
  );
}
