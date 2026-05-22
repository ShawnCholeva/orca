import { useState } from "react";
import {
  M7_TASK_MAX_ACCEPTANCE_CRITERIA,
  M7_TASK_MAX_DESCRIPTION_CHARS,
  M7_TASK_MAX_ITEM_TEXT_CHARS,
  M7_TASK_MAX_TITLE_CHARS,
  M7_TASK_MAX_VALIDATION_STEPS,
  type Task,
  type TaskRole,
  type TaskStatus,
  type Workspace,
} from "@orca/contracts";
import { toErrorMessage, type UpdateTaskRequest } from "../../api";

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

export type TaskEditSaveData = UpdateTaskRequest;

type Props = {
  task: Task;
  workspaces: Workspace[];
  onSave: (patch: TaskEditSaveData) => Promise<void>;
  onClose: () => void;
  initialStatus?: TaskStatus;
  addAcceptanceCriteria?: string[];
};

export function TaskEditDialog({ task, workspaces, onSave, onClose, initialStatus, addAcceptanceCriteria = [] }: Props) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [role, setRole] = useState<TaskRole>(task.role);
  const [status, setStatus] = useState<TaskStatus>(initialStatus ?? task.status);
  const [workspaceId, setWorkspaceId] = useState(task.workspaceId ?? "");
  const [dependenciesText, setDependenciesText] = useState(task.dependencies.join("\n"));
  const [criteriaText, setCriteriaText] = useState(
    [...task.acceptanceCriteria.map((item) => item.text), ...addAcceptanceCriteria].join("\n"),
  );
  const [validationText, setValidationText] = useState(
    task.validationSteps.map((item) => item.text).join("\n"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseForm();
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.patch);
    } catch (err) {
      setError(toErrorMessage(err, "Save failed."));
      setSaving(false);
    }
  }

  function parseForm():
    | { ok: true; patch: TaskEditSaveData }
    | { ok: false; error: string } {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return { ok: false, error: "Title is required." };
    if (trimmedTitle.length > M7_TASK_MAX_TITLE_CHARS) {
      return { ok: false, error: `Title must be ${M7_TASK_MAX_TITLE_CHARS} characters or fewer.` };
    }
    if (description.length > M7_TASK_MAX_DESCRIPTION_CHARS) {
      return {
        ok: false,
        error: `Description must be ${M7_TASK_MAX_DESCRIPTION_CHARS} characters or fewer.`,
      };
    }

    const acceptanceCriteria = parseLines(criteriaText);
    const validationSteps = parseLines(validationText);
    const dependencies = parseLines(dependenciesText);

    const itemError =
      validateLineSet("Acceptance criteria", acceptanceCriteria, M7_TASK_MAX_ACCEPTANCE_CRITERIA) ??
      validateLineSet("Validation steps", validationSteps, M7_TASK_MAX_VALIDATION_STEPS) ??
      validateLineSet("Dependencies", dependencies, 1000, false);
    if (itemError) return { ok: false, error: itemError };

    return {
      ok: true,
      patch: {
        title: trimmedTitle,
        description,
        role,
        status,
        workspaceId: workspaceId || null,
        dependencies,
        acceptanceCriteria,
        validationSteps: validationSteps.map((text) => ({ text, kind: "manual" })),
      },
    };
  }

  return (
    <div className="task-edit-dialog" role="dialog" aria-modal="true" aria-label="Edit Task">
      <div className="task-dialog-content">
        <h4 className="task-dialog-title">Edit Task</h4>
        <form className="create-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor={`task-title-${task.id}`}>Title</label>
          <input
            id={`task-title-${task.id}`}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={M7_TASK_MAX_TITLE_CHARS}
            disabled={saving}
          />

          <label htmlFor={`task-description-${task.id}`}>Description</label>
          <textarea
            id={`task-description-${task.id}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={M7_TASK_MAX_DESCRIPTION_CHARS}
            rows={4}
            disabled={saving}
          />

          <div className="task-dialog-grid">
            <label htmlFor={`task-role-${task.id}`}>Role</label>
            <select
              id={`task-role-${task.id}`}
              value={role}
              onChange={(e) => setRole(e.target.value as TaskRole)}
              disabled={saving}
            >
              {TASK_ROLES.map((value) => (
                <option key={value} value={value}>
                  {formatLabel(value)}
                </option>
              ))}
            </select>

            <label htmlFor={`task-status-${task.id}`}>Status</label>
            <select
              id={`task-status-${task.id}`}
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              disabled={saving}
            >
              {TASK_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {formatLabel(value)}
                </option>
              ))}
            </select>

            <label htmlFor={`task-workspace-${task.id}`}>Workspace</label>
            <select
              id={`task-workspace-${task.id}`}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
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

          <label htmlFor={`task-dependencies-${task.id}`}>Dependencies</label>
          <textarea
            id={`task-dependencies-${task.id}`}
            value={dependenciesText}
            onChange={(e) => setDependenciesText(e.target.value)}
            rows={2}
            disabled={saving}
          />

          <label htmlFor={`task-criteria-${task.id}`}>Acceptance Criteria</label>
          <textarea
            id={`task-criteria-${task.id}`}
            value={criteriaText}
            onChange={(e) => setCriteriaText(e.target.value)}
            maxLength={M7_TASK_MAX_ACCEPTANCE_CRITERIA * (M7_TASK_MAX_ITEM_TEXT_CHARS + 1)}
            rows={3}
            disabled={saving}
          />

          <label htmlFor={`task-validation-${task.id}`}>Validation Steps</label>
          <textarea
            id={`task-validation-${task.id}`}
            value={validationText}
            onChange={(e) => setValidationText(e.target.value)}
            maxLength={M7_TASK_MAX_VALIDATION_STEPS * (M7_TASK_MAX_ITEM_TEXT_CHARS + 1)}
            rows={3}
            disabled={saving}
          />

          {error && <p className="form-error task-dialog-error">{error}</p>}

          <div className="task-dialog-actions">
            <button type="submit" className="goal-action-button" disabled={saving}>
              {saving ? "Saving..." : "Save"}
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

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function validateLineSet(
  label: string,
  lines: string[],
  maxCount: number,
  enforceItemCap = true,
): string | null {
  if (lines.length > maxCount) return `${label} must contain ${maxCount} items or fewer.`;
  if (enforceItemCap && lines.some((line) => line.length > M7_TASK_MAX_ITEM_TEXT_CHARS)) {
    return `${label} items must be ${M7_TASK_MAX_ITEM_TEXT_CHARS} characters or fewer.`;
  }
  return null;
}

function formatLabel(value: string): string {
  return value.replace(/_/g, " ");
}
