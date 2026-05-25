import { useReducer, useEffect } from "react";
import { reducer, initialState } from "./state";
import { RoughGoalStep } from "./steps/RoughGoalStep";
import { RefinementReviewStep } from "./steps/RefinementReviewStep";
import { WorkspaceAttachStep } from "./steps/WorkspaceAttachStep";
import { refineGoal, createGoal } from "../api";
import type { ApiError } from "../api";
import type { ConnectionStatus } from "../api";

type Props = {
  onClose: () => void;
  onDone: (goalId: string) => void;
  connectionStatus: ConnectionStatus;
};

const STEP_LABELS = ["Describe", "Review", "Workspaces"];

function stepIndex(phase: string): number {
  switch (phase) {
    case "rough": return 0;
    case "refining": return 0;
    case "review": return 1;
    case "workspaces": return 2;
    case "submitting": return 2;
    default: return 2;
  }
}

export function CreateGoalFlow({ onClose, onDone, connectionStatus }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const connected = connectionStatus === "open";

  useEffect(() => {
    if (state.phase !== "refining") return;
    let cancelled = false;
    refineGoal({ title: state.title, description: state.description })
      .then((res) => {
        if (!cancelled) dispatch({ type: "refineSucceeded", draft: res.draft });
      })
      .catch((err: ApiError) => {
        if (!cancelled) dispatch({ type: "refineFailed", error: err.message });
      });
    return () => { cancelled = true; };
  }, [state.phase]);

  useEffect(() => {
    if (state.phase !== "submitting") return;
    let cancelled = false;
    const { title, description, draft, pendingWorkspaces, orchestratorModel } = state;
    createGoal({
      title,
      description,
      refined: draft,
      workspaces: pendingWorkspaces.map((ws) => ({
        inputPath: ws.inputPath,
        name: ws.name,
      })),
      orchestratorModel: orchestratorModel ?? undefined,
    })
      .then((res) => {
        if (!cancelled) {
          dispatch({ type: "submitSucceeded", goalId: res.goal.id });
          onDone(res.goal.id);
        }
      })
      .catch((err: ApiError) => {
        if (!cancelled) dispatch({ type: "submitFailed", error: err.message });
      });
    return () => { cancelled = true; };
  }, [state.phase]);

  const currentStep = stepIndex(state.phase);

  return (
    <div className="flow-overlay" role="dialog" aria-modal="true" aria-label="Create Goal">
      <div className="flow-modal">
        <div className="flow-header">
          <h2 className="flow-title">New Goal</h2>
          <button
            type="button"
            className="flow-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flow-steps-indicator">
          {STEP_LABELS.map((label, i) => (
            <div
              key={label}
              className={`flow-step-dot ${i === currentStep ? "flow-step-dot--active" : ""} ${i < currentStep ? "flow-step-dot--done" : ""}`}
            >
              {label}
            </div>
          ))}
        </div>

        <div className="flow-body">
          {(state.phase === "rough") && (
            <RoughGoalStep state={state} dispatch={dispatch} connected={connected} />
          )}

          {state.phase === "refining" && (
            <div className="flow-loading">
              <div className="flow-spinner" />
              <p>Refining your Goal…</p>
            </div>
          )}

          {state.phase === "review" && (
            <RefinementReviewStep state={state} dispatch={dispatch} />
          )}

          {state.phase === "workspaces" && (
            <WorkspaceAttachStep state={state} dispatch={dispatch} />
          )}

          {state.phase === "submitting" && (
            <div className="flow-loading">
              <div className="flow-spinner" />
              <p>Creating Goal…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
