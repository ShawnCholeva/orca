import type { Dispatch } from "react";
import type { FlowAction, FlowState, RefinementField } from "../state";

type Props = {
  state: Extract<FlowState, { phase: "review" }>;
  dispatch: Dispatch<FlowAction>;
};

const FIELD_LABELS: Record<RefinementField, string> = {
  successCriteria: "Success Criteria",
  constraints: "Constraints",
  assumptions: "Assumptions",
};

function ArrayEditor({
  field,
  items,
  dispatch,
}: {
  field: RefinementField;
  items: string[];
  dispatch: Dispatch<FlowAction>;
}) {
  return (
    <div className="refinement-field">
      <div className="refinement-field-header">
        <span className="refinement-field-label">{FIELD_LABELS[field]}</span>
        <button
          type="button"
          className="goal-action-button"
          onClick={() => dispatch({ type: "addArrayItem", field })}
        >
          + Add
        </button>
      </div>
      {items.length === 0 ? (
        <p className="refinement-empty">No items. Click "+ Add" to add one.</p>
      ) : (
        <ul className="refinement-item-list">
          {items.map((item, i) => (
            <li key={i} className="refinement-item">
              <input
                type="text"
                value={item}
                maxLength={200}
                onChange={(e) =>
                  dispatch({ type: "editArrayItem", field, index: i, value: e.target.value })
                }
                className="refinement-item-input"
                placeholder="Enter item…"
              />
              <button
                type="button"
                className="goal-action-button goal-action-button--danger refinement-item-remove"
                onClick={() => dispatch({ type: "removeArrayItem", field, index: i })}
                aria-label="Remove"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RefinementReviewStep({ state, dispatch }: Props) {
  const { draft } = state;

  return (
    <div className="flow-step">
      <h3 className="flow-step-heading">Review Refined Goal</h3>
      <p className="flow-step-hint">
        Orca has structured your Goal. Edit any section before attaching workspaces.
      </p>

      <div className="refinement-title-row">
        <span className="refinement-goal-title">{draft.title}</span>
      </div>

      {draft.description && (
        <p className="refinement-description">{draft.description}</p>
      )}

      <ArrayEditor field="successCriteria" items={draft.successCriteria} dispatch={dispatch} />
      <ArrayEditor field="constraints" items={draft.constraints} dispatch={dispatch} />
      <ArrayEditor field="assumptions" items={draft.assumptions} dispatch={dispatch} />

      <div className="flow-step-actions">
        <button
          type="button"
          className="goal-action-button"
          onClick={() => dispatch({ type: "backToRough" })}
        >
          ← Back
        </button>
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "proceedToWorkspaces" })}
        >
          Attach Workspaces →
        </button>
      </div>
    </div>
  );
}
