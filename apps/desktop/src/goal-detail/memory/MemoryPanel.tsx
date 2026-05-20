import { useState, useEffect, useCallback } from "react";
import type { GoalMemoryItem } from "@orca/contracts";
import { listGoalMemory, createGoalMemory, patchMemoryItem, toErrorMessage } from "../../api";
import { MemoryEditModal, type MemorySaveData } from "./MemoryEditModal";

type Props = {
  goalId: string;
};

type EditTarget = "new" | GoalMemoryItem;

export function MemoryPanel({ goalId }: Props) {
  const [items, setItems] = useState<GoalMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await listGoalMemory(goalId, { includeArchived: true });
      setItems(fetched);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to load memory."));
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(data: MemorySaveData) {
    if (editTarget === "new") {
      await createGoalMemory(goalId, data);
    } else if (editTarget) {
      await patchMemoryItem(editTarget.id, {
        type: data.type,
        content: data.content,
        status: data.status,
      });
    }
    setEditTarget(null);
    await load();
  }

  async function handleStatusPatch(item: GoalMemoryItem, status: "promoted" | "archived") {
    setActionError(null);
    try {
      await patchMemoryItem(item.id, { status });
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Action failed."));
    }
  }

  const promoted = items.filter((i) => i.status === "promoted");
  const candidates = items.filter((i) => i.status === "candidate");
  const archived = items.filter((i) => i.status === "archived");
  const visibleItems = [...promoted, ...candidates, ...(showArchived ? archived : [])];
  const activeCount = promoted.length + candidates.length;

  return (
    <section className="goal-detail-section memory-panel" aria-label="Memory">
      <div className="goal-detail-section-header">
        <h3 className="goal-detail-section-title">
          Memory {activeCount > 0 ? `(${activeCount})` : ""}
        </h3>
        <button
          type="button"
          className="goal-action-button"
          onClick={() => setEditTarget("new")}
        >
          + Add Memory
        </button>
      </div>

      {actionError && (
        <p className="form-error memory-action-error" role="alert">
          {actionError}
        </p>
      )}

      {loading && items.length === 0 && (
        <div className="memory-panel-loading" aria-label="Loading memory">
          <p>Loading…</p>
        </div>
      )}

      {!loading && error && (
        <div className="memory-panel-error">
          <p className="form-error">{error}</p>
          <button type="button" className="goal-action-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && visibleItems.length === 0 && (
        <p className="empty-state">No memory items yet.</p>
      )}

      {visibleItems.length > 0 && (
        <ul className="memory-item-list">
          {visibleItems.map((item) => (
            <MemoryItemRow
              key={item.id}
              item={item}
              onEdit={() => setEditTarget(item)}
              onPromote={() => void handleStatusPatch(item, "promoted")}
              onArchive={() => void handleStatusPatch(item, "archived")}
            />
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <button
          type="button"
          className="memory-show-archived-toggle"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Hide archived" : `Show archived (${archived.length})`}
        </button>
      )}

      {editTarget !== null && (
        <MemoryEditModal
          item={editTarget === "new" ? null : editTarget}
          onSave={handleSave}
          onClose={() => setEditTarget(null)}
        />
      )}
    </section>
  );
}

type RowProps = {
  item: GoalMemoryItem;
  onEdit: () => void;
  onPromote: () => void;
  onArchive: () => void;
};

function MemoryItemRow({ item, onEdit, onPromote, onArchive }: RowProps) {
  return (
    <li className={`memory-item memory-item--${item.status}`} data-id={item.id}>
      <div className="memory-item-meta">
        <span className="memory-item-type-chip">{item.type.replace(/_/g, " ")}</span>
        <span className={`memory-item-status-chip memory-item-status--${item.status}`}>
          {item.status}
        </span>
        {item.confidence !== null && (
          <span className="memory-item-confidence">
            {Math.round(item.confidence * 100)}%
          </span>
        )}
        <span className="memory-item-source">{formatSource(item)}</span>
      </div>
      <p className="memory-item-content">{item.content}</p>
      <div className="memory-item-actions">
        <button
          type="button"
          className="goal-action-button memory-item-edit"
          onClick={onEdit}
        >
          Edit
        </button>
        {item.status === "candidate" && (
          <button
            type="button"
            className="goal-action-button memory-item-promote"
            onClick={onPromote}
          >
            Promote
          </button>
        )}
        {item.status !== "archived" && (
          <button
            type="button"
            className="goal-action-button memory-item-archive"
            onClick={onArchive}
          >
            Archive
          </button>
        )}
      </div>
    </li>
  );
}

function formatSource(item: GoalMemoryItem): string {
  if (item.sourceType === "refinement") return "from refinement";
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
