import type Database from "better-sqlite3";
import type { RunDetail, RunSummary } from "@orca/contracts";
import {
  activitySourceKinds, getRun, listActivityEventsByGoal, listRuns,
  listStepRunsByRun, listTransitionsByRun,
} from "./runs-fetch.js";
import { buildInterventions, buildRunDetail, buildRunSummary, buildSpans } from "./runs.js";

/**
 * Step display names for a run. Prefers the run's own `template_snapshot_json` so a
 * run is named by the template AS IT WAS, not as it is now — a renamed or retired
 * step must not retroactively relabel a past run. Falls back to the live template,
 * then to the raw id.
 */
function stepNamesForRun(db: Database.Database, runId: string, templateId: string): Map<string, string> {
  const out = new Map<string, string>();
  const row = db
    .prepare("SELECT template_snapshot_json FROM workflow_runs WHERE id = ?")
    .get(runId) as { template_snapshot_json: string | null } | undefined;
  const live = db
    .prepare("SELECT steps_json FROM workflow_templates WHERE id = ?")
    .get(templateId) as { steps_json: string } | undefined;

  for (const raw of [row?.template_snapshot_json, live?.steps_json]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const steps = Array.isArray(parsed)
        ? parsed
        : (parsed as { steps?: unknown }).steps;
      if (!Array.isArray(steps)) continue;
      for (const s of steps as Array<{ id?: unknown; name?: unknown }>) {
        if (typeof s.id === "string" && typeof s.name === "string" && !out.has(s.id)) {
          out.set(s.id, s.name);
        }
      }
    } catch {
      // A malformed snapshot costs display names, never the projection.
    }
  }
  return out;
}

export function getRunSummaries(
  db: Database.Database,
  opts: { limit?: number; nowIso?: string } = {}
): RunSummary[] {
  const nowMs = Date.parse(opts.nowIso ?? new Date().toISOString());
  return listRuns(db, opts.limit ?? 50).map((run) => {
    const stepRuns = listStepRunsByRun(db, run.runId);
    const transitions = listTransitionsByRun(db, run.runId);
    const interventions = buildInterventions({
      events: listActivityEventsByGoal(db, run.goalId),
      sourceKinds: activitySourceKinds(db, run.goalId),
      run,
      nowMs,
    });
    const spans = buildSpans({
      run, stepRuns, transitions,
      stepNames: stepNamesForRun(db, run.runId, run.templateId),
    });
    return buildRunSummary({ run, stepRuns, transitions, interventions, spans, nowMs });
  });
}

export function getRunDetail(
  db: Database.Database,
  runId: string,
  opts: { nowIso?: string } = {}
): RunDetail | null {
  const run = getRun(db, runId);
  if (run === null) return null;
  return buildRunDetail({
    run,
    stepRuns: listStepRunsByRun(db, runId),
    transitions: listTransitionsByRun(db, runId),
    events: listActivityEventsByGoal(db, run.goalId),
    sourceKinds: activitySourceKinds(db, run.goalId),
    stepNames: stepNamesForRun(db, runId, run.templateId),
    nowMs: Date.parse(opts.nowIso ?? new Date().toISOString()),
  });
}
