import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { GoalDocument } from "@orca/contracts";
import { attachGoalDocument, detachGoalDocument } from "../api";
import type { ApiError } from "../api";
import { expandTilde } from "../utils/path";
import { detectDocumentKind, defaultDocumentName } from "../create-goal-flow/documents";

type Props = {
  goalId: string;
  documents: GoalDocument[];
  onChanged: () => void;
};

export function DocumentListPanel({ goalId, documents, onChanged }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [addRef, setAddRef] = useState("");
  const [addName, setAddName] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function handleAttach() {
    const trimmed = addRef.trim();
    if (!trimmed) return;
    setAddSubmitting(true);
    setAddError(null);
    try {
      const kind = detectDocumentKind(trimmed);
      const ref = kind === "file" ? await expandTilde(trimmed) : trimmed;
      await attachGoalDocument(goalId, {
        kind,
        ref,
        name: addName.trim() || defaultDocumentName(kind, ref),
      });
      setShowAdd(false);
      setAddRef("");
      setAddName("");
      onChanged();
    } catch (err) {
      setAddError((err as ApiError).message ?? "Attach failed");
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleBrowse() {
    const selected = await openDialog({ directory: false, multiple: false });
    if (!selected) return;
    setAddRef(selected as string);
    setAddError(null);
  }

  async function handleRemove(doc: GoalDocument) {
    if (!confirm(`Remove document "${doc.name}"?`)) return;
    setRemovingId(doc.id);
    setRemoveError(null);
    try {
      await detachGoalDocument(goalId, doc.id);
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
          Documents ({documents.length})
        </h3>
        <button
          type="button"
          className="goal-action-button"
          onClick={() => { setShowAdd(true); setAddError(null); setAddRef(""); setAddName(""); }}
        >
          + Add
        </button>
      </div>

      {documents.length === 0 && !showAdd && (
        <p className="empty-state">No reference documents attached.</p>
      )}

      {removeError && <p className="form-error">{removeError}</p>}

      {documents.length > 0 && (
        <ul className="workspace-list">
          {documents.map((doc) => (
            <li key={doc.id} className="workspace-list-item">
              <div className="workspace-list-item-info">
                <span className="workspace-list-name">{doc.name}</span>
                <span className="workspace-list-path">{doc.ref}</span>
                <div className="workspace-chips">
                  <span className="chip chip--type">{doc.kind}</span>
                  <span className="chip chip--branch">
                    fetched {new Date(doc.fetchedAt).toLocaleString()}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="goal-action-button goal-action-button--danger"
                onClick={() => handleRemove(doc)}
                disabled={removingId === doc.id}
              >
                {removingId === doc.id ? "Removing…" : "Remove"}
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
              value={addRef}
              onChange={(e) => { setAddRef(e.target.value); setAddError(null); }}
              placeholder="/path/to/plan.md or https://…"
              className="workspace-path-input"
              disabled={addSubmitting}
              aria-label="New document path or URL"
            />
            <input
              type="text"
              value={addName}
              maxLength={100}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="Name (optional)"
              className="workspace-path-input"
              disabled={addSubmitting}
              aria-label="New document name"
              style={{ maxWidth: 180 }}
            />
            <button
              type="button"
              className="goal-action-button"
              onClick={() => void handleBrowse()}
              disabled={addSubmitting}
            >
              Browse…
            </button>
            <button
              type="button"
              className="goal-action-button"
              onClick={() => void handleAttach()}
              disabled={!addRef.trim() || addSubmitting}
            >
              {addSubmitting ? "Attaching…" : "Attach"}
            </button>
            <button
              type="button"
              className="goal-action-button"
              onClick={() => setShowAdd(false)}
              disabled={addSubmitting}
            >
              Cancel
            </button>
          </div>
          {addError && <p className="form-error">{addError}</p>}
        </div>
      )}
    </section>
  );
}
