import { useState, useEffect, useCallback, useRef } from "react";
import type { DomainEvent, GoalDetailResponse, DomainEventType, RefinementFieldKey, TaskRole, TaskStatus } from "@orca/contracts";
import { getGoalDetail, openEventStream } from "../api";
import {
  feedbackRecommendationId,
  generationNoticeFromEvent,
  M7_LIVE_REFRESH_DEBOUNCE_MS,
  recommendationEventMayTouchTask,
  type RecommendationDetailRefresh,
  type LiveGenerationNotice,
} from "../events/m7-live-refresh";
import { WorkspaceListPanel } from "./WorkspaceListPanel";
import { TasksPanel } from "./tasks/TasksPanel";
import { SessionsPanel } from "./sessions/SessionsPanel";
import { MemoryPanel } from "./memory/MemoryPanel";
import { DecisionsPanel } from "./decisions/DecisionsPanel";
import { RecommendationsPanel, type CreateSessionPrefill } from "./recommendations/RecommendationsPanel";
import { ConflictsBanner } from "./conflicts/ConflictsBanner";

const MEMORY_ITEM_EVENTS = new Set<DomainEventType>([
  "memory.item.created",
  "memory.item.updated",
  "memory.item.promoted",
  "memory.item.archived",
]);

const DECISION_EVENTS = new Set<DomainEventType>([
  "decision.created",
  "decision.updated",
  "decision.confirmed",
  "decision.archived",
]);

type Props = {
  goalId: string;
  onBack: () => void;
  refreshKey: number;
};

