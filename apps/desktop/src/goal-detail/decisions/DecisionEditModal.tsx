import { useState } from "react";
import type { GoalDecision } from "@orca/contracts";
import { toErrorMessage } from "../../api";

export type DecisionSaveData = {
  title: string;
  decisionText: string;
  rationale: string;
  status: "proposed" | "confirmed";
  confirmationRequired: boolean;
};

type Props = {
  item: GoalDecision | null;
  onSave: (data: DecisionSaveData) => Promise<void>;
  onClose: () => void;
};

export function DecisionEditModal({ item, onSave, onClose }: Props) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [decisionText, setDecisionText] = useState(item?.decisionText ?? "");
  const [rationale, setRationale] = useState(item?.rationale ?? "");
  const [status, setStatus] = useState<"proposed" | "confirmed">(
    item?.status === "confirmed" ? "confirmed" : "proposed",
  );
  const [confirmationRequired, setConfirmationRequired] = useState(
    item?.confirmationRequired ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedText = decisionText.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }
    if (!trimmedText) {
      setError("Decision text is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: trimmedTitle,
        decisionText: trimmedText,
        rationale: rationale.trim(),
        status,
        confirmationRequired,
      });
    } catch (err) {
      setError(toErrorMessage(err, "Save failed."));
      setSaving(false);
    }
  }

  return (
    <div className="decision-edit-modal" role="dialog" aria-modal="true">
      <div className="decision-edit-modal-content">
        <h4 className="decision-edit-modal-title">{item ? "Edit Decision" : "Add Decision"}</h4>
        <form onSubmit={(e) => void handleSubmit(e)} className="create-form">
          <label htmlFor="decision-title">Title</label>
          <input
            id="decision-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            disabled={saving}
          />

          <label htmlFor="decision-text">Decision</label>
          <textarea
            id="decision-text"
            value={decisionText}
            onChange={(e) => setDecisionText(e.target.value)}
            maxLength={4000}
            rows={4}
            disabled={saving}
          />

          <label htmlFor="decision-rationale">Rationale</label>
          <textarea
            id="decision-rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            maxLength={4000}
            rows={2}
            disabled={saving}
          />

          <label htmlFor="decision-status">Status</label>
          <select
            id="decision-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as "proposed" | "confirmed")}
            disabled={saving}
          >
            <option value="proposed">Proposed</option>
            <option value="confirmed">Confirmed</option>
          </select>

          <label className="decision-confirmation-required-label">
            <input
              type="checkbox"
              checked={confirmationRequired}
              onChange={(e) => setConfirmationRequired(e.target.checked)}
              disabled={saving}
            />
            {" "}Requires confirmation
          </label>

          {error && <p className="form-error">{error}</p>}

          <div className="decision-edit-modal-actions">
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
