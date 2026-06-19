import { useState, useEffect, FormEvent } from "react";
import { Goal, DomainEventType, type Agent, type PluginSummary, type SkillSummary } from "@orca/contracts";
import {
  fetchHealth,
  listAgents,
  listGoals,
  listPlugins,
  listSkills,
  updateGoal,
  updateAgentConnection,
  archiveGoal,
  openEventStream,
  ApiError,
  type ConnectionStatus,
} from "./api";
import { CreateGoalFlow } from "./create-goal-flow/CreateGoalFlow";
import { GoalDetailView } from "./goal-detail/GoalDetailView";
import { OnboardingView } from "./onboarding/OnboardingView";
import { Titlebar } from "./chrome/Titlebar";
import { BootstrapErrorScreen } from "./chrome/BootstrapErrorScreen";
import { NoReadyAgentsBanner } from "./chrome/NoReadyAgentsBanner";
import { OrcaChat } from "./orchestrator/OrcaChat";
import { WorkflowsPage } from "./workflows/WorkflowsPage";
import { WorkspacesPage } from "./workspaces/WorkspacesPage";
import { EmptyGoalsView } from "./empty-state/EmptyGoalsView";
import { SettingsModal, GearIcon } from "./settings/SettingsModal";
import "./orchestrator/orchestrator.css";
import "./styles.css";

type OnboardingState = "checking" | "needs-onboarding" | "complete" | "error";

type AppMode = "list" | "detail";

type WorkspaceTab = "workspaces" | "orchestrator" | "workflows" | "reasoning";

function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

type Diagnostics = { plugins: PluginSummary[]; skills: SkillSummary[] };

const DETAIL_REFETCH_EVENTS = new Set<DomainEventType>(["goal.refined", "workspace.attached", "workspace.removed"]);
const GOAL_LIST_EVENTS = new Set<DomainEventType>(["goal.created", "goal.updated", "goal.archived", "goal.worker_permission_mode_changed"]);