export function GoalDetailView({ goalId, onBack, refreshKey }: Props) {
  const [detail, setDetail] = useState<GoalDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [recommendationsRefreshKey, setRecommendationsRefreshKey] = useState(0);
  const [conflictsRefreshKey, setConflictsRefreshKey] = useState(0);
  const [recommendationDetailRefresh, setRecommendationDetailRefresh] =
    useState<RecommendationDetailRefresh | null>(null);
  const [liveTaskGeneration, setLiveTaskGeneration] =
    useState<LiveGenerationNotice | null>(null);
  const [liveRecommendationGeneration, setLiveRecommendationGeneration] =
    useState<LiveGenerationNotice | null>(null);
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0);
  const [decisionsRefreshKey, setDecisionsRefreshKey] = useState(0);
  const [summaryRefreshKey, setSummaryRefreshKey] = useState(0);
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);
  const [createSessionPrefill, setCreateSessionPrefill] =
    useState<CreateSessionPrefill | null>(null);
  const [taskEditPrefill, setTaskEditPrefill] = useState<{
    taskId: string;
    suggestedStatus?: TaskStatus;
    addAcceptanceCriteria?: string[];
  } | null>(null);
  const [taskSplitPrefill, setTaskSplitPrefill] = useState<{
    taskId: string;
    suggestedChildren: Array<{ title: string; role?: TaskRole }>;
  } | null>(null);
  const [conflictResolvePrefill, setConflictResolvePrefill] =
    useState<{ conflictId: string; suggestedNote?: string } | null>(null);
  const [refinementPrompt, setRefinementPrompt] = useState<RefinementFieldKey[] | null>(null);
  const [userQuestion, setUserQuestion] = useState<string | null>(null);
  const hasConnectedRef = useRef(false);
  const debounceTimersRef = useRef<{
    tasks: ReturnType<typeof setTimeout> | null;
    recommendations: ReturnType<typeof setTimeout> | null;
    conflicts: ReturnType<typeof setTimeout> | null;
    recommendationDetail: ReturnType<typeof setTimeout> | null;
  }>({
    tasks: null,
    recommendations: null,
    conflicts: null,
    recommendationDetail: null,
  });

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getGoalDetail(goalId);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Goal detail.");
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, refreshKey]);

  useEffect(() => {
    const timers = debounceTimersRef.current;
    return () => {
      for (const timer of Object.values(timers)) {
        if (timer !== null) clearTimeout(timer);
      }
    };
  }, []);

  const scheduleTasksRefresh = useCallback(() => {
    if (debounceTimersRef.current.tasks !== null) {
      clearTimeout(debounceTimersRef.current.tasks);
    }
    debounceTimersRef.current.tasks = setTimeout(() => {
      debounceTimersRef.current.tasks = null;
      setTasksRefreshKey((k) => k + 1);
    }, M7_LIVE_REFRESH_DEBOUNCE_MS);
  }, []);

  const scheduleRecommendationsRefresh = useCallback(() => {
    if (debounceTimersRef.current.recommendations !== null) {
      clearTimeout(debounceTimersRef.current.recommendations);
    }
    debounceTimersRef.current.recommendations = setTimeout(() => {
      debounceTimersRef.current.recommendations = null;
      setRecommendationsRefreshKey((k) => k + 1);
    }, M7_LIVE_REFRESH_DEBOUNCE_MS);
  }, []);

  const scheduleConflictsRefresh = useCallback(() => {
    if (debounceTimersRef.current.conflicts !== null) {
      clearTimeout(debounceTimersRef.current.conflicts);
    }
    debounceTimersRef.current.conflicts = setTimeout(() => {
      debounceTimersRef.current.conflicts = null;
      setConflictsRefreshKey((k) => k + 1);
    }, M7_LIVE_REFRESH_DEBOUNCE_MS);
  }, []);

  const scheduleRecommendationDetailRefresh = useCallback((recommendationId: string) => {
    if (debounceTimersRef.current.recommendationDetail !== null) {
      clearTimeout(debounceTimersRef.current.recommendationDetail);
    }
    debounceTimersRef.current.recommendationDetail = setTimeout(() => {
      debounceTimersRef.current.recommendationDetail = null;
      setRecommendationDetailRefresh((current) => ({
        recommendationId,
        nonce: (current?.nonce ?? 0) + 1,
      }));
    }, M7_LIVE_REFRESH_DEBOUNCE_MS);
  }, []);

  const handleM7Event = useCallback(
    (event: DomainEvent) => {
      if (event.type === "task.generation.requested") {
        setLiveTaskGeneration(generationNoticeFromEvent(event));
        return;
      }
      if (event.type === "task.generated" || event.type === "task.generation.failed") {
        setLiveTaskGeneration(null);
        scheduleTasksRefresh();
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleTasksRefresh();
        return;
      }

      if (event.type === "recommendation.generation.requested") {
        setLiveRecommendationGeneration(generationNoticeFromEvent(event));
        return;
      }
      if (
        event.type === "recommendation.generated" ||
        event.type === "recommendation.generation.failed"
      ) {
        setLiveRecommendationGeneration(null);
        scheduleRecommendationsRefresh();
        return;
      }
      if (event.type.startsWith("recommendation.")) {
        scheduleRecommendationsRefresh();
        if (recommendationEventMayTouchTask(event)) {
          scheduleTasksRefresh();
        }
        return;
      }

      if (event.type.startsWith("conflict.")) {
        scheduleConflictsRefresh();
        return;
      }

      const recommendationId = feedbackRecommendationId(event);
      if (recommendationId !== null) {
        scheduleRecommendationDetailRefresh(recommendationId);
      }
    },
    [
      scheduleConflictsRefresh,
      scheduleRecommendationDetailRefresh,
      scheduleRecommendationsRefresh,
      scheduleTasksRefresh,
    ],
  );

  useEffect(() => {
    hasConnectedRef.current = false;
    const stream = openEventStream({
      onEvent(event) {
        if (event.goalId === null || event.goalId !== goalId) return;
        if (event.type === "memory.extraction.completed") {
          setMemoryRefreshKey((k) => k + 1);
          setDecisionsRefreshKey((k) => k + 1);
          setSummaryRefreshKey((k) => k + 1);
        } else if (MEMORY_ITEM_EVENTS.has(event.type)) {
          setMemoryRefreshKey((k) => k + 1);
        } else if (DECISION_EVENTS.has(event.type)) {
          setDecisionsRefreshKey((k) => k + 1);
        }
        handleM7Event(event);
      },
      onStatus(status) {
        if (status === "open") {
          if (hasConnectedRef.current) {
            setMemoryRefreshKey((k) => k + 1);
            setDecisionsRefreshKey((k) => k + 1);
            setSummaryRefreshKey((k) => k + 1);
            setSessionsRefreshKey((k) => k + 1);
            setLiveTaskGeneration(null);
            setLiveRecommendationGeneration(null);
            scheduleTasksRefresh();
            scheduleRecommendationsRefresh();
            scheduleConflictsRefresh();
          }
          hasConnectedRef.current = true;
        }
      },
    });
    return () => stream.close();
  }, [
    goalId,
    handleM7Event,
    scheduleConflictsRefresh,
    scheduleRecommendationsRefresh,
    scheduleTasksRefresh,
  ]);

  if (loading && !detail) {
    return (
      <div className="goal-detail-loading">
        <p>Loading…</p>
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div className="goal-detail-error">
        <p className="form-error">{error}</p>
        <button type="button" className="goal-action-button" onClick={() => void loadDetail()}>
          Retry
        </button>
      </div>
    );
  }

  if (!detail) return null;

  const { goal, refinement, workspaces } = detail;

  return (
    <div className="goal-detail">
      <div className="goal-detail-topbar">
        <button type="button" className="goal-action-button" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="goal-detail-main">
        <header className="goal-detail-header">
          <h2 className="goal-detail-title">{goal.title}</h2>
          <span className={`goal-status goal-status--${goal.status}`}>{goal.status}</span>
        </header>

        {goal.description && (
          <p className="goal-detail-description">{goal.description}</p>
        )}

        <ConflictsBanner
          goalId={goalId}
          refreshKey={conflictsRefreshKey}
          resolvePrefill={conflictResolvePrefill}
          onResolvePrefillConsumed={() => setConflictResolvePrefill(null)}
        />

        {refinementPrompt && (
          <div className="recommendation-prefill-notice" role="status">
            Refine goal: {refinementPrompt.join(", ")}
            <button type="button" className="goal-action-button" onClick={() => setRefinementPrompt(null)}>
              Dismiss
            </button>
          </div>
        )}

        {userQuestion && (
          <div className="recommendation-prefill-notice" role="status">
            {userQuestion}
            <button type="button" className="goal-action-button" onClick={() => setUserQuestion(null)}>
              Dismiss
            </button>
          </div>
        )}

        {refinement && (
          <section className="goal-detail-section goal-refinement" aria-label="Refinement">
            <h3 className="goal-detail-section-title">Refinement</h3>

            {refinement.successCriteria.length > 0 && (
              <div className="refinement-display-block">
                <h4 className="refinement-display-heading">Success Criteria</h4>
                <ul className="refinement-display-list">
                  {refinement.successCriteria.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {refinement.constraints.length > 0 && (
              <div className="refinement-display-block">
                <h4 className="refinement-display-heading">Constraints</h4>
                <ul className="refinement-display-list">
                  {refinement.constraints.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {refinement.assumptions.length > 0 && (
              <div className="refinement-display-block">
                <h4 className="refinement-display-heading">Assumptions</h4>
                <ul className="refinement-display-list">
                  {refinement.assumptions.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <WorkspaceListPanel
          goalId={goalId}
          workspaces={workspaces}
          onChanged={() => void loadDetail()}
        />

        <TasksPanel
          goalId={goalId}
          workspaces={workspaces}
          refreshKey={tasksRefreshKey}
          liveGeneration={liveTaskGeneration}
          editPrefill={taskEditPrefill}
          splitPrefill={taskSplitPrefill}
          onTaskPrefillConsumed={() => {
            setTaskEditPrefill(null);
            setTaskSplitPrefill(null);
          }}
        />

        <SessionsPanel
          goalId={goalId}
          workspaces={workspaces}
          sessionsRefreshKey={sessionsRefreshKey}
          summaryRefreshKey={summaryRefreshKey}
          createSessionPrefill={createSessionPrefill}
          onCreateSessionPrefillConsumed={() => setCreateSessionPrefill(null)}
        />

        <RecommendationsPanel
          goalId={goalId}
          refreshKey={recommendationsRefreshKey}
          liveGeneration={liveRecommendationGeneration}
          recommendationDetailRefresh={recommendationDetailRefresh}
          onOpenCreateSession={setCreateSessionPrefill}
          onOpenRefinement={setRefinementPrompt}
          onOpenTaskEdit={(taskId, suggestedStatus, addAcceptanceCriteria) =>
            setTaskEditPrefill({ taskId, suggestedStatus, addAcceptanceCriteria })
          }
          onOpenTaskSplit={(taskId, suggestedChildren) =>
            setTaskSplitPrefill({ taskId, suggestedChildren })
          }
          onOpenConflictResolve={(conflictId, suggestedNote) =>
            setConflictResolvePrefill({ conflictId, suggestedNote })
          }
          onAskUser={setUserQuestion}
        />

        <MemoryPanel goalId={goalId} refreshKey={memoryRefreshKey} />

        <DecisionsPanel goalId={goalId} refreshKey={decisionsRefreshKey} />
      </div>
    </div>
  );
}
