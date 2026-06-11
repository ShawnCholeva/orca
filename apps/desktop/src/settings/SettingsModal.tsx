import { useEffect, useState } from "react";
import type { Agent, SupervisionMode } from "@orca/contracts";
import { useTheme } from "../theme/ThemeProvider";
import { getSettings, putSettings } from "../api";
import type { ThemeDefinition } from "../theme/themes";
import { glyphFor, CheckIcon, XIcon } from "../onboarding/glyphs";
import "./settings.css";

type SettingsTab = "appearance" | "orchestration" | "agents";

interface SettingsModalProps {
  onClose: () => void;
  agents: Agent[];
  onToggleAgent: (id: string, connected: boolean) => Promise<void> | void;
}

const TABS: { id: SettingsTab; label: string; icon: (p: IconProps) => JSX.Element }[] = [
  { id: "appearance", label: "Appearance", icon: AppearanceIcon },
  { id: "orchestration", label: "Orchestration", icon: OrchestrationIcon },
  { id: "agents", label: "Manage Agents", icon: AgentsIcon },
];

export function SettingsModal({ onClose, agents, onToggleAgent }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("appearance");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <GearIcon size={15} />
          <span className="settings-header-title">Settings</span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <XIcon size={14} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-tabs" aria-label="Settings sections">
            {TABS.map((t) => {
              const active = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={"settings-tab" + (active ? " settings-tab--active" : "")}
                  onClick={() => setTab(t.id)}
                  aria-pressed={active}
                >
                  <Icon size={14} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="scroll settings-content">
            {tab === "appearance" && <AppearanceTab />}
            {tab === "orchestration" && <OrchestrationTab />}
            {tab === "agents" && <ManageAgentsTab agents={agents} onToggleAgent={onToggleAgent} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Appearance ─────────────────────────

function AppearanceTab() {
  const { theme, setThemeById, themes } = useTheme();
  return (
    <section>
      <div className="settings-section-label">Theme</div>
      <div className="settings-theme-grid">
        {themes.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            active={theme.id === t.id}
            onClick={() => setThemeById(t.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ThemeCard({
  theme,
  active,
  onClick,
}: {
  theme: ThemeDefinition;
  active: boolean;
  onClick: () => void;
}) {
  const panel = theme.tokens["--panel"] ?? "var(--panel)";
  const bg = theme.tokens["--bg"] ?? "var(--bg)";
  const raised = theme.tokens["--raised"] ?? "var(--raised)";
  const accent = theme.tokens["--accent"] ?? "var(--accent)";
  const swatch = `linear-gradient(135deg, ${panel} 0%, ${bg} 60%, ${raised} 100%)`;
  return (
    <button
      type="button"
      className={"settings-theme-card" + (active ? " settings-theme-card--active" : "")}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="settings-theme-swatch" style={{ background: swatch }}>
        <span className="settings-theme-swatch-panel" />
        <span className="settings-theme-swatch-dot" style={{ background: accent, boxShadow: `0 0 12px ${accent}` }} />
      </span>
      <span className="settings-theme-card-name-row">
        <span className="settings-theme-card-name">{theme.label}</span>
        {active && <CheckIcon size={12} color="var(--accent)" />}
      </span>
    </button>
  );
}

// ───────────────────────── Orchestration ─────────────────────────

const SUPERVISION_OPTIONS: { mode: SupervisionMode; name: string; desc: string }[] = [
  { mode: "supervised", name: "Supervised", desc: "Pause after each step so you can review the result and refine it before continuing." },
  { mode: "unsupervised", name: "Unsupervised", desc: "Run steps to completion automatically without pausing." },
];

function OrchestrationTab() {
  const [mode, setMode] = useState<SupervisionMode | null>(null);

  useEffect(() => {
    let active = true;
    void getSettings().then((s) => {
      if (active) setMode(s.supervisionMode);
    });
    return () => {
      active = false;
    };
  }, []);

  async function choose(next: SupervisionMode) {
    if (next === mode) return;
    setMode(next);
    try {
      await putSettings({ supervisionMode: next });
    } catch {
      const s = await getSettings();
      setMode(s.supervisionMode);
    }
  }

  return (
    <section>
      <div className="settings-section-label">Supervision</div>
      <div className="settings-level-list">
        {SUPERVISION_OPTIONS.map((o) => {
          const active = mode === o.mode;
          return (
            <button
              key={o.mode}
              type="button"
              data-testid={`supervision-${o.mode}`}
              className={"settings-level" + (active ? " settings-level--active" : "")}
              onClick={() => choose(o.mode)}
            >
              <div className="settings-level-body">
                <div className="settings-level-name">{o.name}</div>
                <div className="settings-level-desc">{o.desc}</div>
              </div>
              {active && <CheckIcon size={14} color="var(--accent)" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ───────────────────────── Manage Agents ─────────────────────────

function ManageAgentsTab({
  agents,
  onToggleAgent,
}: {
  agents: Agent[];
  onToggleAgent: (id: string, connected: boolean) => Promise<void> | void;
}) {
  const [pending, setPending] = useState<Record<string, boolean>>({});

  async function toggle(id: string, connected: boolean) {
    if (pending[id]) return;
    setPending((p) => ({ ...p, [id]: true }));
    try {
      await onToggleAgent(id, connected);
    } finally {
      setPending((p) => ({ ...p, [id]: false }));
    }
  }

  const connected = agents.filter((a) => a.connected);
  const available = agents.filter((a) => !a.connected);

  return (
    <>
      <section className="settings-agent-section">
        <div className="settings-section-label">Connected · {connected.length}</div>
        <div className="settings-agent-list">
          {connected.length > 0 ? (
            connected.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                pending={!!pending[a.id]}
                onClick={() => toggle(a.id, false)}
              />
            ))
          ) : (
            <div className="settings-agent-empty">
              No agents connected. Add one below to start coordinating sessions.
            </div>
          )}
        </div>
      </section>

      {available.length > 0 && (
        <section className="settings-agent-section">
          <div className="settings-section-label">Available · {available.length}</div>
          <div className="settings-agent-list">
            {available.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                pending={!!pending[a.id]}
                onClick={() => toggle(a.id, true)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function AgentRow({
  agent,
  pending,
  onClick,
}: {
  agent: Agent;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <div className="settings-agent-row">
      <span className="settings-agent-glyph">{glyphFor(agent.id, agent.swatch)}</span>
      <div className="settings-agent-meta">
        <div className="settings-agent-name-row">
          <span className="settings-agent-name">{agent.name}</span>
          {agent.connected && (
            <span className="settings-agent-status">
              <span className="settings-agent-status-light" />
              <span className="mono settings-agent-status-label">Connected</span>
            </span>
          )}
        </div>
        <div className="mono settings-agent-short">{agent.shortLabel}</div>
      </div>
      {agent.connected ? (
        <button
          type="button"
          className="settings-agent-btn settings-agent-btn--remove"
          onClick={onClick}
          disabled={pending}
        >
          <XIcon size={12} />
          Remove
        </button>
      ) : (
        <button
          type="button"
          className="settings-agent-btn settings-agent-btn--add"
          onClick={onClick}
          disabled={pending}
        >
          <PlusIcon size={12} />
          Add
        </button>
      )}
    </div>
  );
}

// ───────────────────────── Icons ─────────────────────────

interface IconProps {
  size?: number;
}

export function GearIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function AppearanceIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function OrchestrationIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M12 7.5v4M10 13l-3.5 3M14 13l3.5 3" />
    </svg>
  );
}

function AgentsIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function PlusIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
