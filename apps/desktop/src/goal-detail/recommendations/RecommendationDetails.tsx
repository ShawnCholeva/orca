import { useState } from "react";
import type { Recommendation } from "@orca/contracts";

type Props = {
  recommendation: Recommendation;
  onClose: () => void;
};

export function RecommendationDetails({ recommendation, onClose }: Props) {
  const [actionCollapsed, setActionCollapsed] = useState(true);
  const { title, type, status, rationale, proposedAction, sources, confidence, createdAt, updatedAt } = recommendation;

  return (
    <div className="recommendation-details-drawer" role="dialog" aria-modal="true" aria-label="Recommendation Details">
      <div className="recommendation-details-header">
        <div className="recommendation-details-title-row">
          <span className={`recommendation-type-badge recommendation-type-badge--${type}`}>
            {type.replace(/_/g, " ")}
          </span>
          <span className={`recommendation-status-badge recommendation-status-badge--${status}`}>
            {status}
          </span>
          <span className="recommendation-confidence-label">
            confidence: {confidence.toFixed(2)}
          </span>
        </div>
        <h4 className="recommendation-details-title">{title}</h4>
        <button type="button" className="goal-action-button" onClick={onClose}>
          Close
        </button>
      </div>

      <section className="recommendation-details-section">
        <h5 className="recommendation-details-section-heading">Rationale</h5>
        <p className="recommendation-details-rationale">{rationale}</p>
      </section>

      <section className="recommendation-details-section">
        <h5 className="recommendation-details-section-heading">
          Proposed Action
          <button
            type="button"
            className="goal-action-button recommendation-details-toggle"
            onClick={() => setActionCollapsed((c) => !c)}
            aria-expanded={!actionCollapsed}
          >
            {actionCollapsed ? "Show" : "Hide"}
          </button>
        </h5>
        {!actionCollapsed && (
          <pre className="recommendation-details-action-json">
            <code>{JSON.stringify(proposedAction, null, 2)}</code>
          </pre>
        )}
      </section>

      {sources.length > 0 && (
        <section className="recommendation-details-section">
          <h5 className="recommendation-details-section-heading">Sources ({sources.length})</h5>
          <ul className="recommendation-details-source-list">
            {sources.map((src, i) => (
              <li key={i} className="recommendation-details-source-item">
                <span className="recommendation-details-source-type">{src.type.replace(/_/g, " ")}</span>
                <span className="recommendation-details-source-id">{src.id}</span>
                {src.reason && (
                  <span className="recommendation-details-source-reason">{src.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="recommendation-details-section recommendation-details-meta">
        <span>Created: {formatDateTime(createdAt)}</span>
        <span>Updated: {formatDateTime(updatedAt)}</span>
      </section>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
