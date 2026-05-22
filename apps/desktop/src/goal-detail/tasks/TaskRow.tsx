import { useState } from "react";
import type { Task } from "@orca/contracts";

type Props = {
  task: Task;
  workspaceName: string | null;
  sessionCount: number;
  onEdit: () => void;
  onSplit: () => void;
  onCancel: () => void;
  onArchive: () => void;
};

export function TaskRow({
  task,
  workspaceName,
  sessionCount,
  onEdit,
  onSplit,
  onCancel,
  onArchive,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  function runAction(action: () => void) {
    setMenuOpen(false);
    action();
  }

  return (
    <li className={`task-row task-row--${task.status}`} data-task-id={task.id}>
      <div className="task-row-main">
        <div className="task-row-title-line">
          <p className="task-row-title">{task.title}</p>
          <button
            type="button"
            className="task-row-menu-button"
            aria-label={`Actions for ${task.title}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ...
          </button>
        </div>

        {task.description && <p className="task-row-description">{task.description}</p>}

        <div className="task-row-meta">
          <span className={`task-row-role task-row-role--${task.role}`}>{formatLabel(task.role)}</span>
          <span className={`task-row-status task-row-status--${task.status}`}>
            {formatLabel(task.status)}
          </span>
          {workspaceName && <span className="task-row-workspace">{workspaceName}</span>}
          <span className="task-row-session-count">
            {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          </span>
          <span className="task-row-source-count">
            {task.sources.length} {task.sources.length === 1 ? "source" : "sources"}
          </span>
        </div>
      </div>

      {menuOpen && (
        <div className="task-row-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => runAction(onEdit)}>
            Edit
          </button>
          <button type="button" role="menuitem" onClick={() => runAction(onSplit)}>
            Split
          </button>
          {task.status !== "cancelled" && task.status !== "archived" && (
            <button type="button" role="menuitem" onClick={() => runAction(onCancel)}>
              Cancel
            </button>
          )}
          {task.status !== "archived" && (
            <button type="button" role="menuitem" onClick={() => runAction(onArchive)}>
              Archive
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function formatLabel(value: string): string {
  return value.replace(/_/g, " ");
}
