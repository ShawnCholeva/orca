import { useEffect, useMemo, useState } from "react";
import type { Agent } from "@orca/contracts";
import { listAgents, updateAgentConnection, runReadinessCheck, runReadinessCheckForAgent } from "../api";
import { ReadinessPanel } from "./ReadinessPanel";
import { openExternal } from "../utils/openExternal";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  InfoIcon,
  OrcaMark,
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
          {step === 2 && !connectionsSaved && (
            <div className="agent-grid-center">
              <span className="mono onboarding-footer-meta">Saving agent selections…</span>
            </div>
          )}
          {step === 2 && connectionsSaved && (
            <ReadinessPanel
              agents={agents.filter((a) => selected[a.id] && a.connected)}
              runAll={runReadinessCheck}
              runOne={runReadinessCheckForAgent}
              onOpenUrl={openExternal}
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

