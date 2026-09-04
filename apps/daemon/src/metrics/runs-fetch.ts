import type Database from "better-sqlite3";
import { HARNESS_FACETS, HarnessTransition } from "@orca/contracts";

// Row fetchers for the run-trace projection. Storage-agnostic by construction:
// every JSON column is selected as opaque TEXT and parsed in TypeScript, never
// with json_extract. (harness-metrics/attribution.ts is the one pre-existing
// SQLite-bound module in this area; don't add to it.)

export type RunRow = {
  runId: string;
  goalId: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  blockedReason: string | null;
};

export type RunStepRunRow = {
  stepRunId: string;
  goalId: string;
  stepTemplateId: string;
  ordinal: number;
  attempt: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  blockedReason: string | null;
  stallRescues: number;
};

export type RunTransition = {
  transition: HarnessTransition;
  stepTemplateId: string | null;
};

/** Any run-attributable event: its payload names a workflowRunId. */
export type RunEvent = { createdAt: string; type: string; workflowRunId: string };

/** One `activity.changed` row, payload parsed in TS. */
export type ActivityEvent = {
  createdAt: string;
  activityId: string;
  workflowRunId: string | null;
  stepRunId: string | null;
  status: string;
  /** From the EVENT payload (`18ea6ef`). Null on events emitted before that,
   *  which is the only case the mutable-row fallback is for. */
  sourceKind: string | null;
};

const FACET_COLS = HARNESS_FACETS.map((f) => `ht.${f.column}`).join(", ");

const RUN_COLS = `wr.id, wr.goal_id, wr.template_id, wr.template_version, wr.status,
                  wr.started_at, wr.finished_at, wr.blocked_reason, t.name AS template_name`;

interface RawRunRow {
  id: string; goal_id: string; template_id: string; template_version: number;
  status: string; started_at: string; finished_at: string | null;
  blocked_reason: string | null; template_name: string | null;
}

function toRunRow(r: RawRunRow): RunRow {
  return {
    runId: r.id, goalId: r.goal_id, templateId: r.template_id,
    templateName: r.template_name ?? r.template_id,
    templateVersion: r.template_version, status: r.status,
    startedAt: r.started_at, finishedAt: r.finished_at, blockedReason: r.blocked_reason,
  };
}

export function listRuns(db: Database.Database, limit = 50): RunRow[] {
  return (
    db.prepare(
      `SELECT ${RUN_COLS} FROM workflow_runs wr
       LEFT JOIN workflow_templates t ON t.id = wr.template_id
       ORDER BY wr.started_at DESC, wr.id ASC LIMIT ?`
    ).all(limit) as RawRunRow[]
  ).map(toRunRow);
}

export function getRun(db: Database.Database, runId: string): RunRow | null {
  const row = db.prepare(
    `SELECT ${RUN_COLS} FROM workflow_runs wr
     LEFT JOIN workflow_templates t ON t.id = wr.template_id
     WHERE wr.id = ?`
  ).get(runId) as RawRunRow | undefined;
  return row === undefined ? null : toRunRow(row);
}

export function listStepRunsByRun(db: Database.Database, runId: string): RunStepRunRow[] {
  const rows = db.prepare(
    `SELECT id, goal_id, step_template_id, ordinal, attempt, status,
            started_at, finished_at, blocked_reason, stall_rescues
     FROM workflow_step_runs WHERE workflow_run_id = ?
     ORDER BY ordinal ASC, attempt ASC, id ASC`
  ).all(runId) as Array<{
    id: string; goal_id: string; step_template_id: string; ordinal: number;
    attempt: number; status: string; started_at: string | null;
    finished_at: string | null; blocked_reason: string | null; stall_rescues: number;
  }>;
  return rows.map((r) => ({
    stepRunId: r.id, goalId: r.goal_id, stepTemplateId: r.step_template_id,
    ordinal: r.ordinal, attempt: r.attempt, status: r.status,
    startedAt: r.started_at, finishedAt: r.finished_at,
    blockedReason: r.blocked_reason, stallRescues: r.stall_rescues,
  }));
}

