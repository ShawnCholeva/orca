import type Database from "better-sqlite3";
import type { WorkflowTemplate } from "@orca/contracts";

export const MAX_DELEGATION_DEPTH = 5;

export function delegationTargets(template: Pick<WorkflowTemplate, "graph">): { childTemplateId: string; version: number }[] {
  const nodes = template.graph?.nodes ?? [];
  const out: { childTemplateId: string; version: number }[] = [];
  for (const n of nodes) {
    if (n.type === "delegate" && n.childTemplateId && n.childTemplateVersion !== undefined) {
      out.push({ childTemplateId: n.childTemplateId, version: n.childTemplateVersion });
    }
  }
  return out;
}

// Depth of parentRunId within the delegation stack (0 = a root run with no parent composition).
export function delegationDepth(db: Database.Database, parentRunId: string): number {
  let depth = 0;
  let runId: string | null = parentRunId;
  const seen = new Set<string>();
  while (runId && !seen.has(runId)) {
    seen.add(runId);
    const row = db.prepare(`SELECT parent_composition_id FROM workflow_runs WHERE id = ?`).get(runId) as { parent_composition_id: string | null } | undefined;
    const pcid = row?.parent_composition_id ?? null;
    if (!pcid) break;
    const comp = db.prepare(`SELECT parent_run_id FROM workflow_run_compositions WHERE id = ?`).get(pcid) as { parent_run_id: string } | undefined;
    if (!comp) break;
    depth += 1;
    runId = comp.parent_run_id;
  }
  return depth;
}
