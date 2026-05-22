import { useState, useEffect, FormEvent } from "react";
import { Goal, DomainEventType, type PluginSummary, type SkillSummary } from "@orca/contracts";
import {
  fetchHealth,
  listAgents,
  listGoals,
  listPlugins,
  listSkills,
  updateGoal,
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
import "./styles.css";

type OnboardingState = "checking" | "needs-onboarding" | "complete" | "error";

type AppMode = "list" | "detail";

function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

type Diagnostics = { plugins: PluginSummary[]; skills: SkillSummary[] };

const DETAIL_REFETCH_EVENTS = new Set<DomainEventType>(["goal.refined", "workspace.attached", "workspace.removed"]);
const GOAL_LIST_EVENTS = new Set<DomainEventType>(["goal.created", "goal.updated", "goal.archived"]);

export default function App() {
  const [onboardingState, setOnboardingState] = useState<OnboardingState>("checking");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [mode, setMode] = useState<AppMode>("list");
  const [currentGoalId, setCurrentGoalId] = useState<string | null>(null);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [showCreateFlow, setShowCreateFlow] = useState(false);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

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

  useEffect(() => {
    loadGoals();
    loadDiagnostics();
  }, []);

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
    setCurrentGoalId(goalId);
    setDetailRefreshKey(0);
    setMode("detail");
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
        <OnboardingView onComplete={() => setOnboardingState("complete")} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app">
      <header className="status-header">
        <h1 className="app-title">Orca</h1>
        <div className={`connection-indicator connection-indicator--${connectionStatus}`}>
          {statusLabel[connectionStatus]}
        </div>
      </header>

      {connectionStatus === "closed" && (
        <div className="error-banner">
          Daemon is disconnected — start the daemon to use Orca.
        </div>
      )}

      {mode === "detail" && currentGoalId ? (
        <div className="main-content main-content--full">
          <GoalDetailView
            goalId={currentGoalId}
            onBack={handleBackToList}
            refreshKey={detailRefreshKey}
          />
        </div>
      ) : (
        <main className="main-content">
          <section className="create-section">
            <h2>New Goal</h2>
            <p className="create-section-hint">
              Create a structured Goal with guided refinement and workspace attachment.
            </p>
            <button
              type="button"
              className="submit-button"
              onClick={() => setShowCreateFlow(true)}
              disabled={!connected}
            >
              Create Goal…
            </button>
          </section>

          <section className="goals-section">
            <h2>Goals</h2>
            {goals.length === 0 ? (
              <p className="empty-state">No goals yet. Create one to get started.</p>
            ) : (
              <ul className="goals-list">
                {goals.map((goal) => (
                  <GoalItem
                    key={goal.id}
                    goal={goal}
                    onView={() => openGoalDetail(goal.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="diagnostics-section">
            <div className="diagnostics-header">
              <h2>Runtime Diagnostics</h2>
              <button
                type="button"
                className="goal-action-button"
                onClick={loadDiagnostics}
                disabled={diagnosticsLoading}
              >
                {diagnosticsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>
            {diagnosticsError && <p className="diagnostics-error">{diagnosticsError}</p>}
            {!diagnosticsLoading && !diagnosticsError && diagnostics !== null && (
              <>
                <h3 className="diagnostics-subheading">Plugins ({diagnostics.plugins.length})</h3>
                <ul className="diagnostics-list">
                  {diagnostics.plugins.map((p) => (
                    <li key={p.id}>{p.id} — {p.capabilities.join(", ")}</li>
                  ))}
                </ul>
                <h3 className="diagnostics-subheading">Skills ({diagnostics.skills.length})</h3>
                <ul className="diagnostics-list">
                  {diagnostics.skills.map((s) => (
                    <li key={s.id}>{s.id} — {s.extensionPoint} ({s.title})</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </main>
      )}

      {showCreateFlow && (
        <CreateGoalFlow
          connectionStatus={connectionStatus}
          onClose={() => setShowCreateFlow(false)}
          onDone={handleCreateFlowDone}
        />
      )}
      </div>
    </div>
  );
}

function GoalItem({ goal, onView }: { goal: Goal; onView: () => void }) {
  const MAX_DESC = 200;
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
    <li className="goal-item">
      {editing ? (
        <form onSubmit={saveEdit} className="create-form">
          <div className="form-field">
            <label htmlFor={`edit-title-${goal.id}`}>Title</label>
            <input
              id={`edit-title-${goal.id}`}
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              maxLength={200}
              required
              disabled={busy}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`edit-desc-${goal.id}`}>Description</label>
            <textarea
              id={`edit-desc-${goal.id}`}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              maxLength={4000}
              rows={3}
              disabled={busy}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="goal-actions">
            <button type="submit" className="submit-button" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="goal-action-button"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="goal-header">
            <span className="goal-title">{goal.title}</span>
            <span className={`goal-status goal-status--${goal.status}`}>
              {goal.status}
            </span>
          </div>
          {truncated && <p className="goal-description">{truncated}</p>}
          <div className="goal-meta">
            <time dateTime={goal.createdAt}>
              {new Date(goal.createdAt).toLocaleString()}
            </time>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="goal-actions">
            <button
              type="button"
              className="goal-action-button"
              onClick={onView}
              disabled={busy}
            >
              View
            </button>
            <button
              type="button"
              className="goal-action-button"
              onClick={startEdit}
              disabled={busy}
            >
              Edit
            </button>
            <button
              type="button"
              className="goal-action-button goal-action-button--danger"
              onClick={handleArchive}
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
