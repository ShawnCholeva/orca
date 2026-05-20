import { useState } from "react";
import type { GoalMemoryItem, GoalMemoryType } from "@orca/contracts";
import { toErrorMessage } from "../../api";

const MEMORY_TYPES: GoalMemoryType[] = [
  "constraint",
  "success_criterion",
  "assumption",
  "blocker",
  "open_question",
  "validation_result",
  "architecture_note",
  "note",
];

export type MemorySaveData = {
  type: GoalMemoryType;
  content: string;
  status: "candidate" | "promoted";
};

type Props = {
  item: GoalMemoryItem | null;
  onSave: (data: MemorySaveData) => Promise<void>;
  onClose: () => void;
};

export function MemoryEditModal({ item, onSave, onClose }: Props) {
  const [type, setType] = useState<GoalMemoryType>(item?.type ?? "note");
  const [content, setContent] = useState(item?.content ?? "");
  const [status, setStatus] = useState<"candidate" | "promoted">(
    item?.status === "promoted" ? "promoted" : "candidate",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) {
      setError("Content is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ type, content: trimmed, status });
    } catch (err) {
      setError(toErrorMessage(err, "Save failed."));
      setSaving(false);
    }
  }

  return (
    <div className="memory-edit-modal" role="dialog" aria-modal="true">
      <div className="memory-edit-modal-content">
        <h4 className="memory-edit-modal-title">{item ? "Edit Memory" : "Add Memory"}</h4>
        <form onSubmit={(e) => void handleSubmit(e)} className="create-form">
          <label htmlFor="memory-type">Type</label>
          <select
            id="memory-type"
            value={type}
            onChange={(e) => setType(e.target.value as GoalMemoryType)}
            disabled={saving}
          >
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>

          <label htmlFor="memory-content">Content</label>
          <textarea
            id="memory-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={4000}
            rows={4}
            disabled={saving}
          />

          <label htmlFor="memory-status">Status</label>
          <select
            id="memory-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as "candidate" | "promoted")}
            disabled={saving}
          >
            <option value="candidate">Candidate</option>
            <option value="promoted">Promoted</option>
          </select>

          {error && <p className="form-error">{error}</p>}

          <div className="memory-edit-modal-actions">
            <button type="submit" className="goal-action-button" disabled={saving}>
              {saving ? "Saving…" : "Save"}
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
