import { useState, useEffect, useCallback } from "react";
import type { GoalDecision } from "@orca/contracts";
import { listGoalDecisions, createGoalDecision, patchDecision, toErrorMessage } from "../../api";
import { DecisionEditModal, type DecisionSaveData } from "./DecisionEditModal";

type Props = {
  goalId: string;
  refreshKey?: number;
};

type EditTarget = "new" | GoalDecision;

export function DecisionsPanel({ goalId, refreshKey = 0 }: Props) {
  const [items, setItems] = useState<GoalDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await listGoalDecisions(goalId);
      setItems(fetched);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to load decisions."));
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function handleSave(data: DecisionSaveData) {
    if (editTarget === "new") {
      await createGoalDecision(goalId, {
        title: data.title,
        decisionText: data.decisionText,
        rationale: data.rationale || undefined,
        status: data.status,
        confirmationRequired: data.confirmationRequired,
      });
    } else if (editTarget) {
      await patchDecision(editTarget.id, {
        title: data.title,
        decisionText: data.decisionText,
        rationale: data.rationale || undefined,
        status: data.status,
      });
    }
    setEditTarget(null);
    await load();
  }

  async function handleStatusPatch(item: GoalDecision, status: "confirmed" | "archived") {
    setActionError(null);
    try {
      await patchDecision(item.id, { status });
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Action failed."));
    }
  }

  const needsConfirmation = items.filter(
    (i) => i.status === "proposed" && i.confirmationRequired,
  );
  const proposed = items.filter(
    (i) => i.status === "proposed" && !i.confirmationRequired,
  );
  const confirmed = items.filter((i) => i.status === "confirmed");
  const archived = items.filter((i) => i.status === "archived");

  const activeCount = needsConfirmation.length + proposed.length + confirmed.length;

  return (
    <section className="goal-detail-section decisions-panel" aria-label="Decisions">
      <div className="goal-detail-section-header">
        <h3 className="goal-detail-section-title">
          Decisions {activeCount > 0 ? `(${activeCount})` : ""}
        </h3>
        <button
          type="button"
          className="goal-action-button"
          onClick={() => setEditTarget("new")}
        >
          + Add Decision
        </button>
      </div>

      {actionError && (
        <p className="form-error decisions-action-error" role="alert">
          {actionError}
        </p>
      )}

      {loading && items.length === 0 && (
        <div className="decisions-panel-loading" aria-label="Loading decisions">
          <p>Loading…</p>
        </div>
      )}

      {!loading && error && (
        <div className="decisions-panel-error">
          <p className="form-error">{error}</p>
          <button type="button" className="goal-action-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && activeCount === 0 && !showArchived && (
        <p className="empty-state">No decisions yet.</p>
      )}

      {needsConfirmation.length > 0 && (
        <div className="decisions-group decisions-group--needs-confirmation">
          <h4 className="decisions-group-label">Needs Confirmation</h4>
          <ul className="decision-item-list">
            {needsConfirmation.map((item) => (
              <DecisionRow
                key={item.id}
                item={item}
                onEdit={() => setEditTarget(item)}
                onConfirm={() => void handleStatusPatch(item, "confirmed")}
                onArchive={() => void handleStatusPatch(item, "archived")}
              />
            ))}
          </ul>
        </div>
      )}

      {proposed.length > 0 && (
        <div className="decisions-group decisions-group--proposed">
          <h4 className="decisions-group-label">Proposed</h4>
          <ul className="decision-item-list">
            {proposed.map((item) => (
              <DecisionRow
                key={item.id}
                item={item}
                onEdit={() => setEditTarget(item)}
                onConfirm={() => void handleStatusPatch(item, "confirmed")}
                onArchive={() => void handleStatusPatch(item, "archived")}
              />
            ))}
          </ul>
        </div>
      )}

      {confirmed.length > 0 && (
        <div className="decisions-group decisions-group--confirmed">
          <h4 className="decisions-group-label">Confirmed</h4>
          <ul className="decision-item-list">
            {confirmed.map((item) => (
              <DecisionRow
                key={item.id}
                item={item}
                onEdit={() => setEditTarget(item)}
                onConfirm={undefined}
                onArchive={() => void handleStatusPatch(item, "archived")}
              />
            ))}
          </ul>
        </div>
      )}

      {showArchived && archived.length > 0 && (
        <div className="decisions-group decisions-group--archived">
          <h4 className="decisions-group-label">Archived</h4>
          <ul className="decision-item-list">
            {archived.map((item) => (
              <DecisionRow
                key={item.id}
                item={item}
                onEdit={() => setEditTarget(item)}
                onConfirm={undefined}
                onArchive={undefined}
              />
            ))}
          </ul>
        </div>
      )}

      {archived.length > 0 && (
        <button
          type="button"
          className="decisions-show-archived-toggle"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
        </button>
      )}

      {editTarget !== null && (
        <DecisionEditModal
          item={editTarget === "new" ? null : editTarget}
          onSave={handleSave}
          onClose={() => setEditTarget(null)}
        />
      )}
    </section>
  );
}

type RowProps = {
  item: GoalDecision;
  onEdit: () => void;
  onConfirm: (() => void) | undefined;
  onArchive: (() => void) | undefined;
};

function DecisionRow({ item, onEdit, onConfirm, onArchive }: RowProps) {
  const [rationaleOpen, setRationaleOpen] = useState(false);

  return (
    <li className={`decision-item decision-item--${item.status}`} data-id={item.id}>
      <div className="decision-item-meta">
        <span className={`decision-item-status-chip decision-item-status--${item.status}`}>
          {item.status}
        </span>
        {item.confirmationRequired && (
          <span className="decision-item-confirmation-required-badge">confirmation required</span>
        )}
        {item.confidence !== null && (
          <span className="decision-item-confidence">
            {Math.round(item.confidence * 100)}%
          </span>
        )}
        <span className="decision-item-source">{formatSource(item)}</span>
      </div>
      <p className="decision-item-title">{item.title}</p>
      <p className="decision-item-text">{item.decisionText}</p>
      {item.rationale && (
        <div className="decision-item-rationale-wrapper">
          <button
            type="button"
            className="decision-item-rationale-toggle"
            onClick={() => setRationaleOpen((v) => !v)}
          >
            {rationaleOpen ? "Hide rationale" : "Show rationale"}
          </button>
          {rationaleOpen && (
            <p className="decision-item-rationale">{item.rationale}</p>
          )}
        </div>
      )}
      <div className="decision-item-actions">
        <button
          type="button"
          className="goal-action-button decision-item-edit"
          onClick={onEdit}
        >
          Edit
        </button>
        {onConfirm && (
          <button
            type="button"
            className="goal-action-button decision-item-confirm"
            onClick={onConfirm}
          >
            Confirm
          </button>
        )}
        {onArchive && (
          <button
            type="button"
            className="goal-action-button decision-item-archive"
            onClick={onArchive}
          >
            Archive
          </button>
        )}
      </div>
    </li>
  );
}

function formatSource(item: GoalDecision): string {
  if (item.sourceType === "manual") return "manual";
  if (item.sourceType === "session") {
    if (
      item.sourceSessionId &&
      item.sourceOffsetFirst !== null &&
      item.sourceOffsetLast !== null
    ) {
      const sid = item.sourceSessionId.slice(0, 8);
      return `from session ${sid} bytes [${item.sourceOffsetFirst}..${item.sourceOffsetLast}]`;
    }
    return "source output unavailable";
  }
  return "";
}
