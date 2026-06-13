import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listActivitiesByGoal } from "./projection.js";

const STEP_RESULT_JSON = JSON.stringify({
  stepId: "s1",
  stepStatus: "completed",
  evaluationStatus: "scored",
  successScore: 0.82,
  quality: {
    outputCompleteness: 0.8,
    outputCorrectness: 0.85,
    instructionAdherence: 0.9,
    downstreamReadiness: 0.8,
    riskLevel: 0.2,
  },
  performance: { durationSeconds: 96, retries: 0 },
  outcome: {
    reason: "Output complete.",
    producedArtifactsCount: 1,
    blockingIssuesCount: 0,
    warningsCount: 0,
    handoffReady: true,
  },
});

function seedData(db: Database.Database) {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES ('g1', 'Goal', '', 'active', 1, '2026-06-09', '2026-06-09', NULL)`
  ).run();
  db.prepare(
    `INSERT INTO workflow_templates (
       id, name, description, version, is_built_in, is_locked, steps_json,
       guardrails_json, created_at, updated_at
     ) VALUES ('tpl1', 'Test', '', 1, 0, 0, ?, '[]', '2026-06-09', '2026-06-09')`
  ).run(JSON.stringify([{ id: "step-tpl-1", name: "Investigate" }]));
  db.prepare(
    `INSERT INTO workflow_runs (
       id, goal_id, template_id, template_version, status,
       current_step_run_id, blocked_reason, started_at, finished_at
     ) VALUES ('r1', 'g1', 'tpl1', 1, 'completed', 's1', NULL, '2026-06-09', '2026-06-09')`
  ).run();
  db.prepare(
    `INSERT INTO workflow_step_runs (
       id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
       satisfied_exit_criteria_json, outstanding_exit_criteria_json,
       blocked_reason, started_at, finished_at, fingerprint, step_result_json
     ) VALUES ('s1', 'g1', 'r1', 'step-tpl-1', 0, 1, 'passed', '[]', '[]',
               NULL, '2026-06-09', '2026-06-09', 'fp1', ?)`
  ).run(STEP_RESULT_JSON);
  db.prepare(
    `INSERT INTO activities (
       id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
       status, current_text, final_summary, source_kind, work_category, confidence,
       pending_question, created_at, updated_at, completed_at
     ) VALUES ('a1', 'g1', 'r1', 's1', NULL, 0, 'completed', '', NULL,
               'step_result', NULL, NULL, NULL,
               '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z')`
  ).run();
}

describe("listActivitiesByGoal step_result enrichment", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    seedData(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns a step_result activity enriched with stepName and stepResult", () => {
    const activities = listActivitiesByGoal(db, "g1");
    expect(activities).toHaveLength(1);
    const a = activities[0]!;
    expect(a.sourceKind).toBe("step_result");
    expect(a.stepName).toBe("Investigate");
    expect(a.stepResult).toBeDefined();
    expect(a.stepResult?.evaluationStatus).toBe("scored");
    expect(a.stepResult?.successScore).toBe(0.82);
  });

  it("enriches a provider_recovery_pending activity with providerRecovery", () => {
    const checkpoint = {
      id: "recovery-1",
      mode: "choose",
      failureCode: "session_limit",
      message: "Claude Code session limit reached",
      currentSessionId: "sess-1",
      currentAdapterId: "claude-code",
      currentProviderName: "Claude Code",
      resetTimeText: "4:20am (America/New_York)",
      resetAt: "2026-06-12T08:20:00.000Z",
      timezone: "America/New_York",
      detectedAt: "2026-06-12T05:00:00.000Z",
      retryOutputSeq: null,
      retryKind: "preserved_session",
      replacementSessionId: null,
      replacementOutputSeq: null,
      pendingGuidance: [],
      lastError: null,
      choices: [],
    };
    db.prepare(
      "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = 's1'"
    ).run(JSON.stringify(checkpoint));
    db.prepare(
      `INSERT INTO activities (
         id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
         status, current_text, final_summary, source_kind, work_category, confidence,
         pending_question, created_at, updated_at, completed_at
       ) VALUES ('a-rec', 'g1', 'r1', 's1', 'sess-1', 2, 'paused_for_input', 'waiting', NULL,
                 'provider_recovery_pending', NULL, NULL, NULL,
                 '2026-06-09T00:02:00.000Z', '2026-06-09T00:02:00.000Z', NULL)`
    ).run();

    const activities = listActivitiesByGoal(db, "g1");
    const rec = activities.find((a) => a.id === "a-rec")!;
    expect(rec.providerRecovery).toBeDefined();
    expect(rec.providerRecovery?.mode).toBe("choose");
    expect(rec.providerRecovery?.resetTimeText).toBe("4:20am (America/New_York)");
  });

  it("does not enrich non-step_result activities", () => {
    db.prepare(
      `INSERT INTO activities (
         id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
         status, current_text, final_summary, source_kind, work_category, confidence,
         pending_question, created_at, updated_at, completed_at
       ) VALUES ('a2', 'g1', 'r1', 's1', NULL, 1, 'completed', '', 'Done',
                 'turn_completed', NULL, NULL, NULL,
                 '2026-06-09T00:01:00.000Z', '2026-06-09T00:01:00.000Z', '2026-06-09T00:01:00.000Z')`
    ).run();
    const activities = listActivitiesByGoal(db, "g1");
    const other = activities.find((a) => a.id === "a2")!;
    expect(other.stepName).toBeUndefined();
    expect(other.stepResult).toBeUndefined();
  });
});
