import type { Dispatch } from "react";
import type { FlowAction, FlowState } from "../state";

type Props = {
  state: Extract<FlowState, { phase: "rough" }>;
  dispatch: Dispatch<FlowAction>;
};

export function RoughGoalStep({ state, dispatch }: Props) {
  const canProceed = state.title.trim().length > 0 && state.intent.trim().length > 0;

  return (
    <div className="flow-step">
      <div className="form-field">
        <label htmlFor="rough-title">Title</label>
        <input
          id="rough-title"
          type="text"
          value={state.title}
          onChange={(e) => dispatch({ type: "setTitle", title: e.target.value })}
          maxLength={200}
          required
          placeholder="What are you trying to achieve?"
          autoFocus
        />
      </div>

      <div className="form-field">
        <label htmlFor="rough-intent">Intent</label>
        <textarea
          id="rough-intent"
          value={state.intent}
          onChange={(e) => dispatch({ type: "setIntent", intent: e.target.value })}
          maxLength={4000}
          required
          placeholder={"What do you want to achieve and why? Describe the outcome, not the steps.\n\nOptionally include sections like:\nGoals:\n  - ...\nConstraints:\n  - ...\nAssumptions:\n  - ..."}
          rows={7}
        />
      </div>

      {state.error && <div className="form-error">{state.error}</div>}

      <div className="flow-step-actions">
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "proceedToCoordinate" })}
          disabled={!canProceed}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
