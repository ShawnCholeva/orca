import type { SessionSummary, Task } from "@orca/contracts";

type Props = {
  tasks: Task[];
  sessions: SessionSummary[];
};

export function TaskDagPreview({ tasks, sessions }: Props) {
  const sessionCountByTaskId = new Map<string, number>();
  for (const session of sessions) {
    if (!session.taskId) continue;
    sessionCountByTaskId.set(
      session.taskId,
      (sessionCountByTaskId.get(session.taskId) ?? 0) + 1,
    );
  }

  const orderedTasks = [...tasks].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );

  return (
    <section className="workflow-panel-card" aria-label="Workflow tasks">
      <div className="workflow-panel-card-header">
        <h4 className="workflow-panel-card-title">Linked Tasks</h4>
        <span className="workflow-panel-card-meta">{orderedTasks.length} linked</span>
      </div>

      {orderedTasks.length === 0 ? (
        <p className="workflow-panel-empty">No tasks linked to this workflow run.</p>
      ) : (
        <ul className="workflow-task-list">
          {orderedTasks.map((task) => (
            <li key={task.id} className={`workflow-task-item workflow-task-item--${task.status}`}>
              <div className="workflow-task-title-row">
                <span className="workflow-task-title">{task.title}</span>
                <span className="workflow-task-status">{task.status}</span>
              </div>
              <p className="workflow-task-meta">
                {task.role} · {task.validationSteps.length} validation
                {task.validationSteps.length === 1 ? " step" : " steps"} ·{" "}
                {sessionCountByTaskId.get(task.id) ?? 0} linked session
                {(sessionCountByTaskId.get(task.id) ?? 0) === 1 ? "" : "s"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
