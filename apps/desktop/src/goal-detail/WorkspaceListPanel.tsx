import { useState } from "react";
import type { Workspace } from "@orca/contracts";
import { inspectWorkspace, attachWorkspace, detachWorkspace } from "../api";
import type { ApiError } from "../api";
import { expandTilde } from "../utils/path";

type Props = {
  goalId: string;
  workspaces: Workspace[];
  onChanged: () => void;
};

export function WorkspaceListPanel({ goalId, workspaces, onChanged }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addName, setAddName] = useState("");
  const [addInspecting, setAddInspecting] = useState(false);
  const [addPreview, setAddPreview] = useState<Awaited<ReturnType<typeof inspectWorkspace>>["preview"] | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleInspect() {
    if (!addPath.trim()) return;
    setAddError(null);
    setAddPreview(null);
    setAddInspecting(true);
    try {
      const expanded = await expandTilde(addPath.trim());
      const { preview } = await inspectWorkspace({ inputPath: expanded });
      setAddPreview(preview);
      setAddName(preview.name);
    } catch (err) {
      setAddError((err as ApiError).code ?? (err as ApiError).message ?? "Inspection failed");
    } finally {
      setAddInspecting(false);
    }
  }

  async function handleAttach() {
    if (!addPreview) return;
    setAddSubmitting(true);
    setAddError(null);
    try {
      const expanded = await expandTilde(addPath.trim());
      await attachWorkspace(goalId, {
        inputPath: expanded,
        name: addName || addPreview.name,
      });
      setShowAdd(false);
      setAddPath("");
      setAddPreview(null);
      setAddName("");
      onChanged();
    } catch (err) {
      setAddError((err as ApiError).message ?? "Attach failed");
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleRemove(ws: Workspace) {
    if (!confirm(`Remove workspace "${ws.name}"?`)) return;
    setRemovingId(ws.id);
    setRemoveError(null);
    try {
      await detachWorkspace(goalId, ws.id);
      onChanged();
    } catch (err) {
      setRemoveError((err as ApiError).message ?? "Remove failed");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <section className="goal-detail-section">
      <div className="goal-detail-section-header">
        <h3 className="goal-detail-section-title">
          Workspaces ({workspaces.length})
        </h3>
        <button
          type="button"
          className="goal-action-button"
          onClick={() => { setShowAdd(true); setAddError(null); setAddPreview(null); setAddPath(""); }}
        >
          + Add
        </button>
      </div>

      {workspaces.length === 0 && !showAdd && (
        <p className="empty-state">No workspaces attached.</p>
      )}

      {removeError && <p className="form-error">{removeError}</p>}

      {workspaces.length > 0 && (
        <ul className="workspace-list">
          {workspaces.map((ws) => (
            <li key={ws.id} className="workspace-list-item">
              <div className="workspace-list-item-info">
                <span className="workspace-list-name">{ws.name}</span>
                <span className="workspace-list-path">{ws.path}</span>
                <div className="workspace-chips">
                  <span className="chip chip--type">{ws.workspaceType}</span>
                  {ws.branch && <span className="chip chip--branch">{ws.branch}</span>}
                  {ws.isDirty === true && (
                    <span className="chip chip--dirty" title="Uncommitted changes">dirty</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="goal-action-button goal-action-button--danger"
                onClick={() => handleRemove(ws)}
                disabled={removingId === ws.id}
              >
                {removingId === ws.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {showAdd && (
        <div className="workspace-add-inline">
          <div className="workspace-path-input-group">
            <input
              type="text"
              value={addPath}
              onChange={(e) => { setAddPath(e.target.value); setAddPreview(null); setAddError(null); }}
              placeholder="/absolute/path/to/workspace"
              className="workspace-path-input"
              disabled={addInspecting || addSubmitting}
              aria-label="New workspace path"
            />
            <button
              type="button"
              className="goal-action-button"
              onClick={() => void handleInspect()}
              disabled={!addPath.trim() || addInspecting || addSubmitting}
            >
              {addInspecting ? "Inspecting…" : "Inspect"}
            </button>
          </div>

          {addError && <p className="form-error">{addError}</p>}

          {addPreview && (
            <div className="workspace-add-preview">
              <div className="workspace-chips">
                <span className="chip chip--type">{addPreview.workspaceType}</span>
                {addPreview.branch && <span className="chip chip--branch">{addPreview.branch}</span>}
                {addPreview.isDirty === true && <span className="chip chip--dirty">dirty</span>}
              </div>
              <div className="form-field">
                <label htmlFor="add-ws-name">Name</label>
                <input
                  id="add-ws-name"
                  type="text"
                  value={addName}
                  maxLength={100}
                  onChange={(e) => setAddName(e.target.value)}
                  disabled={addSubmitting}
                />
              </div>
              <div className="workspace-add-preview-actions">
                <button
                  type="button"
                  className="submit-button"
                  onClick={() => void handleAttach()}
                  disabled={addSubmitting}
                >
                  {addSubmitting ? "Attaching…" : "Attach"}
                </button>
                <button
                  type="button"
                  className="goal-action-button"
                  onClick={() => { setShowAdd(false); setAddPreview(null); }}
                  disabled={addSubmitting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!addPreview && (
            <button
              type="button"
              className="goal-action-button"
              onClick={() => setShowAdd(false)}
              disabled={addInspecting}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </section>
  );
}
