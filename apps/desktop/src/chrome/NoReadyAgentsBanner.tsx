import { useState } from "react";
import type { Agent } from "@orca/contracts";

interface NoReadyAgentsBannerProps {
  agents: Agent[];
  onDismiss?: () => void;
}

export function NoReadyAgentsBanner({ agents, onDismiss }: NoReadyAgentsBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const connected = agents.filter((a) => a.connected);
  const anyReady = connected.some((a) => a.readiness?.status === "ready");
  if (anyReady || connected.length === 0 || dismissed) return null;

  return (
    <div role="status" className="banner banner--warn">
      <span>No agents are ready. Open Settings → Agents to fix.</span>
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
          onDismiss?.();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
