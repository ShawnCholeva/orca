import type Database from "better-sqlite3";
import { WorkflowRunComposition } from "@orca/contracts";

interface Row {
  id: string; goal_id: string; parent_run_id: string; child_run_id: string; delegate_node_id: string;
  spawn_seq: number; reads_json: string; writes_json: string; parent_workspace_snapshot_json: string | null;
  depth: number; status: string; cost_rollup_usd: number | null; created_at: string; finished_at: string | null;
}

function rowTo(r: Row): WorkflowRunComposition {
  return WorkflowRunComposition.parse({
    id: r.id, goalId: r.goal_id, parentRunId: r.parent_run_id, childRunId: r.child_run_id,
    delegateNodeId: r.delegate_node_id, spawnSeq: r.spawn_seq, reads: JSON.parse(r.reads_json),
    writes: JSON.parse(r.writes_json), depth: r.depth, status: r.status,
    costRollupUsd: r.cost_rollup_usd, createdAt: r.created_at, finishedAt: r.finished_at,
  });
}

export function insertComposition(db: Database.Database, c: WorkflowRunComposition, workspaceSnapshotJson: string | null = null): void {
  db.prepare(
    `INSERT INTO workflow_run_compositions
      (id, goal_id, parent_run_id, child_run_id, delegate_node_id, spawn_seq, reads_json, writes_json,
       parent_workspace_snapshot_json, depth, status, cost_rollup_usd, created_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(c.id, c.goalId, c.parentRunId, c.childRunId, c.delegateNodeId, c.spawnSeq,
    JSON.stringify(c.reads), JSON.stringify(c.writes), workspaceSnapshotJson, c.depth, c.status,
    c.costRollupUsd, c.createdAt, c.finishedAt);
}

export function getCompositionById(db: Database.Database, id: string): WorkflowRunComposition | null {
  const r = db.prepare(`SELECT * FROM workflow_run_compositions WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowTo(r) : null;
}
export function getCompositionByChildRun(db: Database.Database, childRunId: string): WorkflowRunComposition | null {
  const r = db.prepare(`SELECT * FROM workflow_run_compositions WHERE child_run_id = ?`).get(childRunId) as Row | undefined;
  return r ? rowTo(r) : null;
}
export function listChildCompositions(db: Database.Database, parentRunId: string): WorkflowRunComposition[] {
  return (db.prepare(`SELECT * FROM workflow_run_compositions WHERE parent_run_id = ? ORDER BY created_at ASC`).all(parentRunId) as Row[]).map(rowTo);
}
export function nextSpawnSeq(db: Database.Database, parentRunId: string, delegateNodeId: string): number {
  const r = db.prepare(`SELECT COALESCE(MAX(spawn_seq), -1) AS m FROM workflow_run_compositions WHERE parent_run_id = ? AND delegate_node_id = ?`)
    .get(parentRunId, delegateNodeId) as { m: number };
  return r.m + 1;
}
export function readWorkspaceSnapshot(db: Database.Database, id: string): string | null {
  const r = db.prepare(`SELECT parent_workspace_snapshot_json FROM workflow_run_compositions WHERE id = ?`).get(id) as { parent_workspace_snapshot_json: string | null } | undefined;
  return r?.parent_workspace_snapshot_json ?? null;
}
export function updateCompositionStatus(
  db: Database.Database, id: string,
  patch: { status: WorkflowRunComposition["status"]; costRollupUsd?: number | null; finishedAt?: string | null },
): void {
  const cur = db.prepare(`SELECT status, cost_rollup_usd, finished_at FROM workflow_run_compositions WHERE id = ?`).get(id) as
    { status: string; cost_rollup_usd: number | null; finished_at: string | null } | undefined;
  if (!cur) return;
  db.prepare(`UPDATE workflow_run_compositions SET status = ?, cost_rollup_usd = ?, finished_at = ? WHERE id = ?`)
    .run(patch.status,
      patch.costRollupUsd !== undefined ? patch.costRollupUsd : cur.cost_rollup_usd,
      patch.finishedAt !== undefined ? patch.finishedAt : cur.finished_at, id);
}

// root + all transitive child runs (for cost roll-up + cancel cascade).
export function descendantRunIds(db: Database.Database, rootRunId: string): string[] {
  const out = new Set<string>([rootRunId]);
  const stack = [rootRunId];
  while (stack.length) {
    const parent = stack.pop()!;
    const kids = db.prepare(`SELECT child_run_id FROM workflow_run_compositions WHERE parent_run_id = ?`).all(parent) as { child_run_id: string }[];
    for (const k of kids) if (!out.has(k.child_run_id)) { out.add(k.child_run_id); stack.push(k.child_run_id); }
  }
  return [...out];
}
