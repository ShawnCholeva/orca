import { useState, useEffect, useCallback } from "react";
import type { SessionSummary } from "@orca/contracts";
import { listSessions, stopSession, openEventStream, toErrorMessage } from "../../api";

const SESSION_LIFECYCLE_EVENTS = new Set([
  "session.created",
  "session.started",
  "session.exited",
  "session.failed",
  "session.stopped",
]);

export interface SessionsPanelState {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  stopping: Set<string>;
  stopError: string | null;
  selectSession(id: string | null): void;
  handleStop(sessionId: string): Promise<void>;
}

export function useSessionsPanel(goalId: string): SessionsPanelState {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    listSessions(goalId)
      .then((res) => setSessions(res.sessions))
      .catch((err) => setError(toErrorMessage(err, "Failed to load sessions.")))
      .finally(() => setLoading(false));
  }, [goalId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh the session list when session lifecycle events arrive for this goal.
  useEffect(() => {
    const stream = openEventStream({
      onEvent(event) {
        if (
          SESSION_LIFECYCLE_EVENTS.has(event.type) &&
          event.goalId !== null &&
          event.goalId === goalId
        ) {
          refresh();
        }
      },
      onStatus() {},
    });
    return () => stream.close();
  }, [goalId, refresh]);

  async function handleStop(sessionId: string) {
    setStopping((prev) => new Set(prev).add(sessionId));
    setStopError(null);
    try {
      await stopSession(sessionId);
    } catch (err) {
      setStopError(toErrorMessage(err, "Failed to stop session."));
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }

  return {
    sessions,
    loading,
    error,
    selectedSessionId,
    stopping,
    stopError,
    selectSession: setSelectedSessionId,
    handleStop,
  };
}
