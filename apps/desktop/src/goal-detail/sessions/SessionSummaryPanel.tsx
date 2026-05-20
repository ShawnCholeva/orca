import { useState, useEffect } from "react";
import type { SessionMemorySummary } from "@orca/contracts";
import { getSessionSummary, toErrorMessage } from "../../api";

type Props = {
  sessionId: string;
};

export function SessionSummaryPanel({ sessionId }: Props) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<SessionMemorySummary | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSummary(undefined);
    setError(null);
    let cancelled = false;
    getSessionSummary(sessionId)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch((err) => { if (!cancelled) setError(toErrorMessage(err, "Failed to load summary.")); });
    return () => { cancelled = true; };
  }, [sessionId, open]);

  return (
    <div className="session-summary-panel">
      <button
        type="button"
        className="session-summary-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Latest summary
      </button>
      {open && (
        <div className="session-summary-body">
          {error && <p className="form-error">{error}</p>}
          {summary === undefined && !error && <p className="empty-state">Loading…</p>}
          {summary === null && <p className="empty-state">No summary available.</p>}
          {summary && (
            <>
              <p className="session-summary-headline">
                {summary.headline}
                {summary.truncated && (
                  <span className="extraction-badge extraction-badge--truncated" title="Output was truncated before extraction">
                    truncated
                  </span>
                )}
              </p>
              <p className="session-summary-text">{summary.summaryText}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
