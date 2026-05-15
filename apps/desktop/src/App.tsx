import { useState, useEffect, FormEvent } from "react";
import { Goal } from "@orca/contracts";
import {
  fetchHealth,
  listGoals,
  createGoal,
  updateGoal,
  archiveGoal,
  openEventStream,
  ApiError,
  type ConnectionStatus,
} from "./api";
import "./styles.css";

export default function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  // Initial goal load
  useEffect(() => {
    loadGoals();
  }, []);

  // WebSocket event stream — refreshes goal list on any goal.* event
  useEffect(() => {
    const stream = openEventStream({
      onEvent(event) {
        if (event.type.startsWith("goal.")) {
          loadGoals();
        }
      },
      onStatus: setConnectionStatus,
    });
    return () => stream.close();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await createGoal({ title, description });
      setTitle("");
      setDescription("");
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError("Failed to create goal. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const connected = connectionStatus === "open";

  const statusLabel = {
    open: "Connected",
    connecting: "Connecting…",
    closed: "Disconnected",
  } satisfies Record<ConnectionStatus, string>;

  return (
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

      <main className="main-content">
        <section className="create-section">
          <h2>New Goal</h2>
          <form onSubmit={handleSubmit} className="create-form">
            <div className="form-field">
              <label htmlFor="goal-title">Title</label>
              <input
                id="goal-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
                disabled={!connected || submitting}
                placeholder="What are you trying to achieve?"
              />
            </div>
            <div className="form-field">
              <label htmlFor="goal-description">Description</label>
              <textarea
                id="goal-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={4000}
                disabled={!connected || submitting}
                placeholder="Optional details…"
                rows={4}
              />
            </div>
            {formError && <div className="form-error">{formError}</div>}
            <button
              type="submit"
              className="submit-button"
              disabled={!connected || submitting}
            >
              {submitting ? "Creating…" : "Create Goal"}
            </button>
          </form>
        </section>

        <section className="goals-section">
          <h2>Goals</h2>
          {goals.length === 0 ? (
            <p className="empty-state">No goals yet. Create one to get started.</p>
          ) : (
            <ul className="goals-list">
              {goals.map((goal) => (
                <GoalItem key={goal.id} goal={goal} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function GoalItem({ goal }: { goal: Goal }) {
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
      setError(err instanceof ApiError ? err.message : "Failed to update goal.");
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
      setError(err instanceof ApiError ? err.message : "Failed to archive goal.");
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
