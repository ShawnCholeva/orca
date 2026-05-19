import type { SessionSummary } from "@orca/contracts";

type Props = {
  session: SessionSummary;
  workspaceName: string;
  selected: boolean;
  stopping: boolean;
  onSelect(): void;
  onStop(): void;
};

const STOPPABLE = new Set(["starting", "running"]);

export function SessionListItem({ session, workspaceName, selected, stopping, onSelect, onStop }: Props) {
  const shortId = session.id.slice(0, 8);
  const canStop = STOPPABLE.has(session.status);

  return (
    <li
      className={`session-list-item${selected ? " session-list-item--selected" : ""}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }}
      aria-selected={selected}
    >
      <div className="session-list-item-info">
        <span className="session-list-id" title={session.id}>{shortId}</span>
        <span className="session-list-adapter">{session.adapterId}</span>
        <span className="session-list-workspace">{workspaceName}</span>
        {session.role && <span className="session-list-role">{session.role}</span>}
        <span className={`session-status session-status--${session.status}`}>
          {session.status}
        </span>
        <time className="session-list-time" dateTime={session.createdAt}>
          {new Date(session.createdAt).toLocaleString()}
        </time>
      </div>
      {canStop && (
        <button
          type="button"
          className="goal-action-button goal-action-button--danger"
          onClick={(e) => { e.stopPropagation(); onStop(); }}
          disabled={stopping}
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      )}
    </li>
  );
}
