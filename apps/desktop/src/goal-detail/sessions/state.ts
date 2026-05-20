import { useState, useEffect, useCallback } from "react";
import type { SessionSummary } from "@orca/contracts";
import { listSessions, stopSession, extractSessionMemory, openEventStream, toErrorMessage } from "../../api";

const SESSION_LIFECYCLE_EVENTS = new Set([
  "session.created",
  "session.started",
  "session.exited",
  "session.failed",
  "session.stopped",
]);

const EXTRACTION_EVENTS = new Set([
  "memory.extraction.requested",
  "memory.extraction.started",
  "memory.extraction.completed",
  "memory.extraction.failed",
]);

export interface SessionsPanelState {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  selectedSessionId: string | null;
  stopping: Set<string>;
  extracting: Set<string>;
  stopError: string | null;
  selectSession(id: string | null): void;
  handleStop(sessionId: string): Promise<void>;
  handleExtract(sessionId: string): Promise<void>;
}

export function useSessionsPanel(goalId: string, sessionsRefreshKey = 0): SessionsPanelState {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [extracting, setExtracting] = useState<Set<string>>(new Set());
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
  }, [refresh, sessionsRefreshKey]);

  useEffect(() => {
    const stream = openEventStream({
      onEvent(event) {
        if (event.goalId === null || event.goalId !== goalId) return;
        if (SESSION_LIFECYCLE_EVENTS.has(event.type) || EXTRACTION_EVENTS.has(event.type)) {
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

  async function handleExtract(sessionId: string) {
    setExtracting((prev) => new Set(prev).add(sessionId));
    try {
      await extractSessionMemory(sessionId);
    } catch {
      // extraction errors surface via latestExtraction.status on next event-driven refresh
    } finally {
      setExtracting((prev) => {
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
    extracting,
    stopError,
    selectSession: setSelectedSessionId,
    handleStop,
    handleExtract,
  };
}
