import { useState, useMemo } from "react";
import type { Workspace } from "@orca/contracts";
import { useSessionsPanel } from "./state";
import { SessionListItem } from "./SessionListItem";
import { CreateSessionDialog } from "./CreateSessionDialog";
import { SessionTerminalView } from "./SessionTerminalView";

type Props = {
  goalId: string;
  workspaces: Workspace[];
};

export function SessionsPanel({ goalId, workspaces }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const {
    sessions,
    loading,
    error,
    selectedSessionId,
    stopping,
    stopError,
    selectSession,
    handleStop,
  } = useSessionsPanel(goalId);

  const workspaceById = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  function handleCreated(sessionId: string) {
    setShowCreate(false);
    selectSession(sessionId);
  }

  return (
    <section className="goal-detail-section sessions-panel" aria-label="Sessions">
      <div className="goal-detail-section-header">
        <h3 className="goal-detail-section-title">
          Sessions {sessions.length > 0 ? `(${sessions.length})` : ""}
        </h3>
        <button
          type="button"
          className="goal-action-button"
          onClick={() => setShowCreate(true)}
          disabled={showCreate || workspaces.length === 0}
          title={workspaces.length === 0 ? "Attach a workspace first" : undefined}
        >
          + New Session
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {stopError && <p className="form-error">{stopError}</p>}

      {showCreate && (
        <CreateSessionDialog
          goalId={goalId}
          workspaces={workspaces}
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      )}

      {!loading && sessions.length === 0 && !showCreate && (
        <p className="empty-state">No sessions yet.</p>
      )}

      {sessions.length > 0 && (
        <ul className="session-list">
          {sessions.map((session) => (
            <SessionListItem
              key={session.id}
              session={session}
              workspaceName={workspaceById.get(session.workspaceId)?.name ?? session.workspaceId}
              selected={selectedSessionId === session.id}
              stopping={stopping.has(session.id)}
              onSelect={() => selectSession(session.id)}
              onStop={() => void handleStop(session.id)}
            />
          ))}
        </ul>
      )}

      {selectedSession && (
        <SessionTerminalView
          key={selectedSession.id}
          sessionId={selectedSession.id}
          status={selectedSession.status}
        />
      )}
    </section>
  );
}
