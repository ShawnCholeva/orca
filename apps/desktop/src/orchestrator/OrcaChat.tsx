import { useEffect, useState, type ReactNode } from "react";
import type {
  Goal,
  GoalDetailResponse,
  Recommendation,
  WorkflowArtifact,
  WorkflowDecisionTrace,
  WorkflowRun,
  WorkflowStepRun,
} from "@orca/contracts";

import type { ConnectionStatus } from "../api";
import {
  acceptRecommendation,
  dismissRecommendation,
  getGoalDetail,
  getWorkflowRun,
  getWorkflowStepRun,
  listRecommendations,
  listWorkflowDecisions,
  listWorkflowRunArtifacts,
  openEventStream,
  rejectRecommendation,
  requestNextOrchestratorDecision,
  startWorkflowRun,
  submitWorkflowUserInput,
  toErrorMessage,
} from "../api";
import { CreateSessionDialog } from "../goal-detail/sessions/CreateSessionDialog";
import { RecommendationCard } from "../goal-detail/recommendations/RecommendationCard";
import type { CreateSessionPrefill } from "../goal-detail/recommendations/RecommendationsPanel";
import { WorkflowBanner } from "./components/WorkflowBanner";
import "./orca-chat.css";

const ENGINEERING_TEMPLATE_ID = "orca/engineering";
const WORKFLOW_RECOMMENDATION_TYPES = [
  "advance_workflow_step",
  "launch_workflow_session",
  "complete_workflow_run",
  "mark_artifact_satisfied",
  "request_user_input",
 ] as const;
const WORKFLOW_RECOMMENDATION_TYPE_SET = new Set<string>(WORKFLOW_RECOMMENDATION_TYPES);
const ACTIVE_RECOMMENDATION_STATUSES = new Set(["proposed", "modified"]);

type Props = {
  goals: Goal[];
  selectedGoalId: string | null;
  connectionStatus: ConnectionStatus;
};

type WorkflowState = {
  detail: GoalDetailResponse | null;
  run: WorkflowRun | null;
  stepRun: WorkflowStepRun | null;
  decisions: WorkflowDecisionTrace[];
  artifacts: WorkflowArtifact[];
  recommendations: Recommendation[];
};

type PendingInputPrompt = {
  question: string;
  stepRunId: string;
  recommendationId: string;
};

const EMPTY_WORKFLOW_STATE: WorkflowState = {
  detail: null,
  run: null,
  stepRun: null,
  decisions: [],
  artifacts: [],
  recommendations: [],
};

