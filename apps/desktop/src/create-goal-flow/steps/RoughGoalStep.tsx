import type { Dispatch } from "react";
import type { FlowAction, FlowState } from "../state";
import { OrchestratorModelPicker } from "../../orchestrator/components/OrchestratorModelPicker";

type Props = {
  state: Extract<FlowState, { phase: "rough" }>;
  dispatch: Dispatch<FlowAction>;
  connected: boolean;
};

export function RoughGoalStep({ state, dispatch, connected }: Props) {
  const canRefine = connected && state.title.trim().length > 0;

  return (
    <div className="flow-step">
      <h3 className="flow-step-heading">Describe your Goal</h3>
      <p className="flow-step-hint">Enter a rough description — Orca will help structure it.</p>

      <div className="form-field">
        <label htmlFor="rough-title">Title</label>
        <input
          id="rough-title"
          type="text"
          value={state.title}
          onChange={(e) => dispatch({ type: "setTitle", title: e.target.value })}
          maxLength={200}
          required
          disabled={!connected}
          placeholder="What are you trying to achieve?"
        />
      </div>

      <div className="form-field">
        <label htmlFor="rough-description">Description</label>
        <textarea
          id="rough-description"
          value={state.description}
          onChange={(e) => dispatch({ type: "setDescription", description: e.target.value })}
          maxLength={4000}
          disabled={!connected}
          placeholder={"Optionally include sections like:\nGoals:\n  - ...\nConstraints:\n  - ...\nAssumptions:\n  - ..."}
          rows={6}
        />
      </div>

      <OrchestratorModelPicker
        value={state.orchestratorModel}
        onChange={(orchestratorModel) =>
          dispatch({ type: "setOrchestratorModel", orchestratorModel })
        }
        disabled={!connected}
      />

      {state.error && <div className="form-error">{state.error}</div>}

      <div className="flow-step-actions">
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "refineRequested" })}
          disabled={!canRefine}
        >
          Refine →
        </button>
      </div>
    </div>
  );
}
