import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProposedAction,
  Recommendation,
  RecommendationGeneration,
  RefinementFieldKey,
  TaskRole,
  TaskStatus,
} from "@orca/contracts";
import type {
  LiveGenerationNotice,
  RecommendationDetailRefresh,
} from "../../events/orchestration-live-refresh";
import {
  acceptRecommendation,
  dismissRecommendation,
  generateRecommendations,
  getRecommendation,
  listRecommendations,
  modifyRecommendation,
  rejectRecommendation,
  toErrorMessage,
  type ModifyRecommendationRequest,
} from "../../api";
import { RecommendationCard } from "./RecommendationCard";
import { RecommendationDetails } from "./RecommendationDetails";
import { RecommendationModifyDialog } from "./RecommendationModifyDialog";

export const TERMINAL_RECOMMENDATION_STATUSES = new Set([
  "accepted",
  "rejected",
  "dismissed",
  "superseded",
] as const);

export type CreateSessionPrefill = {
  adapterId: string;
  workspaceId?: string;
  role: string;
  objective: string;
  contextPackageId?: string;
  contextRequest?: {
    adapterId: string;
    role: string;
    objective: string;
    workspaceId?: string;
  };
  taskId?: string;
  workflowStepRunId?: string;
  fromRecommendationId: string;
};

type Props = {
  goalId: string;
  refreshKey?: number;
  onOpenCreateSession?: (prefill: CreateSessionPrefill) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onOpenRefinement?: (missingFields: RefinementFieldKey[]) => void;
  onOpenTaskEdit?: (taskId: string, suggestedStatus?: TaskStatus, addAcceptanceCriteria?: string[]) => void;
  onOpenTaskSplit?: (taskId: string, suggestedChildren: Array<{ title: string; role?: TaskRole }>) => void;
  onOpenConflictResolve?: (conflictId: string, suggestedNote?: string) => void;
  onAskUser?: (question: string) => void;
  liveGeneration?: LiveGenerationNotice | null;
  recommendationDetailRefresh?: RecommendationDetailRefresh | null;
};

