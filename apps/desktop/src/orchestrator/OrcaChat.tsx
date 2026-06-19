import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  Activity,
  Goal,
  GoalDetailResponse,
  OrchestratorChatMessage,
  WorkflowArtifact,
  WorkflowDecisionTrace,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowTemplate,
} from "@orca/contracts";

import type { ConnectionStatus } from "../api";
import {
  confirmStep,
  createOrchestratorMessage,
  getGoalDetail,
  getWorkflowRun,
  getWorkflowStepRun,
  getWorkflowTemplate,
  listActivities,
  listOrchestratorMessages,
  listWorkflowDecisions,
  listWorkflowRunArtifacts,
  listWorkflowTemplates,
  openEventStream,
  requestNextOrchestratorDecision,
  submitWorkerAnswers,
  submitWorkerFreeText,
  startWorkflowRun,
  toErrorMessage,
} from "../api";
import {
  ActivityCard,
  LiveActivity,
  isAgentActivityCard,
  isTimelineCard,
  pickLiveActivity,
} from "./ActivityThread";
import { AgentActivity } from "./AgentActivity";
import { PermissionApprovalCard } from "./PermissionApprovalCard";
import { ProviderRecoveryCard } from "./ProviderRecoveryCard";
import { WorkerPermissionToggle } from "./WorkerPermissionToggle";
import { WorkflowTracker, type TrackerStep } from "./components/WorkflowTracker";
import "./orca-chat.css";

type Props = {
  goals: Goal[];
  selectedGoalId: string | null;
  connectionStatus: ConnectionStatus;
  onViewWorkflows?: () => void;
};

type WorkflowState = {
  detail: GoalDetailResponse | null;
  run: WorkflowRun | null;
  stepRun: WorkflowStepRun | null;
  stepName: string | null;
  template: WorkflowTemplate | null;
  decisions: WorkflowDecisionTrace[];
  artifacts: WorkflowArtifact[];
};

type ActivityState = {
  goalId: string | null;
  items: Activity[];
};

// A single chronological entry in the chat: either an orchestrator/user message
// or a terminal activity card. Merging both streams by createdAt keeps step
// result cards interleaved with messages in the order things actually happened.
type TimelineEntry =
  | { kind: "message"; at: string; key: string; message: OrchestratorChatMessage }
  | { kind: "card"; at: string; key: string; activity: Activity };

const EMPTY_WORKFLOW_STATE: WorkflowState = {
  detail: null,
  run: null,
  stepRun: null,
  stepName: null,
  template: null,
  decisions: [],
  artifacts: [],
};

const EMPTY_ACTIVITY_STATE: ActivityState = {
  goalId: null,
  items: [],
};

