import { useCallback, useEffect, useState } from "react";
import type { Conflict } from "@orca/contracts";
import { listConflicts, resolveConflict, toErrorMessage } from "../../api";
import { ConflictResolveDialog } from "./ConflictResolveDialog";

type Props = {
  goalId: string;
  refreshKey?: number;
};

export function ConflictsBanner({ goalId, refreshKey = 0 }: Props) {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busyConflictId, setBusyConflictId] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<Conflict | null>(null);

  const openConflicts = conflicts.filter((conflict) => conflict.status === "open");

  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial"): Promise<Conflict[]> => {
      if (mode === "initial") {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        const body = await listConflicts(goalId, { status: "open", limit: 50 });
        setConflicts(body.conflicts);
        setError(null);
        return body.conflicts;
      } catch (err) {
        setError(toErrorMessage(err, "Failed to load conflicts."));
        throw err;
      } finally {
        if (mode === "initial") {
          setLoading(false);
        } else {
          setRefreshing(false);
        }
      }
    },
    [goalId],
  );

  useEffect(() => {
    void load("initial");
  }, [load, refreshKey]);

  async function reloadAfterMutation() {
    const nextConflicts = await load("refresh");
    const nextOpenCount = nextConflicts.filter((conflict) => conflict.status === "open").length;
    setDrawerOpen(nextOpenCount > 0);
  }

  async function handleDismiss(conflict: Conflict) {
    setBusyConflictId(conflict.id);
    setError(null);
    try {
      await resolveConflict(conflict.id, { resolution: "dismissed" });
      await reloadAfterMutation();
    } catch (err) {
      setError(toErrorMessage(err, "Dismiss failed."));
    } finally {
      setBusyConflictId(null);
    }
  }

  async function handleResolve(note?: string) {
    if (!resolveTarget) return;

    const conflictId = resolveTarget.id;
    setBusyConflictId(conflictId);
    setError(null);
    try {
      await resolveConflict(conflictId, {
        resolution: "resolved",
        note,
      });
      setResolveTarget(null);
      await reloadAfterMutation();
    } finally {
      setBusyConflictId(null);
    }
  }

  if (loading && conflicts.length === 0) {
    return null;
  }

  if (error && openConflicts.length === 0) {
    return (
      <div className="conflicts-banner-error">
        <p className="form-error">{error}</p>
        <button type="button" className="goal-action-button" onClick={() => void load("initial")}>
          Retry
        </button>
      </div>
    );
  }

  if (openConflicts.length === 0 && !drawerOpen) {
    return null;
  }

  return (
    <>
      {openConflicts.length > 0 && (
        <button
          type="button"
          className="conflicts-banner"
          onClick={() => setDrawerOpen(true)}
        >
          <span className="conflicts-banner-count">
            {openConflicts.length} {openConflicts.length === 1 ? "conflict needs" : "conflicts need"} review
          </span>
          <span className="conflicts-banner-action">Open</span>
        </button>
      )}

      {drawerOpen && (
        <div
          className="conflicts-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Conflicts"
        >
          <div className="conflicts-drawer-header">
            <div>
              <h3 className="conflicts-drawer-title">Open Conflicts</h3>
              <p className="conflicts-drawer-subtitle">
                Resolving or dismissing a conflict also dismisses its linked recommendation.
              </p>
            </div>
            <button
              type="button"
              className="goal-action-button"
              onClick={() => setDrawerOpen(false)}
            >
              Close
            </button>
          </div>

          {refreshing && (
            <p className="conflicts-drawer-status" role="status">
              Refreshing conflicts…
            </p>
          )}

          {error && (
            <p className="form-error conflicts-drawer-error" role="alert">
              {error}
            </p>
          )}

          <ul className="conflict-list">
            {openConflicts.map((conflict) => {
              const busy = busyConflictId === conflict.id;
              return (
                <li key={conflict.id} className={`conflict-row conflict-row--${conflict.severity}`}>
                  <div className="conflict-row-header">
                    <span className="conflict-row-type">{formatLabel(conflict.conflictType)}</span>
                    <span className={`conflict-row-severity conflict-row-severity--${conflict.severity}`}>
                      {formatLabel(conflict.severity)}
                    </span>
                  </div>

                  <p className="conflict-row-description">{conflict.description}</p>

                  <div className="conflict-row-meta">
                    <span className="conflict-row-source-count">
                      {conflict.sources.length} {conflict.sources.length === 1 ? "source" : "sources"}
                    </span>
                  </div>

                  <div className="conflict-row-actions">
                    <button
                      type="button"
                      className="goal-action-button"
                      onClick={() => setResolveTarget(conflict)}
                      disabled={busy}
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      className="goal-action-button"
                      onClick={() => void handleDismiss(conflict)}
                      disabled={busy}
                    >
                      {busy ? "Working..." : "Dismiss"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {resolveTarget && (
        <ConflictResolveDialog
          conflict={resolveTarget}
          onResolve={handleResolve}
          onClose={() => setResolveTarget(null)}
        />
      )}
    </>
  );
}

function formatLabel(value: string): string {
  return value.replace(/_/g, " ");
}
