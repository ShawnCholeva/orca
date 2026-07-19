import type Database from "better-sqlite3";
import type { SampleDetail } from "@orca/contracts";

export function getSampleDetail(db: Database.Database, transitionId: string): SampleDetail | null {
  const row = db.prepare(
    `SELECT ht.id, ht.goal_id, ht.workflow_run_id, ht.created_at, ht.evidence_json, ht.telemetry_json, wr.template_version
     FROM harness_transitions ht LEFT JOIN workflow_runs wr ON wr.id = ht.workflow_run_id
     WHERE ht.id = ?`
  ).get(transitionId) as { id: string; goal_id: string; workflow_run_id: string | null; created_at: string; evidence_json: string | null; telemetry_json: string | null; template_version: number | null } | undefined;
  if (!row) return null;
  const parse = (s: string | null): any => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
  const ev = parse(row.evidence_json); const tel = parse(row.telemetry_json);
  const checks: { label: string; detail: string | null; result: string }[] = [];
  for (const c of ev?.grounding?.checks ?? []) {
    if (c?.result && c.result !== "passed" && c.result !== "skipped")
      checks.push({ label: c.field ? `${c.rule} on ${c.field}` : String(c.rule ?? "check"), detail: c.detail ?? null, result: c.result });
  }
  for (const s of ev?.sensorsRun ?? []) {
    if (s?.result && s.result !== "passed" && s.result !== "skipped")
      checks.push({ label: String(s.kind ?? "sensor"), detail: s.summary ?? null, result: s.result });
  }
  return {
    transitionId: row.id, goalId: row.goal_id, workflowRunId: row.workflow_run_id ?? null,
    createdAt: row.created_at, templateVersion: row.template_version ?? null,
    failureCode: tel?.outcome?.failure_code ?? null, status: tel?.outcome?.status ?? "unknown", checks,
  };
}
