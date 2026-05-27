import { useReducer, useEffect } from "react";
import { reducer, initialState } from "./state";
import type { WorkflowFailedState } from "./state";
import { RoughGoalStep } from "./steps/RoughGoalStep";
import { CoordinateStep } from "./steps/CoordinateStep";
import { createGoalAndStartWorkflow } from "../api";
import type { ApiError } from "../api";
import type { ConnectionStatus } from "../api";
import type { OrchestratorModelChoice } from "@orca/contracts";

type Props = {
  onClose: () => void;
  onDone: (goalId: string) => void;
  connectionStatus: ConnectionStatus;
};

const STEP_LABELS = ["Describe", "Coordinate"];
const STEP_NUMS = ["01", "02"];

function stepIndex(phase: string): number {
  switch (phase) {
    case "rough": return 0;
    case "coordinate": return 1;
    case "submitting": return 1;
    case "workflowFailed": return 1;
    default: return 1;
  }
}

function WorkflowFailedPanel({
  state,
  onRetry,
  onOpenGoal,
}: {
  state: WorkflowFailedState;
  onRetry: () => void;
  onOpenGoal: () => void;
}) {
  return (
    <div className="flow-step">
      <div className="form-field">
        <p className="form-error">
          Goal created but workflow bootstrap failed: {state.error}
        </p>
      </div>
      <div className="flow-step-actions">
        <button type="button" className="goal-action-button" onClick={onOpenGoal}>
          Open Goal
        </button>
        <button type="button" className="submit-button" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

export function CreateGoalFlow({ onClose, onDone, connectionStatus: _connectionStatus }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (state.phase !== "submitting") return;
    let cancelled = false;

    const {
      title,
      description,
      pendingWorkspaces,
      orchestratorModel,
      workflowTemplateId,
    } = state;

    // workflowTemplateId is always non-null here (guarded in CoordinateStep)
    if (!workflowTemplateId) {
      dispatch({ type: "submitFailed", error: "No workflow template selected." });
      return;
    }

    const templateId: string = workflowTemplateId;

    async function run() {
      try {
        const result = await createGoalAndStartWorkflow({
          title,
          description,
          workspaces: pendingWorkspaces.map((ws) => ({
            inputPath: ws.inputPath,
            name: ws.name,
          })),
          orchestratorModel: (orchestratorModel as OrchestratorModelChoice) ?? undefined,
          workflowTemplateId: templateId,
        });

        if (cancelled) return;

        if (result.ok) {
          dispatch({ type: "submitSucceeded", goalId: result.goalId });
          onDone(result.goalId);
        } else {
          dispatch({
            type: "workflowBootstrapFailed",
            goalId: result.goalId,
            workflowRunId: result.workflowRunId,
            error: result.bootstrapError.message,
          });
        }
      } catch (err: unknown) {
        if (!cancelled) {
          dispatch({ type: "submitFailed", error: (err as ApiError).message ?? "Unexpected error" });
        }
      }
    }

    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  const currentStep = stepIndex(state.phase);

  return (
    <div className="flow-overlay" role="dialog" aria-modal="true" aria-label="Create Goal">
      <div className="flow-modal">
        <div className="flow-header">
          <span className="flow-header-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
            </svg>
          </span>
          <div className="flow-header-text">
            <div className="flow-header-kicker">New goal</div>
            <h2 className="flow-header-title">Define an operational objective</h2>
          </div>
          <div className="flow-steps-indicator">
            {STEP_LABELS.map((label, i) => (
              <div
                key={label}
                className={`flow-step-dot ${i === currentStep ? "flow-step-dot--active" : ""} ${i < currentStep ? "flow-step-dot--done" : ""}`}
              >
                <span className="flow-step-dot-num">{STEP_NUMS[i]}</span>
                {label}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="flow-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flow-body">
          {state.phase === "rough" && (
            <RoughGoalStep state={state} dispatch={dispatch} />
          )}

          {state.phase === "coordinate" && (
            <CoordinateStep state={state} dispatch={dispatch} />
          )}

          {state.phase === "submitting" && (
            <div className="flow-loading">
              <div className="flow-spinner" />
              <p>Creating Goal…</p>
            </div>
          )}

          {state.phase === "workflowFailed" && (
            <WorkflowFailedPanel
              state={state}
              onRetry={() => dispatch({ type: "retryWorkflowStart" })}
              onOpenGoal={() => onDone(state.goalId)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