export default function App() {
  const [onboardingState, setOnboardingState] = useState<OnboardingState>("checking");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [mode, setMode] = useState<AppMode>("list");
  const [currentGoalId, setCurrentGoalId] = useState<string | null>(null);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [showCreateFlow, setShowCreateFlow] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedOrchestratorGoalId, setSelectedOrchestratorGoalId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("orchestrator");
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);

  async function loadDiagnostics() {
    if (diagnosticsLoading) return;
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const [plugins, skills] = await Promise.all([listPlugins(), listSkills()]);
      setDiagnostics({ plugins, skills });
    } catch (err) {
      setDiagnosticsError(toErrorMessage(err, "Failed to load diagnostics."));
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function loadGoals() {
    try {
      const res = await listGoals();
      setGoals(res.goals);
    } catch {
      // connection status banner communicates the problem to the user
    }
  }

  async function refreshAgents() {
    try {
      setAgents(await listAgents());
    } catch {
      // connection status banner communicates the problem
    }
  }

  // Source of truth for connected agents is the daemon's agents table. Persist
  // the change, then refresh so the rest of the app (banner, onboarding) agrees.
  async function toggleAgentConnection(id: string, connected: boolean) {
    await updateAgentConnection(id, connected);
    await refreshAgents();
  }

  // Health poll — primary driver of connection status indicator
  useEffect(() => {
    async function checkHealth() {
      try {
        await fetchHealth();
        setConnectionStatus("open");
      } catch {
        setConnectionStatus("closed");
      }
    }

    checkHealth();
    const id = setInterval(checkHealth, 5000);
    return () => clearInterval(id);
  }, []);

  // Decide whether to show onboarding by looking at the agents table — if any
  // agent has connected=true, the user has been through it before.
  useEffect(() => {
    if (connectionStatus !== "open" || onboardingState !== "checking") return;
    let cancelled = false;
    listAgents()
      .then((rows) => {
        if (cancelled) return;
        setAgents(rows);
        const anyConnected = rows.some((a) => a.connected);
        setOnboardingState(anyConnected ? "complete" : "needs-onboarding");
        setBootstrapError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBootstrapError(
          err instanceof Error ? err.message : "Failed to load agents from the daemon.",
        );
        setOnboardingState("error");
      });
    return () => { cancelled = true; };
  }, [connectionStatus, onboardingState]);

  function retryBootstrap() {
    setBootstrapError(null);
    setOnboardingState("checking");
  }

  // Load goals/diagnostics once the daemon is reachable, and refetch on every
  // reconnect. Firing on mount instead races the daemon's HTTP server coming
  // up — the fetch fails silently and the list stays empty until a goal event.
  useEffect(() => {
    if (connectionStatus !== "open") return;
    loadGoals();
    loadDiagnostics();
  }, [connectionStatus]);

  useEffect(() => {
    if (goals.length === 0) {
      setSelectedOrchestratorGoalId(null);
      return;
    }
    if (
      selectedOrchestratorGoalId === null ||
      !goals.some((goal) => goal.id === selectedOrchestratorGoalId)
    ) {
      setSelectedOrchestratorGoalId(goals[0]!.id);
    }
  }, [goals, selectedOrchestratorGoalId]);

  // WebSocket event stream — refreshes goal list or detail on relevant events
  useEffect(() => {
    const stream = openEventStream({
      onEvent(event) {
        if (GOAL_LIST_EVENTS.has(event.type)) {
          void loadGoals();
        }
        if (
          DETAIL_REFETCH_EVENTS.has(event.type) &&
          event.goalId !== null &&
          event.goalId === currentGoalId
        ) {
          setDetailRefreshKey((k) => k + 1);
        }
      },
      onStatus: setConnectionStatus,
    });
    return () => stream.close();
  }, [currentGoalId]);

  function handleCreateFlowDone(goalId: string) {
    setShowCreateFlow(false);
    setSelectedOrchestratorGoalId(goalId);
    setActiveTab("orchestrator");
    setMode("list");
  }

  function handleBackToList() {
    setMode("list");
    setCurrentGoalId(null);
  }

  function openGoalDetail(goalId: string) {
    setCurrentGoalId(goalId);
    setDetailRefreshKey(0);
    setMode("detail");
  }

  const connected = connectionStatus === "open";

  const statusLabel = {
    open: "Connected",
    connecting: "Connecting…",
    closed: "Disconnected",
  } satisfies Record<ConnectionStatus, string>;

  if (onboardingState === "checking") {
    return (
      <div className="app-shell">
        <Titlebar />
        <div className="app-bootstrapping" />
      </div>
    );
  }

  if (onboardingState === "error") {
    return (
      <div className="app-shell">
        <Titlebar />
        <BootstrapErrorScreen
          message={bootstrapError ?? "Something went wrong while starting Orca."}
          connectionStatus={connectionStatus}
          onRetry={retryBootstrap}
        />
      </div>
    );
  }

  if (onboardingState === "needs-onboarding") {
    return (
      <div className="app-shell">
        <Titlebar />
        <OnboardingView
          onComplete={async () => {
            await refreshAgents();
            setOnboardingState("complete");
          }}
        />
      </div>
    );
  }

  const selectedGoal = goals.find((g) => g.id === selectedOrchestratorGoalId) ?? null;

  return (
    <div className="app-shell">
      <Titlebar />
      {onboardingState === "complete" && <NoReadyAgentsBanner agents={agents} />}

      {mode === "detail" && currentGoalId ? (
        <div className="main-content main-content--full">
          <GoalDetailView
            goalId={currentGoalId}
            onBack={handleBackToList}
            refreshKey={detailRefreshKey}
          />
        </div>
      ) : (
        <div className="orchestrator-shell">
          {/* ── Goals rail — LEFT ── */}
          <aside className="orchestrator-rail" aria-label="Goals">
            <div className="orchestrator-rail-header">
              <span className="orchestrator-rail-title">Goals</span>
              <button
                type="button"
                className="orchestrator-rail-new-btn"
                onClick={() => setShowCreateFlow(true)}
                disabled={!connected}
                aria-label="New Goal"
                title="New Goal"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            {goals.length === 0 ? (
              <p className="orchestrator-rail-empty">
                No goals yet. Click <strong>+</strong> to start.
              </p>
            ) : (
              <ul className="orchestrator-rail-list">
                {goals.map((goal) => (
                  <GoalCard
                    key={goal.id}
                    goal={goal}
                    selected={goal.id === selectedOrchestratorGoalId}
                    onSelect={() => setSelectedOrchestratorGoalId(goal.id)}
                    onView={() => openGoalDetail(goal.id)}
                  />
                ))}
              </ul>
            )}
            <div className="orchestrator-rail-footer">
              <button
                type="button"
                className="orchestrator-rail-settings-btn"
                onClick={() => setShowSettings(true)}
              >
                <GearIcon size={15} />
                <span>Settings</span>
              </button>
            </div>
          </aside>

          {/* ── Main area: topbar + pane ── */}
          <div className="orchestrator-main">
            <nav className="orchestrator-tabs" role="tablist" aria-label="Workspace views">
              {/* Breadcrumb */}
              <div className="orchestrator-breadcrumb">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" fill="currentColor" />
                </svg>
                <span className="orchestrator-breadcrumb-name">
                  {selectedGoal?.title ?? "Select a goal"}
                </span>
              </div>

              {/* Tab buttons */}
              <div className="orchestrator-tab-group">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "workspaces"}
                  className={`orchestrator-tab${activeTab === "workspaces" ? " orchestrator-tab--active" : ""}`}
                  onClick={() => setActiveTab("workspaces")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
                  </svg>
                  Workspaces
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "orchestrator"}
                  className={`orchestrator-tab${activeTab === "orchestrator" ? " orchestrator-tab--active" : ""}`}
                  onClick={() => setActiveTab("orchestrator")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z" />
                  </svg>
                  Orchestrator
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "workflows"}
                  className={`orchestrator-tab${activeTab === "workflows" ? " orchestrator-tab--active" : ""}`}
                  onClick={() => setActiveTab("workflows")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" /><rect x="9" y="15" width="6" height="6" rx="1" /><path d="M6 9v3h12V9M12 12v3" />
                  </svg>
                  Workflows
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "reasoning"}
                  className={`orchestrator-tab${activeTab === "reasoning" ? " orchestrator-tab--active" : ""}`}
                  onClick={() => setActiveTab("reasoning")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /><circle cx="12" cy="12" r="4" />
                  </svg>
                  Metrics
                </button>
              </div>

              {/* Right actions */}
              <div className="orchestrator-tab-actions">
                {selectedOrchestratorGoalId && (
                  <button
                    type="button"
                    className="orchestrator-detail-btn"
                    onClick={() => openGoalDetail(selectedOrchestratorGoalId)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2" />
                    </svg>
                    Goal Details
                  </button>
                )}
                <span className={`orchestrator-status-dot orchestrator-status-dot--${connectionStatus}`} title={statusLabel[connectionStatus]} />
              </div>
            </nav>

            {connectionStatus === "closed" && (
              <div className="error-banner error-banner--inline">
                Daemon disconnected — start the daemon to use Orca.
              </div>
            )}

            {activeTab === "workspaces" ? (
              <section className="workspaces-pane" role="tabpanel" aria-label="Workspaces">
                <WorkspacesPage
                  onCreateGoal={() => setShowCreateFlow(true)}
                  onOpenGoal={() => setActiveTab("orchestrator")}
                />
              </section>
            ) : activeTab === "orchestrator" ? (
              <section className="orchestrator-pane" role="tabpanel" aria-label="Orchestrator">
                {goals.length === 0 ? (
                  <EmptyGoalsView
                    onCreate={() => setShowCreateFlow(true)}
                    disabled={!connected}
                  />
                ) : (
                  <OrcaChat
                    goals={goals}
                    selectedGoalId={selectedOrchestratorGoalId}
                    connectionStatus={connectionStatus}
                    onViewWorkflows={() => setActiveTab("workflows")}
                  />
                )}
              </section>
            ) : activeTab === "reasoning" ? (
              <section className="reasoning-pane" role="tabpanel" aria-label="Metrics">
                <div className="reasoning-card">
                  <div className="reasoning-card-header">
                    <h2 className="reasoning-card-title">Runtime Diagnostics</h2>
                    <button
                      type="button"
                      className="reasoning-action-btn"
                      onClick={loadDiagnostics}
                      disabled={diagnosticsLoading}
                    >
                      {diagnosticsLoading ? "Loading…" : "Refresh"}
                    </button>
                  </div>
                  {diagnosticsError && <p className="reasoning-error">{diagnosticsError}</p>}
                  {!diagnosticsLoading && !diagnosticsError && diagnostics !== null && (
                    <>
                      <h3 className="reasoning-card-subtitle">Plugins ({diagnostics.plugins.length})</h3>
                      <ul className="reasoning-list">
                        {diagnostics.plugins.map((p) => (
                          <li key={p.id}>{p.id} — {p.capabilities.join(", ")}</li>
                        ))}
                      </ul>
                      <h3 className="reasoning-card-subtitle">Skills ({diagnostics.skills.length})</h3>
                      <ul className="reasoning-list">
                        {diagnostics.skills.map((s) => (
                          <li key={s.id}>{s.id} — {s.extensionPoint} ({s.title})</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </section>
            ) : (
              <section className="workflows-pane" role="tabpanel" aria-label="Workflows">
                <WorkflowsPage />
              </section>
            )}
          </div>
        </div>
      )}

      {showCreateFlow && (
        <CreateGoalFlow
          connectionStatus={connectionStatus}
          onClose={() => setShowCreateFlow(false)}
          onDone={handleCreateFlowDone}
        />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          agents={agents}
          onToggleAgent={toggleAgentConnection}
        />
      )}
    </div>
  );
}

function GoalCard({
  goal,
  selected = false,
  onSelect,
  onView,
}: {
  goal: Goal;
  selected?: boolean;
  onSelect?: () => void;
  onView: () => void;
}) {
  const MAX_DESC = 140;
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(goal.title);
  const [editDescription, setEditDescription] = useState(goal.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const truncated =
    goal.description.length > MAX_DESC
      ? goal.description.slice(0, MAX_DESC) + "…"
      : goal.description;

  function startEdit() {
    setEditTitle(goal.title);
    setEditDescription(goal.description);
    setError(null);
    setEditing(true);
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const patch: { title?: string; description?: string } = {};
      if (editTitle !== goal.title) patch.title = editTitle;
      if (editDescription !== goal.description) patch.description = editDescription;
      if (patch.title === undefined && patch.description === undefined) {
        setEditing(false);
        return;
      }
      await updateGoal(goal.id, patch);
      setEditing(false);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to update goal."));
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    if (!confirm(`Archive "${goal.title}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await archiveGoal(goal.id);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to archive goal."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className={`goal-card${selected ? " goal-card--selected" : ""}`}
      onClick={() => {
        if (!editing) onSelect?.();
      }}
    >
      {editing ? (
        <form onSubmit={saveEdit} className="goal-card-form">
          <label htmlFor={`gc-title-${goal.id}`}>Title</label>
          <input
            id={`gc-title-${goal.id}`}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            maxLength={200}
            required
            disabled={busy}
          />
          <label htmlFor={`gc-desc-${goal.id}`}>Description</label>
          <textarea
            id={`gc-desc-${goal.id}`}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            maxLength={4000}
            rows={3}
            disabled={busy}
          />
          {error && <div className="form-error">{error}</div>}
          <div className="goal-card-actions">
            <button type="submit" className="goal-card-btn goal-card-btn--primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="goal-card-btn"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="goal-card-head">
            <span className="goal-card-title">{goal.title}</span>
            <span className={`goal-card-status goal-card-status--${goal.status}`}>
              {goal.status}
            </span>
          </div>
          {truncated && <p className="goal-card-desc">{truncated}</p>}
          <time className="goal-card-meta mono" dateTime={goal.createdAt}>
            {new Date(goal.createdAt).toLocaleDateString()}
          </time>
          {error && <div className="form-error">{error}</div>}
          <div className="goal-card-actions">
            <button
              type="button"
              className="goal-card-btn goal-card-btn--primary"
              onClick={(event) => {
                event.stopPropagation();
                onView();
              }}
              disabled={busy}
            >
              View
            </button>
            <button
              type="button"
              className="goal-card-btn"
              onClick={(event) => {
                event.stopPropagation();
                startEdit();
              }}
              disabled={busy}
            >
              Edit
            </button>
            <button
              type="button"
              className="goal-card-btn goal-card-btn--danger"
              onClick={(event) => {
                event.stopPropagation();
                void handleArchive();
              }}
              disabled={busy}
            >
              Archive
            </button>
          </div>
        </>
      )}
    </li>
  );
}
