import { useState } from "react";
import type {
  ProposedAction,
  Recommendation,
  RecommendationSourceRef,
  RecommendationSourceRefType,
} from "@orca/contracts";
import { TERMINAL_RECOMMENDATION_STATUSES } from "./RecommendationsPanel";

type Props = {
  recommendation: Recommendation;
  onAccept: () => void;
  onReject: () => void;
  onDismiss: () => void;
  onModify: () => void;
  onViewDetails: () => void;
  accepting?: boolean;
};

export function RecommendationCard({
  recommendation,
  onAccept,
  onReject,
  onDismiss,
  onModify,
  onViewDetails,
  accepting,
}: Props) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { title, type, confidence, rationale, proposedAction, sources, status } = recommendation;
  const confidenceLabel = getConfidenceLabel(confidence);
  const actionSummary = summarizeAction(proposedAction);
  const sourceSummary = summarizeSources(sources);
  const isTerminal = TERMINAL_RECOMMENDATION_STATUSES.has(status as "accepted" | "rejected" | "dismissed" | "superseded");

  function closeOverflow() {
    setOverflowOpen(false);
  }

  return (
    <div className={`recommendation-card recommendation-card--${status}`}>
      <div className="recommendation-card-header">
        <span className={`recommendation-type-badge recommendation-type-badge--${type}`}>
          {type.replace(/_/g, " ")}
        </span>
        <span className={`recommendation-confidence-badge recommendation-confidence-badge--${confidenceLabel}`}>
          {confidenceLabel}
        </span>
      </div>

      <p className="recommendation-card-title">{title}</p>

      <p className="recommendation-card-rationale">
        {rationale.length > 200 ? `${rationale.slice(0, 200)}…` : rationale}
      </p>

      <p className="recommendation-card-action-summary">{actionSummary}</p>

      {sources.length > 0 && (
        <p className="recommendation-card-source-summary">{sourceSummary}</p>
      )}

      <div className="recommendation-card-actions">
        {!isTerminal && (
          <>
            <button
              type="button"
              className="goal-action-button recommendation-accept-button"
              onClick={onAccept}
              disabled={accepting}
            >
              {accepting ? "Accepting…" : "Accept"}
            </button>

            <div className="recommendation-overflow-menu">
              <button
                type="button"
                className="goal-action-button recommendation-overflow-button"
                onClick={() => setOverflowOpen((o) => !o)}
                aria-label="More actions"
                aria-expanded={overflowOpen}
              >
                ···
              </button>
              {overflowOpen && (
                <div className="recommendation-overflow-dropdown" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeOverflow();
                      onReject();
                    }}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeOverflow();
                      onDismiss();
                    }}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeOverflow();
                      onModify();
                    }}
                  >
                    Modify
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <button
          type="button"
          className="goal-action-button recommendation-details-button"
          onClick={onViewDetails}
        >
          Details
        </button>
      </div>
    </div>
  );
}

function getConfidenceLabel(confidence: number): "low" | "med" | "high" {
  if (confidence < 0.5) return "low";
  if (confidence < 0.8) return "med";
  return "high";
}

function summarizeAction(action: ProposedAction): string {
  switch (action.kind) {
    case "create_session":
      return `Start ${action.role} session`;
    case "continue_session":
      return "Continue session";
    case "review_output":
      return "Review session output";
    case "refine_goal":
      return `Refine goal: ${action.missingFields.join(", ")}`;
    case "split_task":
      return `Split task into ${action.suggestedChildren.length} subtask${action.suggestedChildren.length !== 1 ? "s" : ""}`;
    case "run_validation":
      return `Run validation (${action.suggestedRole})`;
    case "resolve_conflict":
      return "Resolve conflict";
    case "update_plan":
      return `Update task plan${action.suggestedStatus ? ` → ${action.suggestedStatus}` : ""}`;
    case "ask_user":
      return `Ask: ${action.question.length > 60 ? `${action.question.slice(0, 60)}…` : action.question}`;
    case "mark_complete":
      return "Mark task complete";
    case "pause_work":
      return `Pause: ${action.reason.length > 60 ? `${action.reason.slice(0, 60)}…` : action.reason}`;
  }
}

const SOURCE_TYPE_LABELS: Record<RecommendationSourceRefType, string> = {
  goal: "goal",
  refinement: "refinement",
  workspace: "workspace",
  task: "task",
  memory_item: "memory",
  decision: "decision",
  session_summary: "summary",
  session: "session",
  context_package: "context",
  conflict: "conflict",
};

function summarizeSources(sources: RecommendationSourceRef[]): string {
  if (sources.length === 0) return "No sources";
  const counts = new Map<string, number>();
  for (const src of sources) {
    const label = SOURCE_TYPE_LABELS[src.type] ?? src.type;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
}
