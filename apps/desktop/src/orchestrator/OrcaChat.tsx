import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  Activity,
  ActivityDiff,
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
  acceptRecommendation,
  confirmSplit,
  confirmStep,
  createOrchestratorMessage,
  decideGate,
  getGoalDetail,
  getWorkflowRun,
  getWorkflowStepRun,
  getWorkflowTemplate,
  interruptStep,
  listActivities,
  listOrchestratorMessages,
  listWorkflowDecisions,
  listWorkflowRunArtifacts,
  listWorkflowRuns,
  listWorkflowStepRuns,
  listWorkflowTemplates,
  openEventStream,
  requestNextOrchestratorDecision,
  requestStepRevision,
  runGoalCommand,
  submitStepRevision,
  submitWorkerAnswers,
  submitOrchestratorAnswer,
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
import { OrcaMark as OrcaLogo } from "../onboarding/glyphs";
import { useTheme } from "../theme/ThemeProvider";
import { AgentActivity, CodeChangeCard } from "./AgentActivity";
import { PermissionApprovalCard } from "./PermissionApprovalCard";
import { ProviderRecoveryCard } from "./ProviderRecoveryCard";
import { WorkerPermissionToggle } from "./WorkerPermissionToggle";
import { WorkflowTracker, type TrackerStep } from "./components/WorkflowTracker";
import { matchSlashCommands, parseSlashCommand } from "./slash-commands";
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
  // Template step ids that actually ran (have a step run). Steps in the template
  // but absent here were routed past (skipped) — the tracker renders them muted.
  executedStepIds: string[];
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
  | { kind: "card"; at: string; key: string; activity: Activity }
  | { kind: "diff"; at: string; key: string; diff: ActivityDiff; caption: string };

const EMPTY_WORKFLOW_STATE: WorkflowState = {
  detail: null,
  run: null,
  stepRun: null,
  stepName: null,
  template: null,
  decisions: [],
  artifacts: [],
  executedStepIds: [],
};

const EMPTY_ACTIVITY_STATE: ActivityState = {
  goalId: null,
  items: [],
};

