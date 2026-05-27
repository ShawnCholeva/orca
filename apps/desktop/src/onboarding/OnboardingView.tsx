import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentReadinessReport } from "@orca/contracts";
import { listAgents, updateAgentConnection, runReadinessCheckForAgent } from "../api";
import { RepairBlock } from "./RepairBlock";
import { openExternal } from "../utils/openExternal";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  InfoIcon,
  OrcaMark,
  XIcon,
  glyphFor,
} from "./glyphs";
import { useTheme } from "../theme/ThemeProvider";
import "./onboarding.css";

interface OnboardingViewProps {
  onComplete: (selectedAgentIds: string[]) => void;
}

type Step = 0 | 1 | 2;

const WELCOME_BULLETS = [
  "Run multiple agents against a shared goal",
  "Promote decisions to durable goal memory",
  "Catch conflicts before they reach main",
];

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep] = useState<Step>(0);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readinessState, setReadinessState] = useState({ readyCount: 0, settled: false });
  const [connectionsSaved, setConnectionsSaved] = useState(false);
  const { theme } = useTheme();
  const mode = theme.mode;

  useEffect(() => {
    let cancelled = false;
    listAgents()
      .then((rows) => {
        if (cancelled) return;
        setAgents(rows);
        // Default selection: only agents already `connected` in the DB
        // (re-onboarding). Fresh install starts empty so the user must
        // explicitly pick at least one.
        const next: Record<string, boolean> = {};
        for (const a of rows) {
          next[a.id] = a.connected;
        }
        setSelected(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load agents");
      });
    return () => { cancelled = true; };
  }, []);

  const selectedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected],
  );

  function toggle(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }

  function finish() {
    setStep(2);
  }

  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    setConnectionsSaved(false);
    setReadinessState({ readyCount: 0, settled: false });
    (async () => {
      try {
        const updated = await Promise.all(
          agents.map((a) => updateAgentConnection(a.id, !!selected[a.id])),
        );
        if (cancelled) return;
        setAgents(updated);
        setConnectionsSaved(true);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to save selections");
        setStep(1);
      }
    })();
    return () => { cancelled = true; };
    // Run once when entering step 2. `agents` and `selected` are captured from the
    // user's step-1 choices; including `agents` would loop after `setAgents(updated)`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  return (
    <div className="onboarding-root" data-testid="onboarding-root">
      <div className="onboarding-wash" aria-hidden="true" />

      <aside className="onboarding-brand">
        <div className="onboarding-brand-row">
          <OrcaMark size={48} mode={mode} />
          <span className="mono onboarding-wordmark">ORCA</span>
        </div>

        {step === 0 && (
          <>
            <div className="mono onboarding-kicker">Welcome</div>
            <h1 className="onboarding-title">
              Operational<br />intelligence for<br />AI engineering.
            </h1>
            <p className="onboarding-prose">
              Orca coordinates the agents you already use into goal-oriented sessions with shared memory, reasoning, and an orchestrator in the loop.
            </p>
            <ul className="onboarding-bullets">
              {WELCOME_BULLETS.map((t) => (
                <li key={t} className="onboarding-bullet">
                  <span className="onboarding-bullet-check">
                    <CheckIcon size={16} strokeWidth={2.2} />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </>
        )}

        {step === 1 && (
          <>
            <div className="mono onboarding-kicker">Step 1 of 1</div>
            <h1 className="onboarding-title onboarding-title--sm">Connect your agents</h1>
            <p className="onboarding-prose onboarding-prose--narrow">
              Pick the AI runtimes you want Orca to coordinate. Roles will be portable across the agents you connect — you can change this anytime in Settings.
            </p>
            <div className="onboarding-info-card">
              <span className="onboarding-info-card-icon">
                <InfoIcon size={14} />
              </span>
              <div className="onboarding-info-card-text">
                Need an API key or local binary? Orca will walk you through hookup the first time you launch a session for that agent.
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="mono onboarding-kicker">Setting up</div>
            <h1 className="onboarding-title onboarding-title--sm">Preparing your workspace</h1>
            <p className="onboarding-prose onboarding-prose--narrow">
              We're configuring Orca, registering your selected agents, and provisioning shared memory. This usually takes a few seconds.
            </p>
          </>
        )}

        <div className="onboarding-spacer" />

        <div className="onboarding-steps" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={
                "onboarding-step-dot" +
                (i === step ? " onboarding-step-dot--active" : "") +
                (i < step ? " onboarding-step-dot--reached" : "")
              }
            />
          ))}
        </div>
      </aside>

      <main className="onboarding-content">
        <header className="onboarding-content-header">
          <div style={{ flex: 1 }} />
        </header>

        <div className="scroll onboarding-content-body">
          {step === 0 && <WelcomePanel />}
          {step === 1 && (
            <div className="agent-grid-center">
              {loadError && (
                <div className="agent-load-error" role="alert">{loadError}</div>
              )}
              <AgentGrid agents={agents} selected={selected} onToggle={toggle} />
            </div>
          )}
          {step === 2 && (
            <SetupPanel
              agents={agents.filter((a) => selected[a.id])}
              connectionsSaved={connectionsSaved}
              runOne={runReadinessCheckForAgent}
              onOpenUrl={openExternal}
              onComplete={(ids) => onComplete(ids)}
              onChange={setReadinessState}
            />
          )}
        </div>

        <footer className="onboarding-footer">
          {step === 1 && (
            <button
              type="button"
              className="ob-btn ob-btn--quiet"
              onClick={() => setStep(0)}
            >
              <ChevronLeftIcon />
              Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step === 1 && (
            <span className="mono onboarding-footer-meta">
              {selectedCount} {selectedCount === 1 ? "agent" : "agents"} selected
            </span>
          )}
          {step === 0 && (
            <button
              type="button"
              className="ob-btn ob-btn--primary"
              onClick={() => setStep(1)}
            >
              Get started
              <ArrowRightIcon />
            </button>
          )}
          {step === 1 && (
            <button
              type="button"
              className="ob-btn ob-btn--primary"
              onClick={finish}
              disabled={selectedCount === 0}
            >
              Continue
              <ArrowRightIcon />
            </button>
          )}
          {step === 2 && (
            <>
              <button
                type="button"
                className="ob-btn ob-btn--quiet"
                onClick={() => setStep(1)}
              >
                <ChevronLeftIcon />
                Back
              </button>
              <div style={{ flex: 1 }} />
              {readinessState.settled && readinessState.readyCount === 0 && (
                <button
                  type="button"
                  className="ob-btn ob-btn--secondary"
                  onClick={() => onComplete(agents.filter((a) => selected[a.id]).map((a) => a.id))}
                >
                  Continue anyway
                </button>
              )}
              <button
                type="button"
                className="ob-btn ob-btn--primary"
                onClick={() => onComplete(agents.filter((a) => selected[a.id]).map((a) => a.id))}
                disabled={!readinessState.settled || readinessState.readyCount === 0}
              >
                Continue
                <ArrowRightIcon />
              </button>
            </>
          )}
        </footer>
      </main>
    </div>
  );
}

