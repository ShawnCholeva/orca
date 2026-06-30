import { useEffect, useState } from "react";
import type { WorkspaceSummary } from "@orca/contracts";
import { listWorkspaces, toErrorMessage } from "../../api";

type Props = {
  /** Paths already attached to the goal — shown as "Added", not pickable. */
  existingPaths: string[];
  onPick: (ws: WorkspaceSummary) => void;
  onClose: () => void;
  /** When provided, the empty state offers a jump to the Workspaces tab. */
  onNavigateToWorkspaces?: () => void;
};

/**
 * Pick a goal workspace from the already-registered workspaces (the registry),
 * instead of browsing the filesystem. The chosen workspace is hydrated through
 * the same inspect → inspectSucceeded path the Browse flow uses, so the rest of
 * goal creation is unchanged.
 */
export function WorkspacePickerModal({ existingPaths, onPick, onClose, onNavigateToWorkspaces }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listWorkspaces()
      .then((rows) => { if (!cancelled) { setWorkspaces(rows); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(toErrorMessage(err, "Failed to load workspaces.")); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const existing = new Set(existingPaths);

  return (
    <div className="flow-overlay" role="dialog" aria-modal="true" aria-label="Pick a registered workspace">
      <div className="flow-modal workspace-picker-modal">
        <div className="flow-header">
          <div className="flow-header-text">
            <div className="flow-header-kicker">Registered workspaces</div>
            <h2 className="flow-header-title">Pick a workspace</h2>
          </div>
          <button type="button" className="flow-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="flow-body">
          {loading && <p className="form-hint">Loading workspaces…</p>}
          {error && <p className="form-error">{error}</p>}

          {!loading && !error && workspaces.length === 0 && (
            <div className="form-field">
              <p className="form-hint">No registered workspaces yet.</p>
              {onNavigateToWorkspaces && (
                <button
                  type="button"
                  className="goal-action-button"
                  onClick={onNavigateToWorkspaces}
                >
                  Go to Workspaces
                </button>
              )}
            </div>
          )}

          {!loading && !error && workspaces.length > 0 && (
            <ul className="workspace-pending-list">
              {workspaces.map((ws) => {
                const added = existing.has(ws.path);
                return (
                  <li key={ws.id} className="workspace-row">
                    <button
                      type="button"
                      className="workspace-picker-option"
                      disabled={added}
                      onClick={() => { if (!added) onPick(ws); }}
                    >
                      <span className="workspace-name-input">{ws.name}</span>
                      <span className="workspace-path-text">{ws.path}</span>
                    </button>
                    {added && <span className="chip chip--type">Added</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