export function OrcaChat({ goals, selectedGoalId, connectionStatus }: Props) {
  const [workflowState, setWorkflowState] = useState<WorkflowState>(EMPTY_WORKFLOW_STATE);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [sessionPrefill, setSessionPrefill] = useState<CreateSessionPrefill | null>(null);
  const [pendingInput, setPendingInput] = useState<PendingInputPrompt | null>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  const [submittingInput, setSubmittingInput] = useState(false);

  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId) ?? null;
  const connected = connectionStatus === "open";

  useEffect(() => {
    setActionError(null);
    setPendingInput(null);
    setAnswerDraft("");
    setSessionPrefill(null);
  }, [selectedGoalId]);

  useEffect(() => {
    if (!selectedGoalId) {
      setWorkflowState(EMPTY_WORKFLOW_STATE);
      setLoading(false);
      setError(null);
      return;
    }
    const goalId = selectedGoalId;

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const detail = await getGoalDetail(goalId);
        if (cancelled) return;

        const runId = detail.goal.activeWorkflowRunId;
        if (!runId) {
          setWorkflowState({
            detail,
            run: null,
            stepRun: null,
            decisions: [],
            artifacts: [],
            recommendations: [],
          });
          return;
        }

        const [runResponse, decisionsResponse, artifactsResponse, recommendationsResponse] =
          await Promise.all([
            getWorkflowRun(goalId, runId),
            listWorkflowDecisions(goalId, runId),
            listWorkflowRunArtifacts(goalId, runId),
            listRecommendations(goalId, { limit: 50, includeGenerations: false }),
          ]);
        if (cancelled) return;

        const stepRun = runResponse.run.currentStepRunId
          ? (await getWorkflowStepRun(goalId, runResponse.run.currentStepRunId)).stepRun
          : null;
        if (cancelled) return;

        setWorkflowState({
          detail,
          run: runResponse.run,
          stepRun,
          decisions: sortByCreatedAtDesc(decisionsResponse.decisions),
          artifacts: sortByCreatedAtDesc(artifactsResponse.artifacts),
          recommendations: sortRecommendations(recommendationsResponse.recommendations),
        });
      } catch (err) {
        if (!cancelled) {
          setError(toErrorMessage(err, "Failed to load orchestrator state."));
          setWorkflowState(EMPTY_WORKFLOW_STATE);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, selectedGoalId]);

  useEffect(() => {
    if (!selectedGoalId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const stream = openEventStream({
      onEvent(event) {
        if (event.goalId !== selectedGoalId) return;
        if (
          event.type === "goal.orchestrator_model_changed" ||
          event.type.startsWith("workflow.") ||
          event.type.startsWith("recommendation.")
        ) {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            setRefreshNonce((current) => current + 1);
          }, 75);
        }
      },
      onStatus() {
        // App owns the global connection indicator.
      },
    });

    return () => {
      if (timer !== null) clearTimeout(timer);
      stream.close();
    };
  }, [selectedGoalId]);

  const latestDecision = workflowState.decisions[0] ?? null;
  const currentStepRunId = workflowState.stepRun?.id ?? null;
  const workflowRecommendations = workflowState.recommendations.filter(
    (recommendation) =>
      isWorkflowRecommendation(recommendation) &&
      ACTIVE_RECOMMENDATION_STATUSES.has(recommendation.status) &&
      recommendation.workflowStepRunId === currentStepRunId,
  );
  const restoredPendingInput =
    pendingInput ?? findAcceptedPendingInput(workflowState.recommendations, currentStepRunId);
  const hasModel = Boolean(
    workflowState.detail?.goal.orchestratorProvider &&
      workflowState.detail?.goal.orchestratorModel,
  );

  async function handleStartEngineeringWorkflow() {
    if (!selectedGoalId) return;
    setStarting(true);
    setActionError(null);
    try {
      const runResponse = await startWorkflowRun(selectedGoalId, {
        goalId: selectedGoalId,
        templateId: ENGINEERING_TEMPLATE_ID,
      });
      await requestNextOrchestratorDecision(selectedGoalId, runResponse.run.id, {
        workflowRunId: runResponse.run.id,
      });
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to start Engineering workflow."));
    } finally {
      setStarting(false);
    }
  }

  async function handleAcceptRecommendation(recommendation: Recommendation) {
    const action = recommendation.proposedAction;
    if (
      action.kind === "advance_workflow_step" &&
      !confirm(`Advance workflow to ${formatStepLabel(action.toStepTemplateId)}?`)
    ) {
      return;
    }
    if (
      action.kind === "complete_workflow_run" &&
      !confirm("Complete this workflow run?")
    ) {
      return;
    }

    setAcceptingId(recommendation.id);
    setActionError(null);
    try {
      const response = await acceptRecommendation(recommendation.id, {});
      switch (response.proposedAction.kind) {
        case "request_user_input":
          setPendingInput({
            question: response.proposedAction.question,
            stepRunId: response.proposedAction.workflowStepRunId,
            recommendationId: recommendation.id,
          });
          setAnswerDraft("");
          break;
        case "launch_workflow_session": {
          const adapterId = adapterIdFromOperator(
            response.proposedAction.operatorId,
            response.proposedAction.operatorKind,
          );
          if (!adapterId) {
            setActionError("Only agent operators can be launched as workflow sessions.");
            break;
          }
          setSessionPrefill({
            adapterId,
            role: roleForWorkflowStep(workflowState.stepRun?.stepTemplateId ?? null),
            objective: response.proposedAction.objective,
            workflowStepRunId: response.proposedAction.workflowStepRunId,
            fromRecommendationId: recommendation.id,
          });
          break;
        }
      }
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to accept workflow recommendation."));
    } finally {
      setAcceptingId(null);
    }
  }

  async function handleSubmitInput() {
    if (!selectedGoalId || !restoredPendingInput) return;
    const answerText = answerDraft.trim();
    if (!answerText) {
      setActionError("Answer text is required.");
      return;
    }

    setSubmittingInput(true);
    setActionError(null);
    try {
      await submitWorkflowUserInput(selectedGoalId, restoredPendingInput.stepRunId, {
        stepRunId: restoredPendingInput.stepRunId,
        answerText,
      });
      setPendingInput(null);
      setAnswerDraft("");
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to submit workflow input."));
    } finally {
      setSubmittingInput(false);
    }
  }

  async function handleRejectRecommendation(recommendationId: string) {
    setActionError(null);
    try {
      await rejectRecommendation(recommendationId, {});
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to reject workflow recommendation."));
    }
  }

  async function handleDismissRecommendation(recommendationId: string) {
    setActionError(null);
    try {
      await dismissRecommendation(recommendationId, {});
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to dismiss workflow recommendation."));
    }
  }

  return (
    <div className="orca-chat">
      <div className="orca-chat-scroll scroll">
        {!selectedGoal && (
          <SystemCard
            title="Select a goal"
            body="Choose a goal from the rail to start or continue its Engineering workflow."
          />
        )}

        {selectedGoal && (
          <>
            <SystemCard
              title={selectedGoal.title}
              body={
                selectedGoal.description ||
                "This goal is ready for supervised workflow orchestration."
              }
              meta={
                workflowState.detail?.goal.orchestratorProvider &&
                workflowState.detail?.goal.orchestratorModel
                  ? `${workflowState.detail.goal.orchestratorProvider} · ${workflowState.detail.goal.orchestratorModel}`
                  : "No orchestrator model selected yet."
              }
            />

            {loading && <ThinkingRow label="syncing workflow state" />}

            {!loading && error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            {!loading && !error && workflowState.detail && !hasModel && (
              <SystemCard
                title="Goal needs an orchestrator model"
                body="This goal was created without an orchestrator provider/model. Create a new goal with an Orchestrator LLM selected before starting Engineering."
              />
            )}

            {!loading &&
              !error &&
              workflowState.detail &&
              hasModel &&
              !workflowState.run && (
                <SystemCard
                  title="Engineering workflow ready"
                  body="Start the built-in Engineering workflow to collect intake, supervise execution, and keep approvals explicit."
                >
                  <button
                    type="button"
                    className="submit-button"
                    onClick={() => void handleStartEngineeringWorkflow()}
                    disabled={!connected || starting}
                  >
                    {starting ? "Starting…" : "Start Engineering workflow"}
                  </button>
                </SystemCard>
              )}

            {!loading && !error && workflowState.run && (
              <WorkflowBanner
                run={workflowState.run}
                stepRun={workflowState.stepRun}
                latestDecision={latestDecision}
                artifacts={workflowState.artifacts}
              />
            )}

            {actionError && (
              <div className="form-error" role="alert">
                {actionError}
              </div>
            )}

            {restoredPendingInput && (
              <div className="orca-chat-input-card">
                <p className="orca-chat-input-label">User input requested</p>
                <p className="orca-chat-input-question">{restoredPendingInput.question}</p>
                <textarea
                  value={answerDraft}
                  onChange={(event) => setAnswerDraft(event.target.value)}
                  rows={4}
                  placeholder="Answer the intake question…"
                  disabled={submittingInput}
                />
                <div className="orca-chat-input-actions">
                  <span className="mono orca-chat-send-hint">
                    from {restoredPendingInput.recommendationId}
                  </span>
                  <button
                    type="button"
                    className="orca-chat-send orca-chat-send--primary"
                    onClick={() => void handleSubmitInput()}
                    disabled={submittingInput || answerDraft.trim().length === 0}
                  >
                    {submittingInput ? "Submitting…" : "Submit"}
                  </button>
                </div>
              </div>
            )}

            {!loading && workflowRecommendations.length > 0 && (
              <div className="orca-chat-recommendations">
                <p className="orca-chat-section-title">
                  Workflow recommendations ({workflowRecommendations.length})
                </p>
                <ul className="recommendation-list">
                  {workflowRecommendations.map((recommendation) => (
                    <li key={recommendation.id}>
                      <RecommendationCard
                        recommendation={recommendation}
                        accepting={acceptingId === recommendation.id}
                        onAccept={() => void handleAcceptRecommendation(recommendation)}
                        onReject={() => void handleRejectRecommendation(recommendation.id)}
                        onDismiss={() => void handleDismissRecommendation(recommendation.id)}
                        onModify={() => {
                          setActionError(
                            "Modify workflow recommendations from Goal detail until the dedicated chat modify flow lands.",
                          );
                        }}
                        onViewDetails={() => {
                          setActionError(
                            "Use the goal detail workflow panel for full recommendation details.",
                          );
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!loading &&
              workflowState.run &&
              !restoredPendingInput &&
              workflowRecommendations.length === 0 && (
                <SystemCard
                  title="No pending workflow recommendations"
                  body="Orca will surface the next approval or intake request here when the workflow advances."
                />
              )}
          </>
        )}
      </div>

      {sessionPrefill && workflowState.detail && (
        <CreateSessionDialog
          key={sessionPrefill.fromRecommendationId}
          goalId={workflowState.detail.goal.id}
          workspaces={workflowState.detail.workspaces}
          prefill={sessionPrefill}
          onCreated={() => {
            setSessionPrefill(null);
            setRefreshNonce((current) => current + 1);
          }}
          onClose={() => setSessionPrefill(null)}
        />
      )}
    </div>
  );
}

function SystemCard(props: {
  title: string;
  body: string;
  meta?: string;
  children?: ReactNode;
}) {
  return (
    <div className="msg msg--orca">
      <OrcaMark />
      <div className="msg-body">
        <div className="mono msg-meta">orca</div>
        <div className="orca-chat-system-card">
          <p className="orca-chat-system-title">{props.title}</p>
          <p className="msg-text">{props.body}</p>
          {props.meta && <p className="orca-chat-system-meta mono">{props.meta}</p>}
          {props.children}
        </div>
      </div>
    </div>
  );
}

function ThinkingRow({ label }: { label: string }) {
  return (
    <div className="msg msg--orca">
      <OrcaMark />
      <div className="thinking-bubble">
        <span className="thinking-label">{label}</span>
        <span className="thinking-dots">
          <span style={{ animationDelay: "0s" }} />
          <span style={{ animationDelay: "0.18s" }} />
          <span style={{ animationDelay: "0.36s" }} />
        </span>
      </div>
    </div>
  );
}

function OrcaMark() {
  return (
    <div className="orca-mark" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="1.6" fill="#fff" />
        <circle cx="7" cy="7" r="3.5" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1" />
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="rgba(255,255,255,0.30)" strokeWidth="1" />
      </svg>
    </div>
  );
}

function sortByCreatedAtDesc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function sortRecommendations(items: Recommendation[]): Recommendation[] {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function findAcceptedPendingInput(
  recommendations: Recommendation[],
  currentStepRunId: string | null,
): PendingInputPrompt | null {
  if (!currentStepRunId) return null;
  for (const recommendation of recommendations) {
    if (
      recommendation.type === "request_user_input" &&
      recommendation.status === "accepted" &&
      recommendation.workflowStepRunId === currentStepRunId &&
      recommendation.proposedAction.kind === "request_user_input"
    ) {
      return {
        question: recommendation.proposedAction.question,
        stepRunId: recommendation.proposedAction.workflowStepRunId,
        recommendationId: recommendation.id,
      };
    }
  }
  return null;
}

function isWorkflowRecommendation(recommendation: Recommendation): boolean {
  return WORKFLOW_RECOMMENDATION_TYPE_SET.has(recommendation.type);
}

function adapterIdFromOperator(operatorId: string, operatorKind: string): string | null {
  if (operatorKind !== "agent") return null;
  if (!operatorId.startsWith("agent:")) return null;
  return operatorId.slice("agent:".length);
}

function roleForWorkflowStep(stepTemplateId: string | null): string {
  if (stepTemplateId === "review") return "reviewer";
  if (stepTemplateId === "qa") return "reviewer";
  return "engineer";
}

function formatStepLabel(stepTemplateId: string): string {
  return stepTemplateId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