export function OrcaChat({ goals, selectedGoalId, connectionStatus, onViewWorkflows }: Props) {
  const [workflowState, setWorkflowState] = useState<WorkflowState>(EMPTY_WORKFLOW_STATE);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [recoveryExpanded, setRecoveryExpanded] = useState(false);
  const [recoveryTemplateId, setRecoveryTemplateId] = useState<string | null>(null);
  const [recoveryTemplates, setRecoveryTemplates] = useState<WorkflowTemplate[]>([]);
  const [recoveryTemplatesLoaded, setRecoveryTemplatesLoaded] = useState(false);
  const [activityState, setActivityState] = useState<ActivityState>(EMPTY_ACTIVITY_STATE);
  const [messages, setMessages] = useState<OrchestratorChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [answeredQuestionId, setAnsweredQuestionId] = useState<string | null>(null);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track which goal each data set has already loaded for, so SSE-driven
  // refetches refresh silently (keeping stale content) instead of flipping the
  // loading flags on every event.
  const messagesLoadedGoalRef = useRef<string | null>(null);
  const workflowLoadedGoalRef = useRef<string | null>(null);
  // Track which goal we've already scrolled to the bottom for, so the chat opens
  // pinned to the latest message on first view without re-jumping on every SSE refresh.
  const scrolledGoalRef = useRef<string | null>(null);
  // Last message id we scrolled for, so we re-pin to the bottom when a new
  // message arrives (user send or orca reply) but not on unrelated refreshes.
  const scrolledMessageIdRef = useRef<string | null>(null);

  const selectedGoal = goals.find((goal) => goal.id === selectedGoalId) ?? null;
  const connected = connectionStatus === "open";
  const activities =
    activityState.goalId === selectedGoalId ? activityState.items : [];

  useEffect(() => {
    setActionError(null);
    setMessageError(null);
    setAwaitingReply(false);
    scrolledGoalRef.current = null;
    scrolledMessageIdRef.current = null;
  }, [selectedGoalId]);

  // Pin the scroll to the latest message on first view of a goal's chat, and
  // again whenever a new message arrives (user send or orca reply). Unrelated
  // SSE refreshes that don't change the last message leave scroll alone.
  useEffect(() => {
    if (!selectedGoalId) return;
    if (messagesLoading) return;
    if (messagesLoadedGoalRef.current !== selectedGoalId) return;
    const lastId = messages[messages.length - 1]?.id ?? null;
    const firstView = scrolledGoalRef.current !== selectedGoalId;
    if (!firstView && scrolledMessageIdRef.current === lastId) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    scrolledGoalRef.current = selectedGoalId;
    scrolledMessageIdRef.current = lastId;
  }, [selectedGoalId, messagesLoading, messages]);

  useEffect(() => {
    if (!recoveryExpanded) return;
    if (recoveryTemplatesLoaded) return;
    let cancelled = false;
    listWorkflowTemplates()
      .then((res) => {
        if (!cancelled) {
          setRecoveryTemplates(res.templates);
          setRecoveryTemplatesLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setRecoveryTemplatesLoaded(true); // show empty
      });
    return () => { cancelled = true; };
  }, [recoveryExpanded, recoveryTemplatesLoaded]);

  useEffect(() => {
    if (!selectedGoalId) {
      setMessages([]);
      setMessagesLoading(false);
      setMessageError(null);
      setMessageDraft("");
      messagesLoadedGoalRef.current = null;
      return;
    }

    const goalId = selectedGoalId;
    let cancelled = false;
    // Only show the loader on the first load for this goal; later refetches
    // (SSE refresh) keep the current messages on screen.
    if (messagesLoadedGoalRef.current !== goalId) setMessagesLoading(true);
    setMessageError(null);

    async function loadMessages() {
      try {
        const response = await listOrchestratorMessages(goalId);
        if (!cancelled) {
          setMessages(response.messages);
          messagesLoadedGoalRef.current = goalId;
          const lastMsg = response.messages[response.messages.length - 1] ?? null;
          if (lastMsg && lastMsg.role !== "user") {
            setAwaitingReply(false);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setMessageError(toErrorMessage(err, "Failed to load orchestrator messages."));
          setMessages([]);
        }
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    }

    void loadMessages();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, selectedGoalId]);

  useEffect(() => {
    if (!selectedGoalId) {
      setActivityState(EMPTY_ACTIVITY_STATE);
      return;
    }

    const goalId = selectedGoalId;
    let cancelled = false;

    async function loadActivities() {
      try {
        const nextActivities = await listActivities(goalId);
        if (!cancelled) {
          setActivityState({ goalId, items: nextActivities });
          if (
            nextActivities.some(
              (activity) =>
                activity.status === "paused_for_input" &&
                (activity.sourceKind === "step_confirmation_pending" ||
                  activity.sourceKind === "provider_recovery_pending"),
            )
          ) {
            setAwaitingReply(false);
          }
        }
      } catch {
        if (!cancelled) {
          setActivityState((current) =>
            current.goalId === goalId ? current : { goalId, items: [] },
          );
        }
      }
    }

    void loadActivities();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, selectedGoalId]);

  useEffect(() => {
    if (!selectedGoalId) {
      setWorkflowState(EMPTY_WORKFLOW_STATE);
      setLoading(false);
      setError(null);
      workflowLoadedGoalRef.current = null;
      return;
    }
    const goalId = selectedGoalId;

    let cancelled = false;
    // Only block with the loader on the first load for this goal; SSE-driven
    // refetches refresh the workflow state silently.
    if (workflowLoadedGoalRef.current !== goalId) setLoading(true);
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
            stepName: null,
            template: null,
            decisions: [],
            artifacts: [],
          });
          workflowLoadedGoalRef.current = goalId;
          return;
        }

        const [runResponse, decisionsResponse, artifactsResponse] = await Promise.all([
          getWorkflowRun(goalId, runId),
          listWorkflowDecisions(goalId, runId),
          listWorkflowRunArtifacts(goalId, runId),
        ]);
        if (cancelled) return;

        const stepRun = runResponse.run.currentStepRunId
          ? (await getWorkflowStepRun(goalId, runResponse.run.currentStepRunId)).stepRun
          : null;
        if (cancelled) return;

        // Load the run's template so the workflow tracker can render its full
        // step list, and resolve the current step's human name (e.g. "Build It").
        // Non-critical enrichment: on any failure we leave template/stepName null
        // and the starting indicator falls back to an ordinal-only label.
        let template: WorkflowTemplate | null = null;
        let stepName: string | null = null;
        try {
          const templateResponse = await getWorkflowTemplate(runResponse.run.templateId);
          if (cancelled) return;
          template = templateResponse.template;
          if (stepRun) {
            stepName =
              template.steps.find((step) => step.id === stepRun.stepTemplateId)?.name ?? null;
          }
        } catch {
          template = null;
          stepName = null;
        }

        setWorkflowState({
          detail,
          run: runResponse.run,
          stepRun,
          stepName,
          template,
          decisions: sortByCreatedAtDesc(decisionsResponse.decisions),
          artifacts: sortByCreatedAtDesc(artifactsResponse.artifacts),
        });
        workflowLoadedGoalRef.current = goalId;
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
          event.type === "orchestrator.message.created" ||
          event.type === "activity.changed" ||
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

  const currentStepRunId = workflowState.stepRun?.id ?? null;

  const latestCompletion = (() => {
    if (!currentStepRunId) return null;
    const outputs = workflowState.artifacts.filter(
      (a) => a.type === "step_output" && a.stepRunId === currentStepRunId,
    );
    const latest = outputs[outputs.length - 1];
    if (!latest) return null;
    try {
      const body = JSON.parse(latest.body) as {
        _completion?: {
          confidence: string;
          assumptions: string[];
          openQuestions: string[];
          whyComplete: string;
        };
      };
      return body._completion ?? null;
    } catch {
      return null;
    }
  })();

  const hasModel = Boolean(
    workflowState.detail?.goal.orchestratorProvider &&
      workflowState.detail?.goal.orchestratorModel,
  );

  // Show a "step is starting…" indicator during the agent's first-turn latency:
  // the run and step are active but Orca has not posted anything into the chat
  // yet. Clears automatically once the first turn lands.
  const orcaHasSpoken = messages.some((message) => message.role === "orchestrator");
  const liveActivity = pickLiveActivity(activities);
  const hasLiveActivity = liveActivity !== null;

  // Once the resolved question leaves the live slot (backend caught up), stop
  // suppressing — a later, different question must be allowed to render.
  useEffect(() => {
    if (
      answeredQuestionId != null &&
      liveActivity?.pendingQuestion?.questionId !== answeredQuestionId
    ) {
      setAnsweredQuestionId(null);
    }
  }, [liveActivity?.pendingQuestion?.questionId, answeredQuestionId]);
  // Suppress the "starting" indicator once any persisted agent-activity card is
  // present — the agent has already emitted steps, so there is nothing to wait for.
  const hasAgentActivityCard = activities.some(isAgentActivityCard);
  const showStarting =
    workflowState.run?.status === "active" &&
    workflowState.stepRun?.status === "active" &&
    // The final step run stays "active" with finished_at set while the run waits
    // for completion approval; a finished step is done, not starting.
    workflowState.stepRun?.finishedAt == null &&
    !orcaHasSpoken &&
    !hasLiveActivity &&
    !hasAgentActivityCard;
  // While the indicator is up, tick once a second so the elapsed time advances.
  useEffect(() => {
    if (!showStarting) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [showStarting]);

  const startingElapsed =
    workflowState.stepRun?.startedAt != null
      ? formatElapsed(nowMs - Date.parse(workflowState.stepRun.startedAt))
      : null;
  // Workflow tracker data: the run's full step list plus which step the
  // Conductor is currently on, derived from the active step run (not a progress
  // heuristic — the run knows its exact current step).
  const sortedSteps = workflowState.template
    ? [...workflowState.template.steps].sort((left, right) => left.ordinal - right.ordinal)
    : [];
  const trackerSteps: TrackerStep[] = sortedSteps.map((step) => ({
    name: step.name,
    role: step.agentPreference?.[0]?.adapterId,
  }));
  const trackerActiveIndex = (() => {
    if (sortedSteps.length === 0) return 0;
    const byId = workflowState.stepRun
      ? sortedSteps.findIndex((step) => step.id === workflowState.stepRun?.stepTemplateId)
      : -1;
    const raw = byId >= 0 ? byId : workflowState.stepRun?.ordinal ?? 0;
    return Math.min(sortedSteps.length - 1, Math.max(0, raw));
  })();
  // The current step pulses "running" only while its step run is genuinely
  // executing. Once it finishes — most notably the terminal step, which passes
  // but parks the run "active" awaiting completion approval rather than
  // auto-completing (see daemon advanceToNextStepOrGate) — it must stop pulsing.
  const activeStepRunning =
    workflowState.stepRun?.status === "active" && workflowState.stepRun?.finishedAt == null;
  // The workflow has done all its work once the final step has passed. A truly
  // completed run detaches from the goal (active_workflow_run_id is nulled), so
  // the run we can still see here is parked on the passed terminal step. Treat
  // that as completion for the tracker header and the chat notice, which would
  // otherwise go silent after the last step.
  const workflowFinished =
    workflowState.stepRun?.status === "passed" &&
    trackerActiveIndex === sortedSteps.length - 1;
  const showTracker = workflowState.run !== null && trackerSteps.length > 0;

  const startingLabel = workflowState.stepRun
    ? `Step ${workflowState.stepRun.ordinal + 1}${
        workflowState.stepName ? ` · ${workflowState.stepName}` : ""
      } — starting${startingElapsed ? ` ${startingElapsed}` : "…"}`
    : "";

  // Merge messages and terminal activity cards into one timeline ordered by
  // createdAt (id breaks ties), so a step-result card lands between the messages
  // it actually occurred between instead of after every message.
  const timeline: TimelineEntry[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      at: message.createdAt,
      key: `m:${message.id}`,
      message,
    })),
    ...activities.filter(isTimelineCard).map((activity) => ({
      kind: "card" as const,
      at: activity.createdAt,
      key: `a:${activity.id}`,
      activity,
    })),
  ].sort((left, right) =>
    left.at === right.at
      ? left.key.localeCompare(right.key)
      : left.at.localeCompare(right.at),
  );

  async function handleRecoveryStart() {
    if (!selectedGoalId || !recoveryTemplateId) return;
    setStarting(true);
    setActionError(null);
    try {
      const runResponse = await startWorkflowRun(selectedGoalId, {
        goalId: selectedGoalId,
        templateId: recoveryTemplateId,
      });
      await requestNextOrchestratorDecision(selectedGoalId, runResponse.run.id, {
        workflowRunId: runResponse.run.id,
      });
      setRefreshNonce((current) => current + 1);
      setRecoveryExpanded(false);
      setRecoveryTemplateId(null);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to start workflow."));
    } finally {
      setStarting(false);
    }
  }

  async function handleContinue(runId: string) {
    try {
      await confirmStep(runId);
    } finally {
      setRefreshNonce((current) => current + 1);
    }
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedGoalId) return;
    const body = messageDraft.trim();
    if (!body) return;

    const liveQuestionId = liveActivity?.pendingQuestion?.questionId ?? null;
    if (liveQuestionId) {
      setSendingMessage(true);
      setMessageError(null);
      try {
        await submitWorkerFreeText(selectedGoalId, liveQuestionId, body);
        setAnsweredQuestionId(liveQuestionId);
        setMessageDraft("");
      } catch (err) {
        setMessageError(toErrorMessage(err, "Failed to send your answer."));
      } finally {
        setSendingMessage(false);
      }
      return;
    }

    setSendingMessage(true);
    setMessageError(null);
    try {
      const response = await createOrchestratorMessage(selectedGoalId, { body });
      setMessages((current) =>
        appendMessages(
          current,
          response.reply ? [response.message, response.reply] : [response.message]
        )
      );
      if (response.reply == null) {
        setAwaitingReply(true);
      }
      setMessageDraft("");
    } catch (err) {
      setMessageError(toErrorMessage(err, "Failed to send message to Orca."));
    } finally {
      setSendingMessage(false);
    }
  }

  return (
    <div className="orca-chat-tab">
      {showTracker && workflowState.template && (
        <WorkflowTracker
          workflowName={workflowState.template.name}
          steps={trackerSteps}
          activeIndex={trackerActiveIndex}
          activeRunning={activeStepRunning}
          completed={workflowFinished}
          onViewWorkflows={onViewWorkflows}
        />
      )}
      <div className="orca-chat">
        <div className="orca-chat-scroll scroll" ref={scrollRef}>
        {!selectedGoal && (
          <SystemCard
            title="Select a goal"
            body="Choose a goal from the rail to start or continue its Engineering workflow."
          />
        )}

        {selectedGoal && (
          <>
            <WorkerPermissionToggle
              goalId={selectedGoal.id}
              mode={selectedGoal.workerPermissionMode}
              disabled={!connected}
            />

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
                  title="No workflow running"
                  body="This goal has no active workflow run. Start one to begin orchestration."
                >
                  {!recoveryExpanded ? (
                    <button
                      type="button"
                      className="submit-button"
                      onClick={() => setRecoveryExpanded(true)}
                      disabled={!connected}
                    >
                      Start Workflow
                    </button>
                  ) : (
                    <div className="orca-chat-recovery-form">
                      {!recoveryTemplatesLoaded ? (
                        <p className="form-hint">Loading workflows…</p>
                      ) : recoveryTemplates.length === 0 ? (
                        <p className="form-hint">No workflows available. Create one in the Workflows tab.</p>
                      ) : (
                        <>
                          <select
                            value={recoveryTemplateId ?? ""}
                            onChange={(e) => setRecoveryTemplateId(e.target.value || null)}
                          >
                            <option value="" disabled>Choose workflow…</option>
                            {recoveryTemplates.map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="submit-button"
                            onClick={() => void handleRecoveryStart()}
                            disabled={!connected || starting || recoveryTemplateId === null}
                          >
                            {starting ? "Starting…" : "Start"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </SystemCard>
              )}

            {latestCompletion && (
              <div className="orca-chat-completion">
                <span className="orca-chat-completion-confidence workflow-banner-subtitle">
                  Step complete · confidence: {latestCompletion.confidence}
                </span>
                <p className="orca-chat-completion-why">{latestCompletion.whyComplete}</p>
                {latestCompletion.assumptions.length > 0 && (
                  <details className="orca-chat-completion-details">
                    <summary className="workflow-banner-subtitle">
                      Assumptions ({latestCompletion.assumptions.length})
                    </summary>
                    <ul>
                      {latestCompletion.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {latestCompletion.openQuestions.length > 0 && (
                  <details className="orca-chat-completion-details">
                    <summary className="workflow-banner-subtitle">
                      Open questions ({latestCompletion.openQuestions.length})
                    </summary>
                    <ul>
                      {latestCompletion.openQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {actionError && (
              <div className="form-error" role="alert">
                {actionError}
              </div>
            )}

            {timeline.map((entry) =>
              entry.kind === "message" ? (
                <ChatMessageRow
                  key={entry.key}
                  message={entry.message}
                  goalId={selectedGoalId ?? ""}
                />
              ) : entry.activity.sourceKind === "step_result" ? (
                <ActivityCard key={entry.key} activity={entry.activity} />
              ) : (
                <AgentActivity key={entry.key} activity={entry.activity} />
              )
            )}

            {workflowFinished && (
              <SystemCard
                title="Workflow complete"
                body={`Orca finished every step of the ${
                  workflowState.template?.name ?? "workflow"
                }.`}
              />
            )}

            {/* Tail indicators: the live agent bubble, the first-turn "starting"
                hint, and the orchestrator "thinking" dots all pin to the bottom
                of the timeline so they trail the most recent activity. */}
            {liveActivity &&
              !(
                liveActivity.pendingQuestion != null &&
                liveActivity.pendingQuestion.questionId === answeredQuestionId
              ) && (
              <LiveActivity
                goalId={selectedGoalId ?? ""}
                activity={liveActivity}
                renderQuestionForm={(props) => (
                  <WorkerQuestionForm
                    {...props}
                    onSubmitFreeText={async (text) => {
                      await submitWorkerFreeText(selectedGoalId ?? "", props.pending.questionId, text);
                      setAnsweredQuestionId(props.pending.questionId);
                    }}
                  />
                )}
                renderProviderRecovery={({ runId, recovery }) => (
                  <ProviderRecoveryCard
                    runId={runId}
                    recovery={recovery}
                    onChanged={() => setRefreshNonce((current) => current + 1)}
                  />
                )}
                onContinue={handleContinue}
              />
            )}

            {showStarting && (
              <div data-testid="step-starting">
                <ThinkingRow label={startingLabel} />
              </div>
            )}

            {/* Show Orca is working from the moment the send is in flight
                (covers the blocking one_shot path) through the async wait for a
                deferred reply (shadow_session / active-run, reply:null). */}
            {(sendingMessage || awaitingReply) && (
              <div data-testid="awaiting-reply">
                <RoutingCard />
              </div>
            )}

            {messageError && (
              <div className="form-error" role="alert">
                {messageError}
              </div>
            )}
          </>
        )}
      </div>

      {selectedGoal && (
        <form
          ref={composerFormRef}
          className="orca-chat-composer"
          onSubmit={(event) => void handleSendMessage(event)}
        >
          <div className="orca-chat-input-wrapper">
            <svg
              className="orca-chat-input-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z" />
            </svg>
            <textarea
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  composerFormRef.current?.requestSubmit();
                }
              }}
              rows={2}
              placeholder="Message Orca…"
              disabled={!connected || sendingMessage}
            />
            <div className="orca-chat-compose-actions">
              <span className="mono orca-chat-send-hint">↵ send</span>
              <button
                type="submit"
                className={`orca-chat-send${messageDraft.trim() && !sendingMessage ? " orca-chat-send--active" : ""}`}
                disabled={!connected || sendingMessage || messageDraft.trim().length === 0}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 12h14" />
                  <path d="M13 5l7 7-7 7" />
                </svg>
                <span className="sr-only">Send</span>
              </button>
            </div>
          </div>
        </form>
      )}
      </div>
    </div>
  );
}

function ChatMessageRow({ message, goalId }: { message: OrchestratorChatMessage; goalId: string }) {
  if (message.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="mono msg-meta">you</div>
        <div className="orca-chat-message orca-chat-message--user">{message.body}</div>
      </div>
    );
  }
  return (
    <div className="msg msg--orca">
      <OrcaMark />
      <div className="msg-body">
        <div className="mono msg-meta">orca</div>
        {/* For a question card the question itself leads; the third-person
            framing body is suppressed so it isn't shown above the question. */}
        {!message.pendingQuestion && <div className="orca-chat-message">{message.body}</div>}
        {message.pendingQuestion && (
          <WorkerQuestionForm
            goalId={goalId}
            pending={message.pendingQuestion}
            onSubmitAnswers={async (answers) => {
              // An orchestrator ask_user: the answer is user guidance. Post it
              // as a user message so it flows through the mediator to the agent.
              const questions = message.pendingQuestion!.questions;
              const body = questions
                .map((q, i) => {
                  const labels = answers.find((a) => a.questionIndex === i)?.selectedLabels ?? [];
                  return `${q.header || q.question}: ${labels.join(", ")}`;
                })
                .join("\n");
              await createOrchestratorMessage(goalId, { body });
            }}
          />
        )}
        {message.pendingApproval && (
          <PermissionApprovalCard goalId={goalId} pending={message.pendingApproval} />
        )}
      </div>
    </div>
  );
}

type WorkerAnswer = { questionIndex: number; selectedLabels: string[] };

function WorkerQuestionForm({
  goalId,
  pending,
  onSubmitAnswers,
  onSubmitFreeText,
}: {
  goalId: string;
  pending: NonNullable<OrchestratorChatMessage["pendingQuestion"]>;
  // Override the submit path. Default submits to the worker-question endpoint
  // (an agent's live AskUserQuestion). Orchestrator ask_user questions pass a
  // handler that posts the answer back as user guidance instead.
  onSubmitAnswers?: (answers: WorkerAnswer[]) => Promise<void>;
  // Live worker questions also accept a free-text answer ("Something else").
  // Provided only on the live-activity path; absent for orchestrator ask_user.
  onSubmitFreeText?: (text: string) => Promise<void>;
}) {
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [freeTextSelected, setFreeTextSelected] = useState(false);
  const [freeText, setFreeText] = useState("");
  const singleQuestion = pending.questions.length === 1;
  const offerFreeText = singleQuestion && onSubmitFreeText != null;

  useEffect(() => {
    setSelections({});
    setSubmitted(false);
    setExpired(false);
    setFreeTextSelected(false);
    setFreeText("");
  }, [pending.questionId]);

  function toggle(qIndex: number, label: string, multi: boolean) {
    setFreeTextSelected(false);
    setSelections((prev) => {
      const current = prev[qIndex] ?? [];
      if (multi) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
        return { ...prev, [qIndex]: next };
      }
      return { ...prev, [qIndex]: [label] };
    });
  }

  function chooseFreeText() {
    setSelections({});
    setFreeTextSelected(true);
  }

  const optionsAnswered = pending.questions.every((_, i) => (selections[i]?.length ?? 0) > 0);
  const canSubmit = freeTextSelected ? freeText.trim().length > 0 : optionsAnswered;

  async function handleSubmit() {
    const answers = pending.questions.map((_, i) => ({ questionIndex: i, selectedLabels: selections[i] ?? [] }));
    setSubmitted(true);
    try {
      if (freeTextSelected && onSubmitFreeText) await onSubmitFreeText(freeText.trim());
      else if (onSubmitAnswers) await onSubmitAnswers(answers);
      else await submitWorkerAnswers(goalId, pending.questionId, answers);
    } catch {
      setSubmitted(false);
      setExpired(true);
    }
  }

  return (
    <div className="orca-chat-question">
      <div className="orca-chat-question-header">
        <svg
          className="orca-chat-question-header-icon"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        <span>Question</span>
      </div>
      {pending.questions.map((q, qi) => (
        <fieldset key={qi} className="orca-chat-question-block" disabled={submitted}>
          <legend className="orca-chat-question-legend">
            {pending.questions.length > 1 && <span className="orca-chat-question-index">{qi + 1} · </span>}<span>{q.question}</span>
          </legend>
          {q.options.map((opt, oi) => {
            const chosen = (selections[qi] ?? []).includes(opt.label);
            const recommendedSuffix = " (Recommended)";
            const recommended = opt.label.endsWith(recommendedSuffix);
            const displayLabel = recommended
              ? opt.label.slice(0, -recommendedSuffix.length)
              : opt.label;
            return (
              <label key={oi} className="orca-chat-option-row">
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`${pending.questionId}-${qi}`}
                  aria-label={opt.label}
                  checked={chosen}
                  onChange={() => toggle(qi, opt.label, q.multiSelect)}
                />
                <span className="orca-chat-option-content">
                  <span className="orca-chat-option-head">
                    <span className="orca-chat-option-label">
                      {submitted && chosen ? "✓ " : ""}
                      {displayLabel}
                    </span>
                    {recommended ? (
                      <span className="workflow-decision-badge">Recommended</span>
                    ) : null}
                  </span>
                  {opt.description ? <span className="orca-chat-option-desc">{opt.description}</span> : null}
                </span>
              </label>
            );
          })}
          {offerFreeText && qi === pending.questions.length - 1 ? (
            <>
              <label className="orca-chat-option-row">
                <input
                  type="radio"
                  name={`${pending.questionId}-${qi}`}
                  aria-label="Something else"
                  checked={freeTextSelected}
                  onChange={chooseFreeText}
                />
                <span className="orca-chat-option-content">
                  <span className="orca-chat-option-head">
                    <span className="orca-chat-option-label">Something else</span>
                  </span>
                  <span className="orca-chat-option-desc">Write your own response instead of picking an option.</span>
                </span>
              </label>
              {freeTextSelected ? (
                <textarea
                  className="orca-chat-option-freetext"
                  value={freeText}
                  placeholder="Type your own answer…"
                  rows={2}
                  disabled={submitted}
                  onChange={(e) => setFreeText(e.target.value)}
                />
              ) : null}
            </>
          ) : null}
        </fieldset>
      ))}
      <button
        type="button"
        className="orca-chat-question-submit"
        disabled={submitted || !canSubmit}
        onClick={() => void handleSubmit()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14" />
          <path d="M13 5l7 7-7 7" />
        </svg>
        <span>{submitted ? "Sent" : "Send answer"}</span>
      </button>
      {expired && <p className="form-error" role="alert">This question expired.</p>}
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

function RoutingCard() {
  return (
    <div className="msg msg--orca">
      <OrcaMark />
      <div className="agent-activity" data-testid="routing-card">
        <div className="agent-activity-steps">
          <div className="agent-activity-step">
            <svg className="agent-activity-check" width="13" height="13" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="agent-activity-step-text is-done">Reading your message</span>
          </div>
          <div className="agent-activity-step">
            <span className="thinking-dots agent-activity-pulse" aria-hidden>
              <span style={{ animationDelay: "0s" }} />
              <span style={{ animationDelay: "0.18s" }} />
              <span style={{ animationDelay: "0.36s" }} />
            </span>
            <span className="agent-activity-step-text">Working out a response</span>
          </div>
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

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function sortByCreatedAtDesc<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function appendMessages(
  current: OrchestratorChatMessage[],
  incoming: OrchestratorChatMessage[],
): OrchestratorChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created === 0 ? left.id.localeCompare(right.id) : created;
  });
}
