import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
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
  createOrchestratorMessage,
  getGoalDetail,
  getWorkflowRun,
  getWorkflowStepRun,
  listOrchestratorMessages,
  listWorkflowDecisions,
  listWorkflowRunArtifacts,
  listWorkflowTemplates,
  openEventStream,
  requestNextOrchestratorDecision,
  submitWorkerAnswers,
  startWorkflowRun,
  toErrorMessage,
} from "../api";
import { AgentParaphrasedMessage } from "./AgentParaphrasedMessage";
import { InternalThoughtRow } from "./InternalThoughtRow";
import { MarkDoneConfirmCard } from "./MarkDoneConfirmCard";
import "./orca-chat.css";

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
};

const EMPTY_WORKFLOW_STATE: WorkflowState = {
  detail: null,
  run: null,
  stepRun: null,
  decisions: [],
  artifacts: [],
};

export function OrcaChat({ goals, selectedGoalId, connectionStatus }: Props) {
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
  const [messages, setMessages] = useState<OrchestratorChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track which goal each data set has already loaded for, so SSE-driven
  // refetches refresh silently (keeping stale content) instead of flipping the
  // loading flags and flashing "routing" indicators on every event.
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

        setWorkflowState({
          detail,
          run: runResponse.run,
          stepRun,
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

  const lastMessage = messages[messages.length - 1] ?? null;
  const showMarkDoneCard = lastMessage?.internalKind === "mark_done_ready";

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

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedGoalId) return;
    const body = messageDraft.trim();
    if (!body) return;

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

  // Mark-done approval path is not yet wired into the daemon (deferred). There
  // is no existing API client function for approving a mark-done in this file's
  // imports, so we surface a pending-wiring note rather than invent one.
  function handleConfirmDone() {
    setActionError("Mark-done wiring pending — completion approval will land in a later task.");
  }

  function handleDeclineDone() {
    // No-op: declining simply leaves the run as-is.
  }

  return (
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
            {loading && <ThinkingRow label="routing" />}

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

            {messagesLoading && <ThinkingRow label="routing" />}

            {messages.map((message) => {
              if (message.role === "internal_thought") {
                return (
                  <InternalThoughtRow
                    key={message.id}
                    body={message.body}
                    kind={message.internalKind ?? undefined}
                    whyRationale={message.whyRationale ?? undefined}
                  />
                );
              }
              if (message.role === "agent_paraphrased") {
                return (
                  <AgentParaphrasedMessage
                    key={message.id}
                    body={message.body}
                    rawAgentText={message.rawAgentText ?? undefined}
                    whyRationale={message.whyRationale ?? undefined}
                  />
                );
              }
              return <ChatMessageRow key={message.id} message={message} goalId={selectedGoalId ?? ""} />;
            })}

            {showMarkDoneCard && lastMessage && (
              <MarkDoneConfirmCard
                summary={lastMessage.body}
                onConfirm={handleConfirmDone}
                onDecline={handleDeclineDone}
              />
            )}

            {/* Show Orca is working from the moment the send is in flight
                (covers the blocking one_shot path) through the async wait for a
                deferred reply (shadow_session / active-run, reply:null). */}
            {(sendingMessage || awaitingReply) && (
              <div data-testid="awaiting-reply">
                <ThinkingRow label="orchestrator" />
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
        <div className="orca-chat-message">{message.body}</div>
        {message.pendingQuestion && (
          <WorkerQuestionForm goalId={goalId} pending={message.pendingQuestion} />
        )}
      </div>
    </div>
  );
}

function WorkerQuestionForm({
  goalId,
  pending,
}: {
  goalId: string;
  pending: NonNullable<OrchestratorChatMessage["pendingQuestion"]>;
}) {
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  const [expired, setExpired] = useState(false);

  function toggle(qIndex: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const current = prev[qIndex] ?? [];
      if (multi) {
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
        return { ...prev, [qIndex]: next };
      }
      return { ...prev, [qIndex]: [label] };
    });
  }

  const allAnswered = pending.questions.every((_, i) => (selections[i]?.length ?? 0) > 0);

  async function handleSubmit() {
    const answers = pending.questions.map((_, i) => ({ questionIndex: i, selectedLabels: selections[i] ?? [] }));
    setSubmitted(true);
    try {
      await submitWorkerAnswers(goalId, pending.questionId, answers);
    } catch {
      setSubmitted(false);
      setExpired(true);
    }
  }

  return (
    <div className="orca-chat-question">
      {pending.questions.map((q, qi) => (
        <fieldset key={qi} className="orca-chat-question-block" disabled={submitted}>
          <legend className="orca-chat-question-legend">
            {pending.questions.length > 1 && <span>{qi + 1} · </span>}<span>{q.question}</span>
          </legend>
          {q.options.map((opt, oi) => {
            const chosen = (selections[qi] ?? []).includes(opt.label);
            return (
              <label key={oi} className="orca-chat-option-row">
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`${pending.questionId}-${qi}`}
                  checked={chosen}
                  onChange={() => toggle(qi, opt.label, q.multiSelect)}
                />
                <span className="orca-chat-option-label">{submitted && chosen ? "✓ " : ""}{opt.label}</span>
                {opt.description ? <span className="orca-chat-option-desc">{opt.description}</span> : null}
              </label>
            );
          })}
        </fieldset>
      ))}
      <button
        type="button"
        className="submit-button orca-chat-question-submit"
        disabled={submitted || !allAnswered}
        onClick={() => void handleSubmit()}
      >
        {submitted ? "Submitted" : "Submit"}
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