export function OrcaChat({ goals, selectedGoalId, connectionStatus, onViewWorkflows }: Props) {
  const [workflowState, setWorkflowState] = useState<WorkflowState>(EMPTY_WORKFLOW_STATE);
  const [refreshNonce, setRefreshNonce] = useState(0);
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
  const [answerPendingSince, setAnswerPendingSince] = useState<number | null>(null);
  const [awaitingReply, setAwaitingReply] = useState(false);
  // In-flight flag while accepting the complete_workflow_run recommendation.
  const [approvingCompletion, setApprovingCompletion] = useState(false);
  // In-flight flag while submitting a human gate approve/reject decision.
  const [decidingGate, setDecidingGate] = useState(false);
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
  // Last tail card (live confirmation/step card or terminal card) we scrolled for,
  // so a newly-arrived card jumps into view exactly once.
  const scrolledTailKeyRef = useRef<string | null>(null);
  // True while the user is at (or near) the bottom of the chat. Streaming steps
  // grow the tail card in place under the same activity id, so the discrete-event
  // scroll effects below never re-fire for them. We follow that growth to the
  // bottom while pinned, and leave the user alone once they scroll up to read.
  const pinnedToBottomRef = useRef(true);

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
    scrolledTailKeyRef.current = null;
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

  // The transient "Thinking…" row after an answer is a tail element, not a
  // message, so the message-change scroll above doesn't fire — and an answered
  // question no longer posts a user bubble to trigger it. Pin it into view.
  useEffect(() => {
    if (answerPendingSince == null) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [answerPendingSince]);

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

        let runId = detail.goal.activeWorkflowRunId;
        // A completed run detaches from its goal (active_workflow_run_id is
        // nulled), so a completed goal has no active run id. Load its most-recent
        // run (runs are ordered newest-first) so the tracker shows the finished
        // workflow instead of the "no workflow running" empty state.
        if (!runId && detail.goal.status === "completed") {
          try {
            const runsResponse = await listWorkflowRuns(goalId);
            if (cancelled) return;
            runId = runsResponse.runs[0]?.id ?? null;
          } catch {
            runId = null;
          }
        }
        if (!runId) {
          setWorkflowState({
            detail,
            run: null,
            stepRun: null,
            stepName: null,
            template: null,
            decisions: [],
            artifacts: [],
            executedStepIds: [],
          });
          workflowLoadedGoalRef.current = goalId;
          return;
        }

        const [runResponse, decisionsResponse, artifactsResponse, stepRunsResponse] = await Promise.all([
          getWorkflowRun(goalId, runId),
          listWorkflowDecisions(goalId, runId),
          listWorkflowRunArtifacts(goalId, runId),
          listWorkflowStepRuns(goalId, runId),
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
          executedStepIds: stepRunsResponse.stepRuns.map((s) => s.stepTemplateId),
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
          event.type === "orchestrator.message.updated" ||
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

  const liveActivity = pickLiveActivity(activities);
  const hasLiveActivity = liveActivity !== null;

  // A step-result / confirmation card (Continue / Revise) arrives through the
  // activity stream — as a live tail activity or a terminal timeline card — not as a
  // chat message, so the message-change scroll above never fires for it. Without this
  // the card lands below the fold and the user never sees it sitting there awaiting
  // an action. Pin to the bottom once whenever a new tail card appears.
  const timelineCards = activities.filter(isTimelineCard);
  const lastTimelineCardId = timelineCards.length ? timelineCards[timelineCards.length - 1].id : null;
  const tailCardKey = liveActivity
    ? `live:${liveActivity.id}`
    : lastTimelineCardId
      ? `card:${lastTimelineCardId}`
      : null;
  useEffect(() => {
    if (tailCardKey == null) return;
    if (scrolledTailKeyRef.current === tailCardKey) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    scrolledTailKeyRef.current = tailCardKey;
  }, [tailCardKey]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }

  // Follow streaming content to the bottom while pinned. A running agent appends
  // steps (and grows currentText / diffs) within the SAME activity id, so the
  // discrete-event scroll effects above never fire — the new lines slide below
  // the fold. This re-pins on every content-bearing change, but only when the
  // user was already at the bottom, so it never yanks a reader who scrolled up.
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activities, messages, workflowState, answerPendingSince, sendingMessage, awaitingReply]);

  // Suppress the "starting" indicator once any persisted agent-activity card is
  // present — the agent has already emitted steps, so there is nothing to wait for.
  const hasAgentActivityCard = activities.some(isAgentActivityCard);
  // The orchestrator is between the worker finishing and the step parking:
  // reviewing the output (judge) or running an independent check (refute). This
  // window is otherwise silent, so surface an honest status and let it take
  // precedence over the generic starting/working rows.
  const orchestratorPhase = workflowState.stepRun?.orchestratorPhase ?? null;
  // The worker finished but the orchestrator's evaluation failed (e.g. shadow
  // timeout) and stashed the output awaiting a retry. The step is still `active`
  // but stalled on the human — never claim it is "working".
  const judgePending = workflowState.stepRun?.judgePending === true;
  // "Starting workflow" is a first-moment-of-the-run affordance, so gate it on the
  // run's FIRST step (ordinal 0). Every later step's start-latency uses the generic
  // "Working on {step}…" row instead — otherwise "Starting workflow" wrongly
  // re-fires on step 2+ (its old !orcaHasSpoken gate never flips, since step
  // completions are cards, not orchestrator messages).
  const showStarting =
    workflowState.run?.status === "active" &&
    workflowState.stepRun?.status === "active" &&
    // The final step run stays "active" with finished_at set while the run waits
    // for completion approval; a finished step is done, not starting.
    workflowState.stepRun?.finishedAt == null &&
    workflowState.stepRun?.ordinal === 0 &&
    orchestratorPhase == null &&
    answerPendingSince == null &&
    !hasLiveActivity &&
    !hasAgentActivityCard;

  // ANY unanswered pending question (worker OR orchestrator source) means the step
  // is parked on the human, not working — a step's AskUserQuestion can surface as
  // "orchestrator" source (observed live), and claiming it is "working" while it
  // waits on the user is dishonest.
  const pendingAnyQuestionId =
    [...messages].reverse().find(
      (m) => m.pendingQuestion != null && m.pendingQuestion.answer == null && !m.pendingQuestion.withdrawn,
    )?.pendingQuestion?.questionId ?? null;

  const pendingRevisionRunId =
    [...messages].reverse().find((m) => m.pendingRevision != null)?.pendingRevision?.workflowRunId ?? null;

  function markAnswerPending() {
    setAnswerPendingSince(Date.now());
  }

  // Clear the "Thinking…" tail once something the user can actually see replaces
  // it. Gating on *visible* output (a timeline card, a live activity, or an orca
  // reply) — not any activity — avoids a blank gap when the resumed agent first
  // creates a turn with no steps yet: that activity is neither a timeline card
  // nor a live activity, so the Thinking row must stay up until it has content.
  useEffect(() => {
    if (answerPendingSince == null) return;
    const since = answerPendingSince;
    const newCard = activities.some(
      (a) => isTimelineCard(a) && Date.parse(a.createdAt) > since,
    );
    const newLiveActivity = hasLiveActivity;
    const orcaReplied = messages.some((m) => m.role !== "user" && Date.parse(m.createdAt) > since);
    if (newCard || newLiveActivity || orcaReplied) setAnswerPendingSince(null);
  }, [answerPendingSince, activities, messages, hasLiveActivity]);

  // Safety timeout: clear after 20s in case no event lands.
  useEffect(() => {
    if (answerPendingSince == null) return;
    const id = setTimeout(() => setAnswerPendingSince(null), 20000);
    return () => clearTimeout(id);
  }, [answerPendingSince]);

  // Workflow tracker data: the run's full step list plus which step the
  // Conductor is currently on, derived from the active step run (not a progress
  // heuristic — the run knows its exact current step).
  const sortedSteps = workflowState.template
    ? [...workflowState.template.steps].sort((left, right) => left.ordinal - right.ordinal)
    : [];
  // The tracker shows steps AND gates as their own nodes. Steps are the linear
  // backbone; a gate (a template.graph node of type "gate") is anchored right
  // after the step whose forward edge leads into it (edge.to === gate.id and
  // edge.from === step.id — graph nodes reuse the step id for step nodes). Each
  // tracker item keeps its source id so active/skipped state resolves by id, not
  // by fragile positional remapping. Legacy templates (graph === null) yield
  // steps only, unchanged.
  type GraphNode = NonNullable<WorkflowTemplate["graph"]>["nodes"][number];
  const graph = workflowState.template?.graph ?? null;
  const gatesAfterStep = new Map<string, GraphNode[]>();
  if (graph) {
    for (const node of graph.nodes) {
      if (node.type !== "gate") continue;
      const inEdge = graph.edges.find(
        (e) => e.to === node.id && sortedSteps.some((s) => s.id === e.from),
      );
      if (!inEdge) continue;
      const list = gatesAfterStep.get(inEdge.from) ?? [];
      list.push(node);
      gatesAfterStep.set(inEdge.from, list);
    }
  }
  type TrackerItemSrc = { item: TrackerStep; stepId?: string; gateId?: string; anchorStepId: string };
  const trackerSrc: TrackerItemSrc[] = [];
  for (const step of sortedSteps) {
    trackerSrc.push({
      item: { kind: "step", name: step.name, role: step.agentPreference?.[0]?.adapterId },
      stepId: step.id,
      anchorStepId: step.id,
    });
    for (const gate of gatesAfterStep.get(step.id) ?? []) {
      trackerSrc.push({
        item: {
          kind: "gate",
          name: gate.name || "Gate",
          role: gate.evalSubstrate === "worker" ? gate.agentPreference?.[0]?.adapterId : undefined,
        },
        gateId: gate.id,
        anchorStepId: step.id,
      });
    }
  }
  const trackerSteps: TrackerStep[] = trackerSrc.map((s) => s.item);
  // A run parked at a gate has current_step_run_id = NULL (so workflowState.stepRun
  // is null). Detect it from the run cursor + template graph so the tracker parks
  // the gate's own node "awaiting" instead of falling back to step 0.
  const gateNode =
    workflowState.run?.currentNodeKind === "gate" && workflowState.run.currentNodeId
      ? graph?.nodes.find(
          (node) => node.id === workflowState.run?.currentNodeId && node.type === "gate",
        )
      : undefined;
  const awaitingGate = gateNode != null;
  const trackerActiveIndex = (() => {
    if (trackerSrc.length === 0) return 0;
    if (awaitingGate && gateNode) {
      const gi = trackerSrc.findIndex((s) => s.gateId === gateNode.id);
      if (gi >= 0) return gi;
    }
    const activeStepId = workflowState.stepRun?.stepTemplateId;
    const byId = activeStepId ? trackerSrc.findIndex((s) => s.stepId === activeStepId) : -1;
    if (byId >= 0) return byId;
    // No id match (early load): fall back to the step at the run's ordinal.
    const ord = Math.min(sortedSteps.length - 1, Math.max(0, workflowState.stepRun?.ordinal ?? 0));
    const target = sortedSteps[ord];
    const mi = target ? trackerSrc.findIndex((s) => s.stepId === target.id) : -1;
    return mi >= 0 ? mi : 0;
  })();
  // A step that has produced its output and parked for the human to Continue/
  // Revise emits a step_confirmation_pending activity (status paused_for_input).
  // The step run stays "active" while parked, so without this signal the tracker
  // would pulse "running" over work that has actually stopped.
  const awaitingStepConfirm = activities.some(
    (a) => a.sourceKind === "step_confirmation_pending" && a.status === "paused_for_input",
  );
  // The current step pulses "running" only while its step run is genuinely
  // executing. Once it finishes — most notably the terminal step, which passes
  // but parks the run "active" awaiting completion approval rather than
  // auto-completing (see daemon advanceToNextStepOrGate) — or once it parks for
  // a Continue/Revise confirmation, it must stop pulsing.
  const activeStepRunning =
    workflowState.stepRun?.status === "active" &&
    workflowState.stepRun?.finishedAt == null &&
    !awaitingStepConfirm;
  // The workflow has done all its work once the final step has passed. A truly
  // completed run detaches from the goal (active_workflow_run_id is nulled), so
  // the run we can still see here is parked on the passed terminal step. Treat
  // that as completion for the tracker header and the chat notice, which would
  // otherwise go silent after the last step.
  const lastStepTrackerIndex = (() => {
    for (let i = trackerSrc.length - 1; i >= 0; i--) if (trackerSrc[i].stepId) return i;
    return -1;
  })();
  const workflowFinished =
    workflowState.run?.status === "completed" ||
    (workflowState.stepRun?.status === "passed" &&
      trackerActiveIndex === lastStepTrackerIndex);
  // Derive the approve-to-complete affordance from the persisted activity stream.
  // The daemon emits a mark_done_pending activity (status paused_for_input) that
  // carries the complete_workflow_run recommendation id; no side fetch needed.
  const markDonePending = activities.find(
    (a) => a.sourceKind === "mark_done_pending" && a.status === "paused_for_input",
  );
  const awaitingApproval = markDonePending != null;
  const completionRecId = markDonePending?.recommendationId ?? null;
  // A tracker step the run has already moved past (or, once finished, any step)
  // that produced NO step run was routed past — render it "skipped", not a green
  // completed check. Guarded on having step-run data so a load gap never paints
  // every step as skipped.
  const executedStepIds = new Set(workflowState.executedStepIds);
  const skippedIndices =
    executedStepIds.size === 0
      ? []
      : trackerSrc.reduce<number[]>((acc, src, i) => {
          const behind = workflowFinished || i < trackerActiveIndex;
          // A gate whose source step was routed past renders skipped too, so it
          // never shows a false green "passed" check on a path that didn't run.
          if (behind && !executedStepIds.has(src.anchorStepId)) acc.push(i);
          return acc;
        }, []);
  const showTracker = workflowState.run !== null && trackerSteps.length > 0;
  const runId = workflowState.run?.id ?? null;

  // A blocked run has stopped making progress and is waiting on a human, not on
  // the agent. Surface it explicitly (with the reason) and freeze every "working"
  // affordance so the UI never shows a live spinner over work that has halted.
  const runBlocked = workflowState.run?.status === "blocked";
  const blockedReason = workflowState.run?.blockedReason ?? null;

  // A splitter that couldn't be routed (no deterministic field, no orchestrator
  // decision) escalates to a human routing choice instead of blocking/defaulting.
  const pendingSplitChoice = workflowState.run?.pendingSplitChoice ?? null;

  // Honest live progress for a step's OPENING gap only. A freshly-routed step
  // spends its first seconds generating before it emits any activity; without a
  // signal there the chat looks frozen between a confirmed gate and the next
  // visible card. But once the step has produced ANY activity, its own thread
  // (and the live activity's pulse) carry the "working" signal — so this generic
  // row must retire then, or it lingers redundantly below a streaming thread.
  const activeStepName =
    sortedSteps.find((step) => step.id === workflowState.stepRun?.stepTemplateId)?.name ?? null;
  // Suppress "Working on {step}…" only while the step is CURRENTLY streaming a
  // tool thread (an active activity card carries the signal). Gating on whether
  // the step *ever* produced activity is wrong: it leaves the status dead in the
  // gap between a completed card and the worker's next turn (or between judge and
  // refute) — exactly the flicker we must fill.
  const currentStepStreaming =
    currentStepRunId != null &&
    activities.some((a) => a.stepRunId === currentStepRunId && a.status === "active");
  const showStepWorking =
    activeStepRunning &&
    !awaitingGate &&
    orchestratorPhase == null &&
    !hasLiveActivity &&
    !currentStepStreaming &&
    answerPendingSince == null &&
    // Parked on an unanswered question (worker OR orchestrator source): the step
    // ended its turn and is waiting on the human, so it is NOT working — don't
    // claim otherwise.
    pendingAnyQuestionId == null &&
    !judgePending &&
    !sendingMessage &&
    !awaitingReply &&
    !runBlocked &&
    !showStarting;
  // Honest progress while a gate's reviewer runs. A run parked at a gate has
  // current_step_run_id = NULL, so showStepWorking (which keys off an active
  // stepRun) never fires here. Derive the reviewing window from the run cursor:
  // parked at a gate (awaitingGate) with no verdict surfaced yet
  // (pendingGateReview == null) and no live pause card up (hasLiveActivity flips
  // true the instant the gate parks for a decision). Holds for both substrates —
  // worker (async) and shadow (brief sync eval). Single-bubble invariant: the
  // guards below make this mutually exclusive with every other tail indicator.
  const pendingGateReview = workflowState.run?.pendingGateReview ?? null;
  const gateWorkingName = awaitingGate ? gateNode?.name ?? "Gate" : null;
  const showGateWorking =
    awaitingGate &&
    pendingGateReview == null &&
    !hasLiveActivity &&
    !runBlocked &&
    !showStarting &&
    !sendingMessage &&
    !awaitingReply;
  const orchestratorPhaseLabel =
    orchestratorPhase === "reviewing"
      ? "Reviewing the step output…"
      : orchestratorPhase === "independent_check"
        ? "Running an independent check…"
        : null;
  const showOrchestratorReview =
    orchestratorPhaseLabel != null &&
    workflowState.run?.status === "active" &&
    workflowState.stepRun?.status === "active" &&
    // Once the step has parked (a confirmation / gate / recovery card is the live
    // activity), the review is over and awaiting the human — a stale phase must not
    // keep the "reviewing / independent check" bubble alive over the parked card.
    !hasLiveActivity &&
    !runBlocked;

  // Escape interrupts the running step agent so the user can course-correct:
  // it aborts the agent's current turn and focuses the composer. The correction
  // typed there is forwarded to the now-idle agent through the normal send path.
  // Active only while a step agent is genuinely running.
  useEffect(() => {
    if (!activeStepRunning || !runId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void (async () => {
        try {
          await interruptStep(runId);
          composerFormRef.current?.querySelector("textarea")?.focus();
        } catch (err) {
          setActionError(toErrorMessage(err, "Failed to interrupt the agent."));
        }
      })();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeStepRunning, runId]);

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
    // Code changes render as their own pre-expanded cards in the timeline rather
    // than collapsed inside the activity card. They sort just after their source
    // activity card (key `a:` < `d:` at the same timestamp).
    ...activities.flatMap((activity) =>
      (activity.steps ?? [])
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => step.diff != null)
        .map(({ step, index }) => ({
          kind: "diff" as const,
          at: activity.createdAt,
          key: `d:${activity.id}:${String(index).padStart(4, "0")}`,
          diff: step.diff!,
          caption: step.text,
        })),
    ),
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
      if (workflowState.run?.currentNodeKind === "splitter") {
        await confirmSplit(runId);
      } else {
        await confirmStep(runId);
      }
      markAnswerPending();
    } finally {
      setRefreshNonce((current) => current + 1);
    }
  }

  async function handleSplitChoice(branch: string) {
    if (!runId) return;
    setActionError(null);
    try {
      await confirmSplit(runId, branch);
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to route the workflow."));
    }
  }

  async function handleApproveCompletion() {
    if (!completionRecId) return;
    setApprovingCompletion(true);
    setActionError(null);
    try {
      await acceptRecommendation(completionRecId, {});
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to complete workflow."));
    } finally {
      setApprovingCompletion(false);
    }
  }

  async function handleGateDecision(outcome: "approved" | "rejected") {
    if (!runId) return;
    setDecidingGate(true);
    setActionError(null);
    try {
      await decideGate(runId, outcome);
      setRefreshNonce((current) => current + 1);
    } catch (err) {
      setActionError(toErrorMessage(err, "Failed to submit gate decision."));
    } finally {
      setDecidingGate(false);
    }
  }


  async function handleRevise(runId: string) {
    try {
      await requestStepRevision(runId);
      markAnswerPending();
    } finally {
      setRefreshNonce((current) => current + 1);
    }
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedGoalId) return;
    const body = messageDraft.trim();
    if (!body) return;

    if (pendingRevisionRunId) {
      setSendingMessage(true);
      setMessageError(null);
      try {
        await submitStepRevision(pendingRevisionRunId, body);
        markAnswerPending();
        setMessageDraft("");
      } catch (err) {
        setMessageError(toErrorMessage(err, "Failed to send your revision."));
      } finally {
        setSendingMessage(false);
      }
      return;
    }

    const command = parseSlashCommand(body);
    if (command) {
      setSendingMessage(true);
      setMessageError(null);
      try {
        await runGoalCommand(selectedGoalId, command);
        setMessageDraft("");
      } catch {
        setMessageError("Failed to run that command.");
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
          awaitingApproval={awaitingApproval}
          onApprove={completionRecId ? () => void handleApproveCompletion() : undefined}
          approving={approvingCompletion}
          awaitingGate={awaitingGate}
          awaitingConfirm={awaitingStepConfirm}
          skippedIndices={skippedIndices}
          onViewWorkflows={onViewWorkflows}
        />
      )}
      <div className="orca-chat">
        <div className="orca-chat-scroll scroll" ref={scrollRef} onScroll={handleScroll}>
        {!selectedGoal && (
          <SystemCard
            title="Select a goal"
            body="Choose a goal from the rail to start or continue its Engineering workflow."
          />
        )}

        {selectedGoal && (
          <>
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
                            aria-label="Choose workflow"
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
                  onWorkerAnswered={markAnswerPending}
                />
              ) : entry.kind === "diff" ? (
                <CodeChangeCard key={entry.key} diff={entry.diff} caption={entry.caption} />
              ) : entry.activity.sourceKind === "step_result" ? (
                <div key={entry.key} className="msg msg--orca">
                  <OrcaMark />
                  <div className="msg-body">
                    <div className="mono msg-meta">orca</div>
                    <ActivityCard activity={entry.activity} />
                  </div>
                </div>
              ) : (
                <div key={entry.key} className="msg msg--orca">
                  <OrcaMark />
                  <div className="msg-body">
                    <div className="mono msg-meta">orca</div>
                    {/* During the orchestrator's post-worker review the worker's
                        turn is over, so its activity must stop pulsing — otherwise
                        two live indicators show at once. */}
                    <AgentActivity activity={entry.activity} interrupted={runBlocked || showOrchestratorReview} />
                  </div>
                </div>
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
              !runBlocked &&
              !(liveActivity.sourceKind === "step_confirmation_pending" &&
                pendingRevisionRunId === liveActivity.workflowRunId) && (
              <div className="msg msg--orca">
                <OrcaMark />
                <div className="msg-body">
                  <div className="mono msg-meta">orca</div>
                  <LiveActivity
                    activity={liveActivity}
                    renderProviderRecovery={({ runId, recovery }) => (
                      <ProviderRecoveryCard
                        runId={runId}
                        recovery={recovery}
                        onChanged={() => setRefreshNonce((current) => current + 1)}
                      />
                    )}
                    onContinue={handleContinue}
                    onRevise={handleRevise}
                    onGateDecide={(_runId, outcome) => void handleGateDecision(outcome)}
                    gateDeciding={decidingGate}
                    gateReview={workflowState.run?.pendingGateReview ?? null}
                  />
                </div>
              </div>
            )}

            {answerPendingSince != null && !runBlocked && !showOrchestratorReview && !awaitingGate && (
              <div data-testid="answer-thinking">
                <ThinkingRow label="Thinking…" />
              </div>
            )}

            {showOrchestratorReview && (
              <div data-testid="orchestrator-review">
                <ThinkingRow label={orchestratorPhaseLabel!} />
              </div>
            )}

            {showStarting && (
              <div data-testid="step-starting">
                <ThinkingRow label="Starting workflow" />
              </div>
            )}

            {showStepWorking && (
              <div data-testid="step-working">
                <ThinkingRow label={activeStepName ? `Working on ${activeStepName}…` : "Working…"} />
              </div>
            )}

            {showGateWorking && (
              <div data-testid="gate-working">
                <ThinkingRow label={`Working on ${gateWorkingName}…`} />
              </div>
            )}

            {/* Show Orca is working from the moment the send is in flight
                (covers the blocking one_shot path) through the async wait for a
                deferred reply (shadow_session / active-run, reply:null). A blocked
                run is waiting on a human, not the agent, so never spin then. */}
            {(sendingMessage || awaitingReply) && !runBlocked && (
              <div data-testid="awaiting-reply">
                <RoutingCard />
              </div>
            )}

            {/* Undecidable splitter escalated to a human routing choice: present
                the branches (labeled by destination step) for the user to pick,
                instead of blocking or silently defaulting. */}
            {pendingSplitChoice && !runBlocked && (
              <div className="orca-chat-split-choice" role="group" data-testid="split-choice">
                <span className="orca-chat-split-choice-title">{pendingSplitChoice.prompt}</span>
                <div className="orca-chat-split-choice-options">
                  {pendingSplitChoice.options.map((opt) => (
                    <button
                      key={opt.branch}
                      type="button"
                      className="orca-chat-split-choice-btn"
                      onClick={() => void handleSplitChoice(opt.branch)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Honest, inspectable terminal state: the run halted and is waiting
                on a human. Show it plainly with the reason instead of leaving a
                spinner running over work that has stopped. */}
            {runBlocked && (
              <div className="orca-chat-blocked" role="alert" data-testid="run-blocked">
                <span className="orca-chat-blocked-title">Run blocked — needs your attention</span>
                <p className="orca-chat-blocked-reason">
                  {blockedReason ?? "The workflow stopped and could not continue automatically."}
                </p>
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
          {matchSlashCommands(messageDraft).length > 0 && (
            <ul className="orca-chat-command-list" role="listbox" aria-label="Commands">
              {matchSlashCommands(messageDraft).map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => setMessageDraft(`/${c.name} `)}
                  >
                    <span>/{c.name} {c.args}</span>
                    <span>{c.describe}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
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
          <WorkerPermissionToggle
            goalId={selectedGoal.id}
            mode={selectedGoal.workerPermissionMode}
            disabled={!connected}
          />
        </form>
      )}
      </div>
    </div>
  );
}

export function ChatMessageRow({ message, goalId, onWorkerAnswered }: { message: OrchestratorChatMessage; goalId: string; onWorkerAnswered?: () => void }) {
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
        {/* For a question or approval card the card leads; the third-person
            framing body ("The agent wants to run X.") is redundant, so it's
            suppressed and only the card is shown. */}
        {!message.pendingQuestion && !message.pendingApproval && (
          <div className="orca-chat-message">{message.body}</div>
        )}
        {message.pendingQuestion && message.pendingQuestion.withdrawn ? (
          // Superseded by a worker hard-block asking the same thing for this
          // step run: retracted, no longer answerable.
          <div className="pending-question withdrawn" data-testid="question-withdrawn">
            <span className="question-withdrawn-note">Question withdrawn — already answered elsewhere.</span>
          </div>
        ) : message.pendingQuestion && message.pendingQuestion.source === "worker" ? (
          // Worker question: an agent's AskUserQuestion tool call is blocked on
          // this; answering resolves it and persists the answer on the message.
          <WorkerQuestionForm
            goalId={message.goalId}
            pending={message.pendingQuestion}
            onSubmitAnswers={async (answers) => {
              await submitWorkerAnswers(message.goalId, message.pendingQuestion!.questionId, answers);
              onWorkerAnswered?.();
            }}
            // "Something else" is free text, so it is ambiguous the same way
            // composer text is — it may settle the question or ask about it.
            // Post it as chat and let the orchestrator decide; it consumes the
            // question only if the text actually answers it, which is what
            // drives this card into its answered state.
            onSubmitFreeText={async (text) => {
              await createOrchestratorMessage(message.goalId, { body: text });
              onWorkerAnswered?.();
            }}
            freeTextDeferred
          />
        ) : message.pendingQuestion ? (
          // Orchestrator ask_user: persist the answer on the question and forward
          // it to the mediator as guidance — no echoed user bubble.
          <WorkerQuestionForm
            goalId={goalId}
            pending={message.pendingQuestion}
            onSubmitAnswers={async (answers) => {
              await submitOrchestratorAnswer(goalId, message.pendingQuestion!.questionId, { answers });
              onWorkerAnswered?.();
            }}
            onSubmitFreeText={async (text) => {
              await submitOrchestratorAnswer(goalId, message.pendingQuestion!.questionId, { freeText: text });
              onWorkerAnswered?.();
            }}
          />
        ) : null}
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
  freeTextDeferred,
}: {
  goalId: string;
  pending: NonNullable<OrchestratorChatMessage["pendingQuestion"]>;
  // Override the submit path. Default submits to the worker-question endpoint
  // (an agent's live AskUserQuestion). Orchestrator ask_user questions pass a
  // handler that posts the answer back as user guidance instead.
  onSubmitAnswers?: (answers: WorkerAnswer[]) => Promise<void>;
  // Both worker and orchestrator questions accept a free-text answer
  // ("Something else"), so the user is never boxed into the offered options.
  onSubmitFreeText?: (text: string) => Promise<void>;
  // True when free text is routed through chat rather than answering directly
  // (worker questions): the orchestrator decides whether it settles the question,
  // so the card must stay live until a persisted answer says otherwise.
  freeTextDeferred?: boolean;
}) {
  // Once a question carries a persisted answer it renders read-only, driven by
  // that answer — so the answered state survives reloads and goal switches and
  // looks identical for worker and orchestrator questions.
  const answer = pending.answer ?? null;
  const [selections, setSelections] = useState<Record<number, string[]>>(() => selectionsFromAnswer(answer));
  // Local optimistic flag for an in-flight submit; a persisted answer also makes
  // the card read-only (covers composer/cross-session answers on this message).
  const [localSubmitted, setLocalSubmitted] = useState(false);
  // A submit that failed (network/server error). The question itself never
  // expires — it parks durably until answered — so a failure is always retryable.
  const [submitError, setSubmitError] = useState(false);
  const [freeTextSelected, setFreeTextSelected] = useState(answer?.freeText != null);
  const [freeText, setFreeText] = useState(answer?.freeText ?? "");
  const singleQuestion = pending.questions.length === 1;
  const offerFreeText = singleQuestion && onSubmitFreeText != null;
  const answeredViaChat = answer?.viaChat === true;
  const submitted = localSubmitted || answer != null;

  // Reset (or re-seed from a persisted answer) when the question itself changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on questionId only
  useEffect(() => {
    const a = pending.answer ?? null;
    setSelections(selectionsFromAnswer(a));
    setLocalSubmitted(false);
    setSubmitError(false);
    setFreeTextSelected(a?.freeText != null);
    setFreeText(a?.freeText ?? "");
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
    // Deferred free text isn't an answer yet, so don't lock the card on it —
    // only a persisted answer (or an option submit, which is unambiguous) does.
    const deferred = freeTextSelected && onSubmitFreeText != null && freeTextDeferred === true;
    if (!deferred) setLocalSubmitted(true);
    try {
      if (freeTextSelected && onSubmitFreeText) await onSubmitFreeText(freeText.trim());
      else if (onSubmitAnswers) await onSubmitAnswers(answers);
      else await submitWorkerAnswers(goalId, pending.questionId, answers);
      if (deferred) {
        // Hand the text off to chat and reset the box, leaving the options live.
        setFreeText("");
        setFreeTextSelected(false);
      }
    } catch {
      setLocalSubmitted(false);
      setSubmitError(true);
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
        // A plain <div role="group"> rather than <fieldset>: WKWebView stretches
        // a fieldset flex-item past its content, leaving a gap above the button.
        <div
          key={qi}
          className="orca-chat-question-block"
          role="group"
          aria-labelledby={`${pending.questionId}-${qi}-label`}
        >
          <div className="orca-chat-question-legend" id={`${pending.questionId}-${qi}-label`}>
            {pending.questions.length > 1 && <span className="orca-chat-question-index">{qi + 1} · </span>}<span>{q.question}</span>
          </div>
          {q.options.map((opt, oi) => {
            const chosen = (selections[qi] ?? []).includes(opt.label);
            const recommendedSuffix = " (Recommended)";
            const recommended = opt.label.endsWith(recommendedSuffix);
            const displayLabel = recommended
              ? opt.label.slice(0, -recommendedSuffix.length)
              : opt.label;
            return (
              <label
                key={oi}
                // An answered card disables its radios, which greys out the
                // checked dot (WKWebView) — mark the chosen row so CSS can show
                // the selection unmistakably instead of relying on that dot.
                className={`orca-chat-option-row${submitted && chosen ? " orca-chat-option-row--chosen" : ""}`}
              >
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`${pending.questionId}-${qi}`}
                  aria-label={opt.label}
                  checked={chosen}
                  disabled={submitted}
                  onChange={() => toggle(qi, opt.label, q.multiSelect)}
                />
                <span className="orca-chat-option-content">
                  <span className="orca-chat-option-head">
                    <span className="orca-chat-option-label">
                      {submitted && chosen ? (
                        <span className="orca-chat-option-check">✓ </span>
                      ) : null}
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
              <label
                className={`orca-chat-option-row${submitted && freeTextSelected ? " orca-chat-option-row--chosen" : ""}`}
              >
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`${pending.questionId}-${qi}`}
                  aria-label="Something else"
                  checked={freeTextSelected}
                  disabled={submitted}
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
        </div>
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
      {answeredViaChat && <p className="orca-chat-question-answered-note">Answered in chat.</p>}
      {submitError && <p className="form-error" role="alert">Couldn't send your answer. Please try again.</p>}
    </div>
  );
}

// Seed the form's per-question selections from a persisted options answer (if
// any), so an already-answered question renders with the chosen options marked.
function selectionsFromAnswer(
  answer: NonNullable<OrchestratorChatMessage["pendingQuestion"]>["answer"] | null,
): Record<number, string[]> {
  if (answer?.answers == null) return {};
  return Object.fromEntries(answer.answers.map((a) => [a.questionIndex, a.selectedLabels]));
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
  const { theme } = useTheme();
  return <OrcaLogo size={28} mode={theme.mode} />;
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
