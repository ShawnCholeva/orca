import type { SessionSummary, SessionStatus } from "@orca/contracts";

import { SessionTerminalView } from "../../goal-detail/sessions/SessionTerminalView";

// The live session behind one workflow node, shown in place of the orchestrator
// chat so the reader can talk to that step's agent directly and then step back
// out. The terminal is the agent's real tty — the same one the orchestrator is
// driving — so this is a seat beside the Conductor, not a copy of the transcript.

type Props = {
  session: SessionSummary;
  stepName: string;
  onBack: () => void;
};

const LIVE_STATUSES = new Set<SessionStatus>(["created", "starting", "running"]);

/**
 * The grid a worker's tmux pane was created at, when the daemon owns it. Read
 * straight off the session the tracker already has, so the terminal is built at
 * the right size on its first frame rather than corrected after a fetch.
 */
function paneOf(session: SessionSummary): { cols: number; rows: number } | null {
  const { paneFixed, terminalCols, terminalRows } = session;
  if (!paneFixed || terminalCols == null || terminalRows == null) return null;
  return { cols: terminalCols, rows: terminalRows };
}

export function StepSessionView({ session, stepName, onBack }: Props) {
  const live = LIVE_STATUSES.has(session.status);
  return (
    <div className="step-session">
      <div className="step-session-header">
        <button type="button" className="step-session-back" onClick={onBack}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5" />
            <path d="M11 19l-7-7 7-7" />
          </svg>
          Back to orchestrator
        </button>
        <span className="step-session-name">{stepName}</span>
        <span className="mono step-session-adapter">{session.adapterId}</span>
        <div style={{ flex: 1 }} />
        <span className={`mono step-session-status${live ? " step-session-status--live" : ""}`}>
          {session.status}
        </span>
      </div>
      <SessionTerminalView
        sessionId={session.id}
        status={session.status}
        pane={paneOf(session)}
        autoFocus
      />
    </div>
  );
}