function SetupPanel({
  agents,
  connectionsSaved,
  runOne,
  onOpenUrl,
  onComplete,
  onChange,
}: {
  agents: Agent[];
  connectionsSaved: boolean;
  runOne: (id: string) => Promise<AgentReadinessReport>;
  onOpenUrl: (url: string) => Promise<void>;
  onComplete: (agentIds: string[]) => void;
  onChange: (s: { readyCount: number; settled: boolean }) => void;
}) {
  const tasks = useMemo(() => [
    { id: "conductor", label: "Initializing Orca", detail: "Loading orchestration runtime", agentId: null as string | null },
    ...agents.map((a) => ({ id: `rt-${a.id}`, label: `Registering ${a.name}`, detail: a.shortLabel, agentId: a.id })),
    { id: "memory",    label: "Provisioning shared memory", detail: "Goal memory store + indices", agentId: null },
    { id: "roles",     label: "Loading default roles",      detail: "Architect · Engineer · Reviewer · QA", agentId: null },
    { id: "workflows", label: "Loading default workflows",  detail: "Brainstorm", agentId: null },
    { id: "ready",     label: "Finalizing workspace",       detail: "Almost there", agentId: null },
  ], [agents]);

  const [animIdx, setAnimIdx] = useState(0);
  const [animDoneIdx, setAnimDoneIdx] = useState(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [agentReports, setAgentReports] = useState<Record<string, AgentReadinessReport | null>>({});
  const [agentChecking, setAgentChecking] = useState<Record<string, boolean>>({});

  const onCompleteRef = useRef(onComplete);
  const onChangeRef = useRef(onChange);
  const runOneRef = useRef(runOne);
  const connectionsSavedRef = useRef(connectionsSaved);
  const hasCompletedRef = useRef(false);
  onCompleteRef.current = onComplete;
  onChangeRef.current = onChange;
  runOneRef.current = runOne;
  connectionsSavedRef.current = connectionsSaved;

  const animationDone = animIdx >= tasks.length;

  // Animation loop: timer for infra tasks, runOne() for agent tasks (blocks until resolved)
  useEffect(() => {
    if (animationDone) return;
    const task = tasks[animIdx];
    if (!task) return;
    let cancelled = false;

    if (task.agentId) {
      setAgentChecking((prev) => ({ ...prev, [task.agentId!]: true }));
      runOneRef.current(task.agentId)
        .then((report) => {
          if (cancelled) return;
          setAgentReports((prev) => ({ ...prev, [task.agentId!]: report }));
        })
        .catch(() => {})
        .finally(() => {
          if (cancelled) return;
          setAgentChecking((prev) => ({ ...prev, [task.agentId!]: false }));
          setAnimDoneIdx(animIdx);
          setAnimIdx((i) => i + 1);
        });
    } else {
      timerRef.current = setTimeout(() => {
        if (cancelled) return;
        setAnimDoneIdx(animIdx);
        setAnimIdx((i) => i + 1);
      }, process.env.NODE_ENV === "test" ? 0 : 550 + Math.random() * 350);
    }

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [animIdx, animationDone, tasks]);

  // When animation completes: report settled state + auto-complete if all ready
  useEffect(() => {
    if (!animationDone) return;
    const readyIds = agents.filter((a) => agentReports[a.id]?.status === "ready").map((a) => a.id);
    onChangeRef.current({ readyCount: readyIds.length, settled: true });
    if (readyIds.length === agents.length && agents.length > 0 && connectionsSaved && !hasCompletedRef.current) {
      hasCompletedRef.current = true;
      onCompleteRef.current(readyIds);
    }
  }, [animationDone, connectionsSaved, agentReports, agents]);

  function handleRetry(agentId: string) {
    setAgentChecking((prev) => ({ ...prev, [agentId]: true }));
    runOneRef.current(agentId)
      .then((report) => {
        setAgentReports((prev) => {
          const next = { ...prev, [agentId]: report };
          const readyIds = agents.filter((a) => next[a.id]?.status === "ready").map((a) => a.id);
          onChangeRef.current({ readyCount: readyIds.length, settled: true });
          if (readyIds.length === agents.length && agents.length > 0 && connectionsSavedRef.current && !hasCompletedRef.current) {
            hasCompletedRef.current = true;
            onCompleteRef.current(readyIds);
          }
          return next;
        });
      })
      .finally(() => setAgentChecking((prev) => ({ ...prev, [agentId]: false })));
  }

  const progress = Math.min(1, (animDoneIdx + 1) / tasks.length);

  return (
    <div className="setup-panel">
      <div className="setup-spinner">
        <svg viewBox="0 0 96 96" width="96" height="96" className="setup-spinner-ring">
          <defs>
            <linearGradient id="setup-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="var(--accent-2, #8B5CF6)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <circle cx="48" cy="48" r="40" fill="none" stroke="var(--hairline)" strokeWidth="2" />
          <circle cx="48" cy="48" r="40" fill="none" stroke="url(#setup-grad)" strokeWidth="2" strokeLinecap="round" strokeDasharray="180 360" />
        </svg>
        <div className="setup-spinner-center">
          <div className="setup-spinner-orb">
            <svg width="20" height="20" viewBox="0 0 14 14">
              <circle cx="7" cy="7" r="1.8" fill="#fff" />
              <circle cx="7" cy="7" r="4" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="1" />
            </svg>
          </div>
        </div>
      </div>

      <div className="setup-progress">
        <div className="setup-progress-header">
          <span className="mono setup-progress-label">Progress</span>
          <span className="mono setup-progress-pct">{Math.round(progress * 100)}%</span>
        </div>
        <div className="setup-progress-track">
          <div className="setup-progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      <div className="setup-tasks">
        {tasks.map((t, i) => {
          const report = t.agentId ? (agentReports[t.agentId] ?? null) : null;
          let iconState: "pending" | "running" | "done" | "checking" | "ready" | "failed";

          if (t.agentId) {
            if (agentChecking[t.agentId]) {
              iconState = "checking";
            } else if (i < animIdx) {
              iconState = report?.status === "ready" ? "ready" : report ? "failed" : "done";
            } else if (i === animIdx) {
              iconState = "checking";
            } else {
              iconState = "pending";
            }
          } else {
            iconState = i < animIdx ? "done" : i === animIdx ? "running" : "pending";
          }

          const isActive = iconState === "running" || iconState === "checking";
          const isPending = iconState === "pending";
          const isFailed = iconState === "failed";
          const isGreen = iconState === "done" || iconState === "ready";

          return (
            <div
              key={t.id}
              className={
                "setup-task" +
                (isActive ? " setup-task--running" : "") +
                (isPending ? " setup-task--pending" : "") +
                (isFailed ? " setup-task--failed" : "")
              }
            >
              <span
                className={
                  "setup-task-icon" +
                  (isGreen ? " setup-task-icon--done" : "") +
                  (isFailed ? " setup-task-icon--failed" : "") +
                  (isActive ? " setup-task-icon--running" : "")
                }
              >
                {isGreen && <CheckIcon size={11} color="#fff" strokeWidth={2.5} />}
                {isFailed && <XIcon size={11} color="#fff" strokeWidth={2.5} />}
                {isActive && <span className="setup-task-pulse" />}
              </span>
              <div className="setup-task-body">
                <div className="setup-task-label">{t.label}</div>
                <div className="mono setup-task-detail">{t.detail}</div>
                {isFailed && report && (
                  <div className="setup-task-repair">
                    {report.steps.filter((s) => !s.ok).map((s, si) => (
                      <div key={si} className="setup-task-step-fail">
                        <XIcon size={10} color="var(--err)" strokeWidth={2.5} />
                        <span>{s.detail ?? s.name}</span>
                      </div>
                    ))}
                    {report.repair && (
                      <RepairBlock
                        repair={report.repair}
                        onOpenUrl={onOpenUrl}
                        onActionTaken={() => handleRetry(t.agentId!)}
                      />
                    )}
                    <button
                      type="button"
                      className="setup-task-retry-btn"
                      onClick={() => handleRetry(t.agentId!)}
                      disabled={!!agentChecking[t.agentId!]}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
              {isActive && (
                <span className="mono setup-task-status">
                  {iconState === "checking" ? "checking" : "running"}
                </span>
              )}
              {isFailed && (
                <span className="mono setup-task-status setup-task-status--err">
                  {labelForStatus(report?.status)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function labelForStatus(status: string | undefined): string {
  switch (status) {
    case "missing": return "not installed";
    case "needs_auth": return "not signed in";
    case "misconfigured": return "misconfigured";
    case "failed": return "check failed";
    default: return "failed";
  }
}

function WelcomePanel() {
  return (
    <div className="welcome-panel">
      <OrcaIllustration />
    </div>
  );
}

function OrcaIllustration() {
  const R = 140;
  const labels = ["Architect", "Engineer", "Reviewer", "QA", "Security", "Refactorer"];
  const ring = labels.map((label, i) => {
    const a = (Math.PI * 2 * i) / labels.length - Math.PI / 2;
    return { x: Math.cos(a) * R, y: Math.sin(a) * R, label };
  });
  return (
    <div className="orca-illustration">
      <svg viewBox="-200 -200 400 400" width="475" height="475" style={{ position: "absolute", inset: 0 }}>
        <circle cx="0" cy="0" r={R} fill="none" stroke="var(--hairline)" strokeWidth="1" strokeDasharray="2 4" />
        {ring.map((p, i) => (
          <line key={i} x1="0" y1="0" x2={p.x * 0.78} y2={p.y * 0.78} stroke="var(--accent-soft)" strokeWidth="1.5" />
        ))}
        <circle cx="0" cy="0" r="40" fill="var(--accent-soft)" />
        <circle cx="0" cy="0" r="28" fill="none" stroke="var(--accent-line)" strokeWidth="1" />
        <defs>
          <linearGradient id="om-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-2, #8B5CF6)" />
          </linearGradient>
        </defs>
        <circle cx="0" cy="0" r="18" fill="url(#om-grad)" />
        <circle cx="0" cy="0" r="5" fill="#fff" />
        {ring.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="14" fill="var(--panel)" stroke="var(--hairline-strong)" strokeWidth="1" />
            <circle cx={p.x} cy={p.y} r="4" fill="var(--accent)" />
          </g>
        ))}
      </svg>
      {ring.map((p, i) => (
        <div
          key={i}
          className="orca-label"
          style={{
            left: `calc(50% + ${p.x * 1.45}px)`,
            top: `calc(50% + ${p.y * 1.45}px)`,
          }}
        >
          {p.label}
        </div>
      ))}
      <div className="orca-center-label">Orca</div>
    </div>
  );
}

function AgentGrid({ agents, selected, onToggle }: { agents: Agent[]; selected: Record<string, boolean>; onToggle: (id: string) => void }) {
  return (
    <div className="agent-grid">
      {agents.map((a) => (
        <AgentCard
          key={a.id}
          agent={a}
          selected={!!selected[a.id]}
          onToggle={() => onToggle(a.id)}
        />
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  selected,
  onToggle,
}: {
  agent: Agent;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={"agent-card" + (selected ? " agent-card--selected" : "")}
      data-agent-id={agent.id}
    >
      <div style={{ flexShrink: 0 }}>{glyphFor(agent.id, agent.swatch)}</div>
      <div className="agent-card-body">
        <div className="agent-card-name-row">
          <span className="agent-card-name">{agent.name}</span>
          {agent.recommended && <span className="pill">recommended</span>}
        </div>
        <div className="mono agent-card-short">{agent.shortLabel}</div>
        <div className="agent-card-desc">{agent.description}</div>
      </div>
      <span className="agent-card-check" aria-hidden="true">
        {selected && <CheckIcon size={12} color="#fff" strokeWidth={2.5} />}
      </span>
    </button>
  );
}

