import { useState, useRef, useEffect, type Dispatch } from "react";
import type { FlowAction, FlowState, PendingWorkspace } from "../state";
import { inspectWorkspace } from "../../api";
import type { ApiError } from "../../api";
import { expandTilde } from "../../utils/path";

type Props = {
  state: Extract<FlowState, { phase: "workspaces" }>;
  dispatch: Dispatch<FlowAction>;
};

const SOFT_CAP = 8;

function WorkspaceRow({
  ws,
  index,
  dispatch,
}: {
  ws: PendingWorkspace;
  index: number;
  dispatch: Dispatch<FlowAction>;
}) {
  return (
    <li className="workspace-row">
      <div className="workspace-row-info">
        <input
          type="text"
          className="workspace-name-input"
          value={ws.name}
          maxLength={100}
          onChange={(e) => dispatch({ type: "editPendingName", index, name: e.target.value })}
          aria-label="Workspace name"
        />
        <span className="workspace-path-text">{ws.path}</span>
        <div className="workspace-chips">
          <span className="chip chip--type">{ws.workspaceType}</span>
          {ws.branch && <span className="chip chip--branch">{ws.branch}</span>}
          {ws.isDirty === true && <span className="chip chip--dirty" title="Working tree has uncommitted changes">dirty</span>}
        </div>
      </div>
      <button
        type="button"
        className="goal-action-button goal-action-button--danger"
        onClick={() => dispatch({ type: "removePending", index })}
      >
        Remove
      </button>
    </li>
  );
}

export function WorkspaceAttachStep({ state, dispatch }: Props) {
  const [inputPath, setInputPath] = useState("");
  const [inspectError, setInspectError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const atCap = state.pendingWorkspaces.length >= SOFT_CAP;
  const canInspect = inputPath.trim().length > 0 && !state.inspecting && !atCap;

  async function handleInspect() {
    if (!canInspect) return;
    setInspectError(null);
    dispatch({ type: "inspectRequested" });

    const expanded = await expandTilde(inputPath.trim());

    try {
      const { preview } = await inspectWorkspace({ inputPath: expanded });
      dispatch({
        type: "inspectSucceeded",
        preview,
        inputPath: expanded,
        name: preview.name,
      });
      setInputPath("");
    } catch (err) {
      const code = (err as ApiError).code ?? (err as ApiError).message ?? "Inspection failed";
      dispatch({ type: "inspectFailed", error: code });
      setInspectError(code);
    }
  }

  function handlePathKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void handleInspect(), 250);
  }

  function handleInspectClick() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void handleInspect(), 250);
  }

  const noWorkspaces = state.pendingWorkspaces.length === 0;

  return (
    <div className="flow-step">
      <h3 className="flow-step-heading">Attach Workspaces</h3>
      <p className="flow-step-hint">
        Add local folders or git repos this Goal will operate on.
      </p>

      {state.pendingWorkspaces.length > 0 && (
        <ul className="workspace-pending-list">
          {state.pendingWorkspaces.map((ws, i) => (
            <WorkspaceRow key={ws.path} ws={ws} index={i} dispatch={dispatch} />
          ))}
        </ul>
      )}

      {atCap ? (
        <p className="workspace-cap-notice">Maximum {SOFT_CAP} workspaces per Goal creation reached.</p>
      ) : (
        <div className="workspace-add-row">
          <div className="workspace-path-input-group">
            <input
              type="text"
              value={inputPath}
              onChange={(e) => {
                setInputPath(e.target.value);
                setInspectError(null);
              }}
              onKeyDown={handlePathKeyDown}
              placeholder="/absolute/path/to/workspace"
              className="workspace-path-input"
              disabled={state.inspecting}
              aria-label="Workspace path"
            />
            <button
              type="button"
              className="goal-action-button"
              onClick={handleInspectClick}
              disabled={!canInspect}
            >
              {state.inspecting ? "Inspecting…" : "Inspect"}
            </button>
          </div>
          {inspectError && (
            <p className="form-error workspace-inspect-error">
              {inspectError}
              <button
                type="button"
                className="goal-action-button workspace-retry-btn"
                onClick={handleInspectClick}
                disabled={state.inspecting}
              >
                Retry
              </button>
            </p>
          )}
          {state.error && !inspectError && (
            <p className="form-error">{state.error}</p>
          )}
        </div>
      )}

      {noWorkspaces && (
        <p className="workspace-warn">
          This Goal has no workspaces yet. You can add them later from the detail view.
        </p>
      )}

      <div className="flow-step-actions">
        <button
          type="button"
          className="goal-action-button"
          onClick={() => dispatch({ type: "backToReview" })}
          disabled={state.inspecting}
        >
          ← Back
        </button>
        <button
          type="button"
          className="submit-button"
          onClick={() => dispatch({ type: "submitRequested" })}
          disabled={state.inspecting}
        >
          Create Goal
        </button>
      </div>
    </div>
  );
}
