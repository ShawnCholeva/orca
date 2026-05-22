import type { Agent, AgentReadinessReport } from "@orca/contracts";
import { RepairBlock } from "./RepairBlock";

export type RowState = "checking" | "settled";

interface ReadinessRowProps {
  agent: Agent;
  state: RowState;
  onRetry: (id: string) => void;
  onOpenUrl: (url: string) => void;
}

export function ReadinessRow({ agent, state, onRetry, onOpenUrl }: ReadinessRowProps) {
  const r = agent.readiness;
  const status = state === "checking" ? "checking" : r?.status ?? "unchecked";
  const requiresRestart = r?.repair?.requiresAppRestart === true;

  return (
    <div className="readiness-row" role="status" aria-live="polite" data-status={status}>
      <div className="readiness-row-head">
        <span className="readiness-row-name">{agent.name}</span>
        <span className="readiness-row-status">{labelFor(status)}</span>
        {r?.version && <span className="readiness-row-version">{r.version}</span>}
      </div>
      {state === "settled" && r?.steps?.map((s, i) => (
        <div key={i} className="readiness-row-step">
          {s.ok ? "✓" : "✗"} {s.detail ?? s.name}
        </div>
      ))}
      {state === "settled" && r?.repair && (
        <RepairBlock repair={r.repair} onOpenUrl={onOpenUrl} />
      )}
      {state === "settled" && status !== "ready" && (
        <button
          type="button"
          onClick={() => onRetry(agent.id)}
          disabled={requiresRestart}
          title={requiresRestart ? "Restart Orca first" : undefined}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function labelFor(status: string): string {
  switch (status) {
    case "checking": return "Checking…";
    case "ready": return "Ready";
    case "missing": return "Not installed";
    case "needs_auth": return "Not signed in";
    case "misconfigured": return "Misconfigured";
    case "failed": return "Check failed";
    default: return "Unchecked";
  }
}
