import type Database from "better-sqlite3";
import { WorkflowTemplate, type WorkflowTemplate as WorkflowTemplateT, type WorkflowRun as WorkflowRunT } from "@orca/contracts";
import { getTemplateById } from "../templates/projection.js";

/**
 * Returns the template a run executes against. Prefers the immutable snapshot
 * captured at run start; falls back to the live template for runs created before
 * the snapshot column existed.
 */
export function loadRunTemplate(
  db: Database.Database,
  run: WorkflowRunT
): WorkflowTemplateT | null {
  const row = db
    .prepare("SELECT template_snapshot_json FROM workflow_runs WHERE id = ?")
    .get(run.id) as { template_snapshot_json: string | null } | undefined;
  if (row?.template_snapshot_json) {
    return WorkflowTemplate.parse(JSON.parse(row.template_snapshot_json));
  }
  return getTemplateById(db, run.templateId);
}