export function RecommendationsPanel({
  goalId,
  refreshKey = 0,
  liveGeneration = null,
  recommendationDetailRefresh = null,
  onOpenCreateSession,
  onNavigateToSession,
  onOpenRefinement,
  onOpenTaskEdit,
  onOpenTaskSplit,
  onOpenConflictResolve,
  onAskUser,
}: Props) {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [generations, setGenerations] = useState<RecommendationGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [modifiedExpanded, setModifiedExpanded] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [detailRec, setDetailRec] = useState<Recommendation | null>(null);
  const [modifyRec, setModifyRec] = useState<Recommendation | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [pauseToast, setPauseToast] = useState<string | null>(null);
  const pauseToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await listRecommendations(goalId, { limit: 50, includeGenerations: true });
      setRecommendations(body.recommendations);
      setGenerations(body.generations);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to load recommendations."));
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (recommendationDetailRefresh === null) return;
    const recommendationId = recommendationDetailRefresh.recommendationId;
    let cancelled = false;

    async function loadRecommendationDetail() {
      try {
        const body = await getRecommendation(recommendationId);
        if (cancelled || body.recommendation.goalId !== goalId) return;
        setRecommendations((current) => {
          const existingIndex = current.findIndex((r) => r.id === body.recommendation.id);
          if (existingIndex === -1) return [body.recommendation, ...current];
          const next = [...current];
          next[existingIndex] = body.recommendation;
          return next;
        });
      } catch (err) {
        if (!cancelled) {
          setError(toErrorMessage(err, "Failed to refresh recommendation."));
        }
      }
    }

    void loadRecommendationDetail();

    return () => {
      cancelled = true;
    };
  }, [goalId, recommendationDetailRefresh]);

  const active = recommendations.filter((r) => r.status === "proposed");
  const modified = recommendations.filter((r) => r.status === "modified");
  const history = recommendations.filter((r) =>
    TERMINAL_RECOMMENDATION_STATUSES.has(r.status as "accepted" | "rejected" | "dismissed" | "superseded"),
  );

  const latestGeneration = generations[0] ?? null;
  const visibleLiveGeneration =
    liveGeneration !== null && latestGeneration?.id !== liveGeneration.generationId
      ? liveGeneration
      : null;
  const generateDisabled =
    generating ||
    visibleLiveGeneration?.status === "pending" ||
    latestGeneration?.status === "pending" ||
    latestGeneration?.status === "running";

  async function handleGenerate() {
    setGenerating(true);
    setActionError(null);
    try {
      const response = await generateRecommendations(goalId);
      setGenerations((current) => [
        response.generation,
        ...current.filter((g) => g.id !== response.generation.id),
      ]);
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Generate recommendations failed."));
    } finally {
      setGenerating(false);
    }
  }

  async function handleAccept(rec: Recommendation) {
    setAcceptingId(rec.id);
    setActionError(null);
    try {
      const resp = await acceptRecommendation(rec.id, {});
      await load();
      dispatchPrefill(rec.id, resp.proposedAction, rec.relatedTaskId ?? undefined);
    } catch (err) {
      setActionError(toErrorMessage(err, "Accept failed."));
    } finally {
      setAcceptingId(null);
    }
  }

  function dispatchPrefill(recommendationId: string, action: ProposedAction, relatedTaskId?: string) {
    switch (action.kind) {
      case "create_session":
        onOpenCreateSession?.({
          adapterId: action.adapterId,
          workspaceId: action.workspaceId,
          role: action.role,
          objective: action.objective,
          contextPackageId: action.contextPackageId,
          contextRequest: action.contextRequest,
          taskId: relatedTaskId,
          fromRecommendationId: recommendationId,
        });
        break;
      case "continue_session":
        onNavigateToSession?.(action.sessionId);
        break;
      case "review_output":
        onOpenCreateSession?.({
          adapterId: "claude-code",
          role: action.reviewerRole ?? "reviewer",
          objective: "",
          fromRecommendationId: recommendationId,
        });
        break;
      case "refine_goal":
        onOpenRefinement?.(action.missingFields as RefinementFieldKey[]);
        break;
      case "split_task":
        onOpenTaskSplit?.(action.taskId, action.suggestedChildren);
        break;
      case "run_validation":
        onOpenCreateSession?.({
          adapterId: "claude-code",
          role: action.suggestedRole,
          objective: action.objective,
          taskId: action.taskId,
          fromRecommendationId: recommendationId,
        });
        break;
      case "resolve_conflict":
        onOpenConflictResolve?.(action.conflictId, action.suggestedResolutionNote);
        break;
      case "update_plan":
        onOpenTaskEdit?.(
          action.taskId,
          action.suggestedStatus,
          action.addAcceptanceCriteria,
        );
        break;
      case "ask_user":
        onAskUser?.(action.question);
        break;
      case "mark_complete":
        onOpenTaskEdit?.(action.taskId, "done" as TaskStatus);
        break;
      case "pause_work":
        showPauseToast();
        break;
      case "complete_workflow_run":
        showToast("Workflow run completed.");
        break;
      default:
        // Every other accepted action still needs honest feedback — a handled kind
        // above navigates or opens a dialog; anything without a UI destination (e.g.
        // advance_workflow_step, launch_workflow_session, mark_artifact_satisfied)
        // must confirm rather than silently no-op.
        showToast("Recommendation accepted.");
        break;
    }
  }

  function showToast(message: string) {
    if (pauseToastTimerRef.current !== null) {
      clearTimeout(pauseToastTimerRef.current);
    }
    setPauseToast(message);
    pauseToastTimerRef.current = setTimeout(() => setPauseToast(null), 5000);
  }

  function showPauseToast() {
    showToast("Work paused. Review open tasks and sessions before continuing.");
  }

  useEffect(() => {
    return () => {
      if (pauseToastTimerRef.current !== null) {
        clearTimeout(pauseToastTimerRef.current);
      }
    };
  }, []);

  async function handleReject(rec: Recommendation) {
    setActionError(null);
    try {
      await rejectRecommendation(rec.id, {});
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Reject failed."));
    }
  }

  async function handleDismiss(rec: Recommendation) {
    setActionError(null);
    try {
      await dismissRecommendation(rec.id, {});
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Dismiss failed."));
    }
  }

  async function handleModifySave(patch: ModifyRecommendationRequest) {
    if (!modifyRec) return;
    await modifyRecommendation(modifyRec.id, patch);
    setModifyRec(null);
    await load();
  }

  return (
    <section className="goal-detail-section recommendations-panel" aria-label="Recommendations">
      <div className="goal-detail-section-header">
        <h3 className="goal-detail-section-title">
          Recommendations{recommendations.length > 0 ? ` (${recommendations.length})` : ""}
        </h3>
        <button
          type="button"
          className="goal-action-button recommendations-generate-button"
          onClick={() => void handleGenerate()}
          disabled={generateDisabled}
        >
          {generateDisabled ? "Generating…" : "Generate recommendations"}
        </button>
      </div>

      {visibleLiveGeneration && <LiveGenerationBanner generation={visibleLiveGeneration} />}
      {latestGeneration && <GenerationBanner generation={latestGeneration} />}

      {actionError && (
        <p className="form-error recommendations-action-error" role="alert">
          {actionError}
        </p>
      )}

      {pauseToast && (
        <p className="recommendations-pause-toast" role="status">
          {pauseToast}
        </p>
      )}

      {loading && recommendations.length === 0 && (
        <div className="recommendations-panel-loading" aria-label="Loading recommendations">
          <p>Loading…</p>
        </div>
      )}

      {!loading && error && (
        <div className="recommendations-panel-error">
          <p className="form-error">{error}</p>
          <button type="button" className="goal-action-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && active.length === 0 && modified.length === 0 && history.length === 0 && (
        <div className="recommendations-panel-empty">
          <p className="empty-state">No recommendations yet.</p>
          <button
            type="button"
            className="goal-action-button"
            onClick={() => void handleGenerate()}
            disabled={generateDisabled}
          >
            Generate recommendations
          </button>
        </div>
      )}

      {active.length > 0 && (
        <div className="recommendations-section">
          <h4 className="recommendations-section-heading">Active ({active.length})</h4>
          <ul className="recommendation-list">
            {active.map((rec) => (
              <li key={rec.id}>
                <RecommendationCard
                  recommendation={rec}
                  accepting={acceptingId === rec.id}
                  onAccept={() => void handleAccept(rec)}
                  onReject={() => void handleReject(rec)}
                  onDismiss={() => void handleDismiss(rec)}
                  onModify={() => setModifyRec(rec)}
                  onViewDetails={() => setDetailRec(rec)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {modified.length > 0 && (
        <div className="recommendations-section">
          <button
            type="button"
            className="recommendations-section-toggle"
            onClick={() => setModifiedExpanded((e) => !e)}
            aria-expanded={modifiedExpanded}
          >
            <h4 className="recommendations-section-heading">
              Modified ({modified.length}) {modifiedExpanded ? "▲" : "▼"}
            </h4>
          </button>
          {modifiedExpanded && (
            <ul className="recommendation-list">
              {modified.map((rec) => (
                <li key={rec.id}>
                  <RecommendationCard
                    recommendation={rec}
                    accepting={acceptingId === rec.id}
                    onAccept={() => void handleAccept(rec)}
                    onReject={() => void handleReject(rec)}
                    onDismiss={() => void handleDismiss(rec)}
                    onModify={() => setModifyRec(rec)}
                    onViewDetails={() => setDetailRec(rec)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="recommendations-section">
          <button
            type="button"
            className="recommendations-section-toggle"
            onClick={() => setHistoryExpanded((e) => !e)}
            aria-expanded={historyExpanded}
          >
            <h4 className="recommendations-section-heading">
              History ({history.length}) {historyExpanded ? "▲" : "▼"}
            </h4>
          </button>
          {historyExpanded && (
            <ul className="recommendation-list">
              {history.map((rec) => (
                <li key={rec.id}>
                  <RecommendationCard
                    recommendation={rec}
                    accepting={false}
                    onAccept={() => void handleAccept(rec)}
                    onReject={() => void handleReject(rec)}
                    onDismiss={() => void handleDismiss(rec)}
                    onModify={() => setModifyRec(rec)}
                    onViewDetails={() => setDetailRec(rec)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {detailRec && (
        <RecommendationDetails recommendation={detailRec} onClose={() => setDetailRec(null)} />
      )}

      {modifyRec && (
        <RecommendationModifyDialog
          recommendation={modifyRec}
          onSave={(patch) => handleModifySave(patch)}
          onClose={() => setModifyRec(null)}
        />
      )}
    </section>
  );
}

function GenerationBanner({ generation }: { generation: RecommendationGeneration }) {
  const time = generation.finishedAt ?? generation.startedAt ?? generation.requestedAt;
  const detail =
    generation.status === "failed" && generation.failureCode
      ? `failure: ${generation.failureCode}`
      : generation.sparse
        ? "sparse input"
        : null;

  return (
    <div
      className={`recommendation-generation-banner recommendation-generation-banner--${generation.status}`}
    >
      <span className="recommendation-generation-status">{generation.status}</span>
      <span>{formatDateTime(time)}</span>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function LiveGenerationBanner({ generation }: { generation: LiveGenerationNotice }) {
  return (
    <div
      className={`recommendation-generation-banner recommendation-generation-banner--${generation.status}`}
    >
      <span className="recommendation-generation-status">{generation.status}</span>
      <span>{formatDateTime(generation.noticedAt)}</span>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
