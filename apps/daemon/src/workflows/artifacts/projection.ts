import type Database from "better-sqlite3";
import {
  WorkflowArtifact,
  type WorkflowArtifact as WorkflowArtifactT,
  type WorkflowArtifactType,
} from "@orca/contracts";

interface WorkflowArtifactRow {
  id: string;
  goal_id: string;
  workflow_run_id: string | null;
  step_run_id: string | null;
  type: WorkflowArtifactType;
  title: string;
  body: string;
  source: WorkflowArtifactT["source"];
  linked_session_id: string | null;
  linked_task_id: string | null;
  linked_context_package_id: string | null;
  created_at: string;
}

function toArtifact(row: WorkflowArtifactRow): WorkflowArtifactT {
  return WorkflowArtifact.parse({
    id: row.id,
    goalId: row.goal_id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    type: row.type,
    title: row.title,
    body: row.body,
    source: row.source,
    linkedSessionId: row.linked_session_id,
    linkedTaskId: row.linked_task_id,
    linkedContextPackageId: row.linked_context_package_id,
    createdAt: row.created_at,
  });
}

export function getArtifactById(
  db: Database.Database,
  id: string
): WorkflowArtifactT | null {
  const row = db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at FROM workflow_artifacts WHERE id = ?"
    )
    .get(id) as WorkflowArtifactRow | undefined;
  return row ? toArtifact(row) : null;
}

export function listArtifactsForRun(
  db: Database.Database,
  runId: string
): WorkflowArtifactT[] {
  const rows = db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at FROM workflow_artifacts WHERE workflow_run_id = ? ORDER BY created_at ASC"
    )
    .all(runId) as WorkflowArtifactRow[];
  return rows.map(toArtifact);
}

export function listArtifactsForGoal(
  db: Database.Database,
  goalId: string,
  type?: WorkflowArtifactType
): WorkflowArtifactT[] {
  if (type) {
    const rows = db
      .prepare(
        "SELECT id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at FROM workflow_artifacts WHERE goal_id = ? AND type = ? ORDER BY created_at DESC"
      )
      .all(goalId, type) as WorkflowArtifactRow[];
    return rows.map(toArtifact);
  }

  const rows = db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at FROM workflow_artifacts WHERE goal_id = ? ORDER BY created_at DESC"
    )
    .all(goalId) as WorkflowArtifactRow[];
  return rows.map(toArtifact);
}
