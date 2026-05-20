import type { SessionSummary, SessionLatestExtraction } from "@orca/contracts";

type Props = {
  session: SessionSummary;
  workspaceName: string;
  selected: boolean;
  stopping: boolean;
  extracting: boolean;
  onSelect(): void;
  onStop(): void;
  onExtract(): void;
};

const STOPPABLE = new Set(["starting", "running"]);
const TERMINAL = new Set(["exited", "failed", "stopped"]);
const EXTRACTION_BUSY = new Set(["pending", "running"]);

function ExtractionBadge({ extraction }: { extraction: SessionLatestExtraction | undefined }) {
  if (!extraction) {
    return <span className="extraction-badge extraction-badge--none">no extraction</span>;
  }
  const { status, truncated, failureCode } = extraction;
  if (status === "pending" || status === "running") {
    return (
      <span className="extraction-badge extraction-badge--busy">
        <span className="extraction-spinner" aria-hidden="true" />
        {status === "pending" ? "extraction pending" : "extracting…"}
      </span>
    );
  }
  if (status === "succeeded") {
    const label = truncated ? "extracted (truncated)" : "extracted";
    const title = truncated ? "Extraction succeeded but output was truncated" : undefined;
    return <span className="extraction-badge extraction-badge--succeeded" title={title}>{label}</span>;
  }
  if (status === "failed") {
    const title = failureCode ?? undefined;
    return <span className="extraction-badge extraction-badge--failed" title={title}>extraction failed</span>;
  }
  return null;
}

export function SessionListItem({ session, workspaceName, selected, stopping, extracting, onSelect, onStop, onExtract }: Props) {
  const shortId = session.id.slice(0, 8);
  const canStop = STOPPABLE.has(session.status);
  const isTerminal = TERMINAL.has(session.status);
  const extractionBusy = extracting || EXTRACTION_BUSY.has(session.latestExtraction?.status ?? "");
  const extractLabel = session.latestExtraction?.status === "failed" ? "Retry extraction" : "Extract now";

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
        <ExtractionBadge extraction={session.latestExtraction} />
      </div>
      <div className="session-list-item-actions">
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
        {isTerminal && (
          <button
            type="button"
            className="goal-action-button"
            onClick={(e) => { e.stopPropagation(); onExtract(); }}
            disabled={extractionBusy}
          >
            {extractLabel}
          </button>
        )}
      </div>
    </li>
  );
}
