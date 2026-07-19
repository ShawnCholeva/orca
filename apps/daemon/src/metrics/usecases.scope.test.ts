import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { getTemplateMetricsDetail } from "./usecases.js";

const NOW = "2026-07-16T12:00:00.000Z";

function stepCompleteTelemetry() {
  return JSON.stringify({
    sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
    oracleAdequacy: { sufficient: true, gaps: [] },
  });
}
function telemetryJson() {
  return JSON.stringify({
    cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null,
    prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
    outcome: { status: "succeeded", failure_code: null },
  });
}

describe("getTemplateMetricsDetail — scope (current/latest/all)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());

    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(NOW, NOW);

    // Template's CURRENT shape only has step "a". Step "z" is a fossil (retired step,
    // not present in steps_json) that ran on v1 only.
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('tpl','T','',2,0,0,'[{"id":"a","name":"A"}]','[]',NULL,?,?)`
    ).run(NOW, NOW);

    // Run r1 on v1: step "a" (1 run) + fossil step "z" (1 run).
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES ('r1','g1','tpl',1,'completed',?,1)"
    ).run(NOW);
    // Run r2 on v2 (latest): step "a" (1 run).
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES ('r2','g1','tpl',2,'completed',?,1)"
    ).run(NOW);

    db.prepare(
      `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
       VALUES ('sr-a-v1','g1','r1','a',0,1,'passed','[]','[]',NULL,?,?,'fp1')`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
       VALUES ('sr-z-v1','g1','r1','z',1,1,'passed','[]','[]',NULL,?,?,'fp2')`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
       VALUES ('sr-a-v2','g1','r2','a',0,1,'passed','[]','[]',NULL,?,?,'fp3')`
    ).run(NOW, NOW);

    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES ('ht-a-v1','g1','r1','sr-a-v1','step_complete',NULL,?,NULL,?,?)`
    ).run(stepCompleteTelemetry(), telemetryJson(), NOW);
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES ('ht-z-v1','g1','r1','sr-z-v1','step_complete',NULL,?,NULL,?,?)`
    ).run(stepCompleteTelemetry(), telemetryJson(), NOW);
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES ('ht-a-v2','g1','r2','sr-a-v2','step_complete',NULL,?,NULL,?,?)`
    ).run(stepCompleteTelemetry(), telemetryJson(), NOW);
  });

  const AFTER = "2026-07-17T00:00:00.000Z";

  it("scope=current (default) excludes the fossil step z", () => {
    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    expect(detail!.summary.scope).toBe("current");
    expect(detail!.steps.map((s) => s.stepTemplateId).sort()).toEqual(["a"]);
  });

  it("scope=all includes the fossil step z", () => {
    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER, "all");
    expect(detail).not.toBeNull();
    expect(detail!.summary.scope).toBe("all");
    expect(detail!.steps.map((s) => s.stepTemplateId).sort()).toEqual(["a", "z"]);
  });

  it("scope=latest drops non-latest-version runs — step a's run count reflects only v2", () => {
    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER, "latest");
    expect(detail).not.toBeNull();
    expect(detail!.summary.scope).toBe("latest");
    expect(detail!.steps.map((s) => s.stepTemplateId).sort()).toEqual(["a"]);
    const stepA = detail!.steps.find((s) => s.stepTemplateId === "a");
    expect(stepA!.runs).toBe(1); // only the v2 run contributes, not the v1 run
  });
});