export function listTransitionsByRun(db: Database.Database, runId: string): RunTransition[] {
  const rows = db.prepare(
    `SELECT ht.id, ht.goal_id, ht.workflow_run_id, ht.workflow_step_run_id, ht.boundary,
            ht.created_at, ${FACET_COLS}, wsr.step_template_id AS step_template_id
     FROM harness_transitions ht
     LEFT JOIN workflow_step_runs wsr ON wsr.id = ht.workflow_step_run_id
     WHERE ht.workflow_run_id = ?
     ORDER BY ht.created_at ASC, ht.id ASC`
  ).all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const facets: Record<string, unknown> = {};
    for (const f of HARNESS_FACETS) {
      const raw = row[f.column] as string | null;
      facets[f.key] = raw == null ? null : JSON.parse(raw);
    }
    return {
      transition: HarnessTransition.parse({
        id: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id,
        workflowStepRunId: row.workflow_step_run_id, boundary: row.boundary,
        ...facets, createdAt: row.created_at,
      }),
      stepTemplateId: (row.step_template_id as string | null) ?? null,
    };
  });
}

/**
 * `activity.changed` rows for a goal, oldest first. The payload is opaque TEXT and
 * is parsed here; a row whose payload doesn't parse or lacks an activityId is
 * skipped rather than throwing — the intervention ledger degrades to fewer parks
 * rather than failing the whole projection.
 */
export function listActivityEventsByGoal(db: Database.Database, goalId: string): ActivityEvent[] {
  const rows = db.prepare(
    `SELECT payload, created_at FROM events
     WHERE goal_id = ? AND type = 'activity.changed'
     ORDER BY seq ASC`
  ).all(goalId) as Array<{ payload: string; created_at: string }>;
  const out: ActivityEvent[] = [];
  for (const r of rows) {
    let p: {
      activityId?: unknown; workflowRunId?: unknown; stepRunId?: unknown;
      status?: unknown; sourceKind?: unknown;
    };
    try { p = JSON.parse(r.payload); } catch { continue; }
    if (typeof p.activityId !== "string" || typeof p.status !== "string") continue;
    out.push({
      createdAt: r.created_at,
      activityId: p.activityId,
      workflowRunId: typeof p.workflowRunId === "string" ? p.workflowRunId : null,
      stepRunId: typeof p.stepRunId === "string" ? p.stepRunId : null,
      status: p.status,
      sourceKind: typeof p.sourceKind === "string" ? p.sourceKind : null,
    });
  }
  return out;
}

/**
 * Run-attributable events for a goal, oldest first. `events` is GOAL-scoped and
 * only some payloads carry a run id — `harness.transition.recorded` notably does
 * not — so "any event" would silently mean "any event of the goal", and a sibling
 * run's event would register as this run's signal. Filtered to payloads that name
 * the run, and the id is parsed in TS rather than matched in SQL.
 */
export function listRunEventsByGoal(db: Database.Database, goalId: string): RunEvent[] {
  const rows = db.prepare(
    "SELECT type, payload, created_at FROM events WHERE goal_id = ? ORDER BY seq ASC"
  ).all(goalId) as Array<{ type: string; payload: string; created_at: string }>;
  const out: RunEvent[] = [];
  for (const r of rows) {
    let p: { workflowRunId?: unknown };
    try { p = JSON.parse(r.payload); } catch { continue; }
    if (typeof p.workflowRunId !== "string") continue;
    out.push({ createdAt: r.created_at, type: r.type, workflowRunId: p.workflowRunId });
  }
  return out;
}

/**
 * activityId -> source_kind, read from the (mutable) activities row. Lossy by
 * construction: the row holds the LATEST source_kind, so a park whose activity was
 * reused reports the wrong cause. The fix is `sourceKind` on the event payload
 * (orca-6b owns that emission); until it lands, an unrecognised value surfaces as
 * "unknown" rather than being guessed at.
 */
export function activitySourceKinds(db: Database.Database, goalId: string): Map<string, string> {
  const rows = db.prepare(
    "SELECT id, source_kind FROM activities WHERE goal_id = ?"
  ).all(goalId) as Array<{ id: string; source_kind: string | null }>;
  return new Map(rows.filter((r) => r.source_kind != null).map((r) => [r.id, r.source_kind!]));
}
