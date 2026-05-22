import { useState } from "react";
import {
  M7_TASK_MAX_DESCRIPTION_CHARS,
  M7_TASK_MAX_TITLE_CHARS,
  type Task,
  type TaskRole,
  type Workspace,
} from "@orca/contracts";
import { toErrorMessage, type SplitTaskRequest } from "../../api";

const TASK_ROLES: TaskRole[] = ["architect", "engineer", "reviewer", "qa", "generalist"];

type ChildDraft = {
  title: string;
  description: string;
  role: TaskRole;
  workspaceId: string;
};

type Props = {
  task: Task;
  workspaces: Workspace[];
  onSplit: (body: SplitTaskRequest) => Promise<void>;
  onClose: () => void;
  initialChildren?: Array<{ title: string; role?: TaskRole }>;
};

export function TaskSplitDialog({ task, workspaces, onSplit, onClose, initialChildren = [] }: Props) {
  const [children, setChildren] = useState<ChildDraft[]>(
    initialChildren.length > 0
      ? initialChildren.map((child) => ({
          title: child.title,
          description: "",
          role: child.role ?? task.role,
          workspaceId: task.workspaceId ?? "",
        }))
      : [
          {
            title: "",
            description: "",
            role: task.role,
            workspaceId: task.workspaceId ?? "",
          },
        ],
  );
  const [setParentStatus, setSetParentStatus] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseChildren();
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSplit({
        children: parsed.children,
        setParentStatus: setParentStatus ? "blocked" : undefined,
      });
    } catch (err) {
      setError(toErrorMessage(err, "Split failed."));
      setSaving(false);
    }
  }

  function parseChildren():
    | { ok: true; children: SplitTaskRequest["children"] }
    | { ok: false; error: string } {
    const parsed = children.map((child) => ({
      ...child,
      title: child.title.trim(),
    }));
    if (parsed.some((child) => !child.title)) {
      return { ok: false, error: "Each child task needs a title." };
    }
    if (parsed.some((child) => child.title.length > M7_TASK_MAX_TITLE_CHARS)) {
      return { ok: false, error: `Child titles must be ${M7_TASK_MAX_TITLE_CHARS} characters or fewer.` };
    }
    if (parsed.some((child) => child.description.length > M7_TASK_MAX_DESCRIPTION_CHARS)) {
      return {
        ok: false,
        error: `Child descriptions must be ${M7_TASK_MAX_DESCRIPTION_CHARS} characters or fewer.`,
      };
    }

    return {
      ok: true,
      children: parsed.map((child) => ({
        title: child.title,
        description: child.description,
        role: child.role,
        workspaceId: child.workspaceId || undefined,
        acceptanceCriteria: [],
        validationSteps: [],
        dependencies: [],
        sources: [],
      })),
    };
  }

  function updateChild(index: number, patch: Partial<ChildDraft>) {
    setChildren((current) =>
      current.map((child, i) => (i === index ? { ...child, ...patch } : child)),
    );
  }

  return (
    <div className="task-split-dialog" role="dialog" aria-modal="true" aria-label="Split Task">
      <div className="task-dialog-content">
        <h4 className="task-dialog-title">Split Task</h4>
        <div className="task-split-parent">
          <span className="task-row-status task-row-status--blocked">Parent</span>
          <p>{task.title}</p>
        </div>

        <form className="create-form" onSubmit={(e) => void handleSubmit(e)}>
          {children.map((child, index) => (
            <div className="task-split-child" key={index}>
              <div className="task-split-child-header">
                <span>Child {index + 1}</span>
                {children.length > 1 && (
                  <button
                    type="button"
                    className="goal-action-button"
                    onClick={() => setChildren((current) => current.filter((_, i) => i !== index))}
                    disabled={saving}
                  >
                    Remove
                  </button>
                )}
              </div>

              <label htmlFor={`task-split-title-${index}`}>Title</label>
              <input
                id={`task-split-title-${index}`}
                type="text"
                value={child.title}
                onChange={(e) => updateChild(index, { title: e.target.value })}
                maxLength={M7_TASK_MAX_TITLE_CHARS}
                disabled={saving}
              />

              <label htmlFor={`task-split-description-${index}`}>Description</label>
              <textarea
                id={`task-split-description-${index}`}
                value={child.description}
                onChange={(e) => updateChild(index, { description: e.target.value })}
                maxLength={M7_TASK_MAX_DESCRIPTION_CHARS}
                rows={2}
                disabled={saving}
              />

              <div className="task-dialog-grid">
                <label htmlFor={`task-split-role-${index}`}>Role</label>
                <select
                  id={`task-split-role-${index}`}
                  value={child.role}
                  onChange={(e) => updateChild(index, { role: e.target.value as TaskRole })}
                  disabled={saving}
                >
                  {TASK_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>

                <label htmlFor={`task-split-workspace-${index}`}>Workspace</label>
                <select
                  id={`task-split-workspace-${index}`}
                  value={child.workspaceId}
                  onChange={(e) => updateChild(index, { workspaceId: e.target.value })}
                  disabled={saving}
                >
                  <option value="">Unassigned</option>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}

          <button
            type="button"
            className="goal-action-button task-split-add-child"
            onClick={() =>
              setChildren((current) => [
                ...current,
                { title: "", description: "", role: task.role, workspaceId: task.workspaceId ?? "" },
              ])
            }
            disabled={saving || children.length >= 20}
          >
            Add child
          </button>

          <label className="task-split-parent-status">
            <input
              type="checkbox"
              checked={setParentStatus}
              onChange={(e) => setSetParentStatus(e.target.checked)}
              disabled={saving}
            />
            {" "}Mark parent blocked
          </label>

          {error && <p className="form-error task-dialog-error">{error}</p>}

          <div className="task-dialog-actions">
            <button type="submit" className="goal-action-button" disabled={saving}>
              {saving ? "Splitting..." : "Split"}
            </button>
            <button type="button" className="goal-action-button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
