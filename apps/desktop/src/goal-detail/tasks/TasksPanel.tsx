import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionSummary, Task, TaskGeneration, TaskRole, TaskStatus, Workspace } from "@orca/contracts";
import {
  generateTasks,
  listSessions,
  listTasks,
  patchTask,
  splitTask,
  toErrorMessage,
  type SplitTaskRequest,
  type UpdateTaskRequest,
} from "../../api";
import { TaskEditDialog } from "./TaskEditDialog";
import { TaskRow } from "./TaskRow";
import { TaskSplitDialog } from "./TaskSplitDialog";

const TASK_ROLES: TaskRole[] = ["architect", "engineer", "reviewer", "qa", "generalist"];
const TASK_STATUSES: TaskStatus[] = [
  "proposed",
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
  "archived",
];

type Props = {
  goalId: string;
  workspaces: Workspace[];
  refreshKey?: number;
};

export function TasksPanel({ goalId, workspaces, refreshKey = 0 }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [generations, setGenerations] = useState<TaskGeneration[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [roleFilter, setRoleFilter] = useState<TaskRole | "all">("all");
  const [workspaceFilter, setWorkspaceFilter] = useState<string | "all">("all");
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [splitTarget, setSplitTarget] = useState<Task | null>(null);

  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [taskBody, sessionBody] = await Promise.all([
        listTasks(goalId, { includeArchived: true, limit: 50 }),
        listSessions(goalId),
      ]);
      setTasks(taskBody.tasks);
      setGenerations(taskBody.generations);
      setSessions(sessionBody.sessions);
    } catch (err) {
      setError(toErrorMessage(err, "Failed to load tasks."));
    } finally {
      setLoading(false);
    }
  }, [goalId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const sessionCountByTaskId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (session.taskId) {
        counts.set(session.taskId, (counts.get(session.taskId) ?? 0) + 1);
      }
    }
    return counts;
  }, [sessions]);

  const filteredTasks = tasks.filter((task) => {
    if (statusFilter !== "all" && task.status !== statusFilter) return false;
    if (roleFilter !== "all" && task.role !== roleFilter) return false;
    if (workspaceFilter !== "all" && task.workspaceId !== workspaceFilter) return false;
    return true;
  });

  const latestGeneration = generations[0] ?? null;
  const generateDisabled =
    generating ||
    latestGeneration?.status === "pending" ||
    latestGeneration?.status === "running";

  async function handleGenerate() {
    setGenerating(true);
    setActionError(null);
    try {
      const response = await generateTasks(goalId);
      setGenerations((current) => [response.generation, ...current.filter((g) => g.id !== response.generation.id)]);
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Generate tasks failed."));
    } finally {
      setGenerating(false);
    }
  }

  async function handlePatch(taskId: string, patch: UpdateTaskRequest, rethrow = false) {
    setActionError(null);
    try {
      await patchTask(taskId, patch);
      setEditTask(null);
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Task update failed."));
      if (rethrow) throw err;
    }
  }

  async function handleSplit(taskId: string, body: SplitTaskRequest, rethrow = false) {
    setActionError(null);
    try {
      await splitTask(taskId, body);
      setSplitTarget(null);
      await load();
    } catch (err) {
      setActionError(toErrorMessage(err, "Task split failed."));
      if (rethrow) throw err;
    }
  }

  const hasAnyFilter =
    statusFilter !== "all" || roleFilter !== "all" || workspaceFilter !== "all";

  return (
    <section className="goal-detail-section tasks-panel" aria-label="Tasks">
      <div className="goal-detail-section-header">
        <h3 className="goal-detail-section-title">
          Tasks {tasks.length > 0 ? `(${tasks.length})` : ""}
        </h3>
        <button
          type="button"
          className="goal-action-button tasks-generate-button"
          onClick={() => void handleGenerate()}
          disabled={generateDisabled}
        >
          {generateDisabled ? "Generating..." : "Generate tasks"}
        </button>
      </div>

      {latestGeneration && <TaskGenerationBanner generation={latestGeneration} />}

      {actionError && (
        <p className="form-error tasks-action-error" role="alert">
          {actionError}
        </p>
      )}

      {loading && tasks.length === 0 && (
        <div className="tasks-panel-loading" aria-label="Loading tasks">
          <p>Loading...</p>
        </div>
      )}

      {!loading && error && (
        <div className="tasks-panel-error">
          <p className="form-error">{error}</p>
          <button type="button" className="goal-action-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && tasks.length === 0 && (
        <div className="tasks-panel-empty">
          <p className="empty-state">No tasks yet.</p>
          <button
            type="button"
            className="goal-action-button"
            onClick={() => void handleGenerate()}
            disabled={generateDisabled}
          >
            Generate tasks
          </button>
        </div>
      )}

      {tasks.length > 0 && (
        <>
          <TaskFilters
            statusFilter={statusFilter}
            roleFilter={roleFilter}
            workspaceFilter={workspaceFilter}
            workspaces={workspaces}
            onStatusChange={setStatusFilter}
            onRoleChange={setRoleFilter}
            onWorkspaceChange={setWorkspaceFilter}
          />

          {filteredTasks.length === 0 ? (
            <p className="empty-state">
              {hasAnyFilter ? "No tasks match the selected filters." : "No tasks yet."}
            </p>
          ) : (
            <ul className="task-list">
              {filteredTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  workspaceName={
                    task.workspaceId ? (workspaceById.get(task.workspaceId)?.name ?? task.workspaceId) : null
                  }
                  sessionCount={sessionCountByTaskId.get(task.id) ?? 0}
                  onEdit={() => setEditTask(task)}
                  onSplit={() => setSplitTarget(task)}
                  onCancel={() => void handlePatch(task.id, { status: "cancelled" })}
                  onArchive={() => void handlePatch(task.id, { status: "archived" })}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {editTask && (
        <TaskEditDialog
          task={editTask}
          workspaces={workspaces}
          onSave={(patch) => handlePatch(editTask.id, patch, true)}
          onClose={() => setEditTask(null)}
        />
      )}

      {splitTarget && (
        <TaskSplitDialog
          task={splitTarget}
          workspaces={workspaces}
          onSplit={(body) => handleSplit(splitTarget.id, body, true)}
          onClose={() => setSplitTarget(null)}
        />
      )}
    </section>
  );
}

type FilterProps = {
  statusFilter: TaskStatus | "all";
  roleFilter: TaskRole | "all";
  workspaceFilter: string | "all";
  workspaces: Workspace[];
  onStatusChange: (status: TaskStatus | "all") => void;
  onRoleChange: (role: TaskRole | "all") => void;
  onWorkspaceChange: (workspaceId: string | "all") => void;
};

function TaskFilters({
  statusFilter,
  roleFilter,
  workspaceFilter,
  workspaces,
  onStatusChange,
  onRoleChange,
  onWorkspaceChange,
}: FilterProps) {
  return (
    <div className="task-filters" aria-label="Task filters">
      <div className="task-filter-group" aria-label="Status filters">
        <FilterButton active={statusFilter === "all"} onClick={() => onStatusChange("all")}>
          All statuses
        </FilterButton>
        {TASK_STATUSES.map((status) => (
          <FilterButton
            key={status}
            active={statusFilter === status}
            onClick={() => onStatusChange(status)}
          >
            {status.replace(/_/g, " ")}
          </FilterButton>
        ))}
      </div>

      <div className="task-filter-group" aria-label="Role filters">
        <FilterButton active={roleFilter === "all"} onClick={() => onRoleChange("all")}>
          All roles
        </FilterButton>
        {TASK_ROLES.map((role) => (
          <FilterButton
            key={role}
            active={roleFilter === role}
            onClick={() => onRoleChange(role)}
          >
            {role.replace(/_/g, " ")}
          </FilterButton>
        ))}
      </div>

      {workspaces.length > 0 && (
        <div className="task-filter-group" aria-label="Workspace filters">
          <FilterButton active={workspaceFilter === "all"} onClick={() => onWorkspaceChange("all")}>
            All workspaces
          </FilterButton>
          {workspaces.map((workspace) => (
            <FilterButton
              key={workspace.id}
              active={workspaceFilter === workspace.id}
              onClick={() => onWorkspaceChange(workspace.id)}
            >
              {workspace.name}
            </FilterButton>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`task-filter-chip${active ? " task-filter-chip--active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TaskGenerationBanner({ generation }: { generation: TaskGeneration }) {
  const time = generation.finishedAt ?? generation.startedAt ?? generation.requestedAt;
  const detail =
    generation.status === "failed" && generation.failureCode
      ? `failure: ${generation.failureCode}`
      : generation.sparse
        ? "sparse input"
        : null;

  return (
    <div className={`task-generation-banner task-generation-banner--${generation.status}`}>
      <span className="task-generation-status">{generation.status}</span>
      <span>{formatDateTime(time)}</span>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
