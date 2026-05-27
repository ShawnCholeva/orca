import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentReadinessReport } from "@orca/contracts";
import { ReadinessRow } from "./ReadinessRow";

const CACHE_TTL_MS = 60_000;

interface ReadinessPanelProps {
  agents: Agent[];
  runAll: () => Promise<AgentReadinessReport[]>;
  runOne: (id: string) => Promise<AgentReadinessReport>;
  onOpenUrl: (url: string) => Promise<void>;
  onChange: (state: { readyCount: number; settled: boolean }) => void;
}

export function ReadinessPanel({ agents, runAll, runOne, onOpenUrl, onChange }: ReadinessPanelProps) {
  const connected = useMemo(() => agents.filter((a) => a.connected), [agents]);
  const lastEmitted = useRef<{ readyCount: number; settled: boolean } | null>(null);

  const cacheFresh = connected.every(
    (a) => a.readiness && Date.now() - new Date(a.readiness.checkedAt).getTime() < CACHE_TTL_MS,
  );

  const [reports, setReports] = useState<Record<string, AgentReadinessReport | null>>(() => {
    const init: Record<string, AgentReadinessReport | null> = {};
    for (const a of connected) init[a.id] = a.readiness ?? null;
    return init;
  });
  const [checking, setChecking] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const a of connected) init[a.id] = !cacheFresh;
    return init;
  });

  useEffect(() => {
    if (cacheFresh) return;
    let cancelled = false;
    runAll()
      .then((res) => {
        if (cancelled) return;
        const next: Record<string, AgentReadinessReport | null> = {};
        for (const r of res) next[r.agentId] = r;
        setReports((prev) => ({ ...prev, ...next }));
      })
      .finally(() => {
        if (!cancelled) {
          setChecking((prev) => {
            const next: Record<string, boolean> = {};
            for (const k of Object.keys(prev)) next[k] = false;
            return next;
          });
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settled = Object.values(checking).every((v) => !v);
  const readyCount = Object.values(reports).filter((r) => r?.status === "ready").length;

  useEffect(() => {
    const next = { readyCount, settled };
    const prev = lastEmitted.current;
    if (prev && prev.readyCount === next.readyCount && prev.settled === next.settled) return;
    lastEmitted.current = next;
    onChange(next);
  }, [readyCount, settled, onChange]);

  function handleRetry(id: string) {
    setChecking((prev) => ({ ...prev, [id]: true }));
    runOne(id)
      .then((report) => setReports((prev) => ({ ...prev, [id]: report })))
      .finally(() => setChecking((prev) => ({ ...prev, [id]: false })));
  }

  return (
    <div className="readiness-panel">
      {cacheFresh && connected.length > 0 && <div className="readiness-last-checked">Last checked: just now</div>}
      {connected.map((agent) => (
        <ReadinessRow
          key={agent.id}
          agent={{ ...agent, readiness: reports[agent.id] ?? null }}
          state={checking[agent.id] ? "checking" : "settled"}
          onRetry={handleRetry}
          onOpenUrl={onOpenUrl}
        />
      ))}
    </div>
  );
}
