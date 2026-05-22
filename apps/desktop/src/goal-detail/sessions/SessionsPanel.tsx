import { useEffect, useState, useMemo } from "react";
import type { Workspace } from "@orca/contracts";
import { useSessionsPanel } from "./state";
import { SessionListItem } from "./SessionListItem";
import { SessionSummaryPanel } from "./SessionSummaryPanel";
import { SessionContextPanel } from "./SessionContextPanel";
import { CreateSessionDialog } from "./CreateSessionDialog";
import { SessionTerminalView } from "./SessionTerminalView";
import type { CreateSessionPrefill } from "../recommendations/RecommendationsPanel";

const TERMINAL_SESSION_STATUSES = new Set(["exited", "failed", "stopped"]);

type Props = {
  goalId: string;
  workspaces: Workspace[];
  sessionsRefreshKey?: number;
  summaryRefreshKey?: number;
  createSessionPrefill?: CreateSessionPrefill | null;
  onCreateSessionPrefillConsumed?: () => void;
};

export function SessionsPanel({
  goalId,
  workspaces,
  sessionsRefreshKey = 0,
  summaryRefreshKey = 0,
  createSessionPrefill = null,
  onCreateSessionPrefillConsumed,
}: Props) {
  const [showCreate, setShowCreate] = useState(createSessionPrefill !== null);
  const [contextPreviewForSession, setContextPreviewForSession] = useState<string | null>(null);

  const {
    sessions,
    packages,
    assemblies,
    hasDaemonRestartFailure,
    loading,
    error,
    selectedSessionId,
    stopping,
    extracting,
    stopError,
    selectSession,
    handleStop,
    handleExtract,
  } = useSessionsPanel(goalId, sessionsRefreshKey);

  const workspaceById = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  const contextPreviewOpen = contextPreviewForSession !== null && contextPreviewForSession === selectedSessionId;

  function handleRowClick(sessionId: string) {
    selectSession(sessionId);
    setContextPreviewForSession(null);
  }

  function handleBadgeClick(sessionId: string) {
    selectSession(sessionId);
    setContextPreviewForSession(sessionId);
  }

  function handleContextPreviewToggle() {
    if (contextPreviewOpen) {
      setContextPreviewForSession(null);
    } else if (selectedSessionId) {
      setContextPreviewForSession(selectedSessionId);
    }
  }

  function handleCreated(sessionId: string) {
    setShowCreate(false);
    onCreateSessionPrefillConsumed?.();
    selectSession(sessionId);
  }

  function handleCloseCreate() {
    setShowCreate(false);
    onCreateSessionPrefillConsumed?.();
  }

  useEffect(() => {
    if (createSessionPrefill !== null) {
      setShowCreate(true);
    }
  }, [createSessionPrefill]);

  const selectedPkg = selectedSession?.contextPackageId
    ? (packages.get(selectedSession.contextPackageId) ?? null)
    : null;
  const selectedAssembly = selectedPkg
    ? (assemblies.find((a) => a.packageId === selectedPkg.id) ?? null)
    : null;

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

      {hasDaemonRestartFailure && (
        <div className="context-restart-banner" role="alert">
          A context assembly was interrupted by a daemon restart.
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      {stopError && <p className="form-error">{stopError}</p>}

      {showCreate && (
        <CreateSessionDialog
          key={createSessionPrefill?.fromRecommendationId ?? "manual"}
          goalId={goalId}
          workspaces={workspaces}
          onCreated={handleCreated}
          onClose={handleCloseCreate}
          prefill={createSessionPrefill}
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
              extracting={extracting.has(session.id)}
              pkg={session.contextPackageId ? packages.get(session.contextPackageId) : undefined}
              onSelect={() => handleRowClick(session.id)}
              onStop={() => void handleStop(session.id)}
              onExtract={() => void handleExtract(session.id)}
              onOpenContextPreview={() => handleBadgeClick(session.id)}
            />
          ))}
        </ul>
      )}

      {selectedSession && (
        <>
          <SessionTerminalView
            key={selectedSession.id}
            sessionId={selectedSession.id}
            status={selectedSession.status}
          />
          {TERMINAL_SESSION_STATUSES.has(selectedSession.status) && (
            <SessionSummaryPanel key={`summary-${selectedSession.id}`} sessionId={selectedSession.id} refreshKey={summaryRefreshKey} />
          )}
          {selectedSession.contextPackageId && (
            <SessionContextPanel
              key={`ctx-${selectedSession.id}`}
              goalId={goalId}
              pkg={selectedPkg}
              assembly={selectedAssembly}
              open={contextPreviewOpen}
              onToggle={handleContextPreviewToggle}
            />
          )}
        </>
      )}
    </section>
  );
}
