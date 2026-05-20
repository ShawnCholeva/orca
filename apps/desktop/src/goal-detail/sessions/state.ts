import { useState, useEffect, useCallback } from "react";
import type { ContextAssembly, ContextPackage, SessionSummary } from "@orca/contracts";
import {
  listSessions,
  listContextPackages,
  stopSession,
  extractSessionMemory,
  openEventStream,
  toErrorMessage,
} from "../../api";

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

const CONTEXT_EVENTS = new Set([
  "context.assembly.requested",
  "context.assembly.completed",
  "context.assembly.failed",
  "context.package.created",
]);

export interface SessionsPanelState {
  sessions: SessionSummary[];
  packages: Map<string, ContextPackage>;
  assemblies: ContextAssembly[];
  hasDaemonRestartFailure: boolean;
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
  const [packages, setPackages] = useState<Map<string, ContextPackage>>(new Map());
  const [assemblies, setAssemblies] = useState<ContextAssembly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [extracting, setExtracting] = useState<Set<string>>(new Set());
  const [stopError, setStopError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      listSessions(goalId),
      listContextPackages(goalId),
    ])
      .then(([sessRes, pkgRes]) => {
        setSessions(sessRes.sessions);
        const pkgMap = new Map<string, ContextPackage>();
        for (const pkg of pkgRes.packages) {
          pkgMap.set(pkg.id, pkg);
        }
        setPackages(pkgMap);
        setAssemblies(pkgRes.assemblies);
      })
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
        if (
          SESSION_LIFECYCLE_EVENTS.has(event.type) ||
          EXTRACTION_EVENTS.has(event.type) ||
          CONTEXT_EVENTS.has(event.type)
        ) {
          refresh();
        }
      },
      onStatus() {},
    });
    return () => stream.close();
  }, [goalId, refresh]);

  const hasDaemonRestartFailure = assemblies.some(
    (a) => a.status === "failed" && a.failureCode === "daemon_restart"
  );

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
    packages,
    assemblies,
    hasDaemonRestartFailure,
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
