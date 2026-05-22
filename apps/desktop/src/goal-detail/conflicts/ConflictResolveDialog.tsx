import { useState } from "react";
import {
  M7_CONFLICT_MAX_RESOLUTION_NOTE_CHARS,
  type Conflict,
} from "@orca/contracts";
import { toErrorMessage } from "../../api";

type Props = {
  conflict: Conflict;
  onResolve: (note?: string) => Promise<void>;
  onClose: () => void;
  initialNote?: string;
};

export function ConflictResolveDialog({ conflict, onResolve, onClose, initialNote }: Props) {
  const [note, setNote] = useState(initialNote ?? conflict.resolutionNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (note.length > M7_CONFLICT_MAX_RESOLUTION_NOTE_CHARS) {
      setError(
        `Resolution note must be ${M7_CONFLICT_MAX_RESOLUTION_NOTE_CHARS} characters or fewer.`,
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onResolve(note.trim() || undefined);
    } catch (err) {
      setError(toErrorMessage(err, "Resolve failed."));
      setSaving(false);
    }
  }

  return (
    <div
      className="conflict-resolve-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Resolve Conflict"
    >
      <div className="task-dialog-content">
        <h4 className="task-dialog-title">Resolve Conflict</h4>
        <p className="conflict-resolve-summary">
          {formatLabel(conflict.conflictType)} · {formatLabel(conflict.severity)}
        </p>
        <p className="conflict-resolve-description">{conflict.description}</p>

        <form className="create-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor={`conflict-note-${conflict.id}`}>Resolution note (optional)</label>
          <textarea
            id={`conflict-note-${conflict.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={5}
            maxLength={M7_CONFLICT_MAX_RESOLUTION_NOTE_CHARS}
            disabled={saving}
          />

          <p className="conflict-resolve-hint">
            Resolving this conflict will also dismiss its linked recommendation.
          </p>

          {error && <p className="form-error task-dialog-error">{error}</p>}

          <div className="task-dialog-actions">
            <button type="submit" className="goal-action-button" disabled={saving}>
              {saving ? "Resolving..." : "Resolve"}
            </button>
            <button
              type="button"
              className="goal-action-button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatLabel(value: string): string {
  return value.replace(/_/g, " ");
}
