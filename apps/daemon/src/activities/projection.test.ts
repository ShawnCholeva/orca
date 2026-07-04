import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventBus } from "../events.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listActivitiesByGoal } from "./projection.js";
import { pauseForMarkDone, type ActivityStoreCtx } from "./store.js";

function ctxFor(db: Database.Database) {
  const bus = new EventBus();
  let n = 0;
  const ctx: ActivityStoreCtx = {
    db,
    bus,
    now: () => "2026-06-27T00:00:00.000Z",
    idFactory: () => `id-${++n}`
  };
  return { ctx };
}

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

describe("enrichConfirmationSummary", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES ('g1', 'Goal', '', 'active', 1, '2026-06-09', '2026-06-09', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO workflow_templates (
         id, name, description, version, is_built_in, is_locked, steps_json,
         guardrails_json, created_at, updated_at
       ) VALUES ('tpl1', 'Test', '', 1, 0, 0, ?, '[]', '2026-06-09', '2026-06-09')`
    ).run(
      JSON.stringify([
        { id: "frame", name: "Frame", outputSchema: [{ key: "problem", type: "string", required: true }] },
      ])
    );
    db.prepare(
      `INSERT INTO workflow_runs (
         id, goal_id, template_id, template_version, status,
         current_step_run_id, blocked_reason, started_at, finished_at
       ) VALUES ('r1', 'g1', 'tpl1', 1, 'paused', 'sr1', NULL, '2026-06-09', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO workflow_step_runs (
         id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
         satisfied_exit_criteria_json, outstanding_exit_criteria_json,
         blocked_reason, started_at, finished_at, fingerprint, pending_completion_json
       ) VALUES ('sr1', 'g1', 'r1', 'frame', 0, 1, 'active', '[]', '[]',
                 NULL, '2026-06-09', NULL, 'fp1', ?)`
    ).run(
      JSON.stringify({
        block: { problem: "Can't rename" },
        scoring: {
          reasoning: "renaming is now correctly scoped to workspaces",
          successScore: 0.9,
          quality: {
            outputCompleteness: 0.9,
            outputCorrectness: 0.9,
            instructionAdherence: 0.9,
            downstreamReadiness: 0.9,
            riskLevel: 0.1,
          },
          reason: "Done.",
          handoffReady: true,
        },
        finishedAt: "2026-06-09T00:00:00.000Z",
        proposal: "p",
      })
    );
    db.prepare(
      `INSERT INTO activities (
         id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
         status, current_text, final_summary, source_kind, work_category, confidence,
         pending_question, created_at, updated_at, completed_at
       ) VALUES ('a-conf', 'g1', 'r1', 'sr1', NULL, 0, 'paused_for_input', 'Awaiting confirmation', NULL,
                 'step_confirmation_pending', NULL, NULL, NULL,
                 '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z', NULL)`
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("attaches confirmationSummary to a step_confirmation_pending activity from the stash", () => {
    const activities = listActivitiesByGoal(db, "g1");
    const confirm = activities.find((a) => a.sourceKind === "step_confirmation_pending");
    expect(confirm?.stepName).toBe("Frame");
    expect(confirm?.confirmationSummary?.lead).toBe("Done.");
    expect(confirm?.confirmationSummary?.fields).toEqual([{ label: "Problem", value: "Can't rename" }]);
    expect(confirm?.confirmationSummary?.scoring?.successScore).toBe(0.9);
  });

  it("carries a null refute through when the stash has none (5.4)", () => {
    const activities = listActivitiesByGoal(db, "g1");
    const confirm = activities.find((a) => a.sourceKind === "step_confirmation_pending");
    expect(confirm?.confirmationSummary?.refute ?? null).toBeNull();
  });

  it("threads a non-upheld refute verdict from the stash into the advisory lead + payload (5.4)", () => {
    db.prepare(
      `INSERT INTO workflow_step_runs (
         id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
         satisfied_exit_criteria_json, outstanding_exit_criteria_json,
         blocked_reason, started_at, finished_at, fingerprint, pending_completion_json
       ) VALUES ('sr2', 'g1', 'r1', 'frame', 1, 2, 'active', '[]', '[]',
                 NULL, '2026-06-09', NULL, 'fp2', ?)`
    ).run(
      JSON.stringify({
        block: { problem: "Can't rename" },
        scoring: null,
        finishedAt: "2026-06-09T00:00:00.000Z",
        proposal: "Proposed",
        refute: { verdict: "refuted", reason: "misses error paths", issueRefs: ["x"] },
      })
    );
    db.prepare(
      `INSERT INTO activities (
         id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
         status, current_text, final_summary, source_kind, work_category, confidence,
         pending_question, created_at, updated_at, completed_at
       ) VALUES ('a-conf2', 'g1', 'r1', 'sr2', NULL, 0, 'paused_for_input', 'Awaiting confirmation', NULL,
                 'step_confirmation_pending', NULL, NULL, NULL,
                 '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z', NULL)`
    ).run();

    const activities = listActivitiesByGoal(db, "g1");
    const confirm = activities.find((a) => a.id === "a-conf2");
    expect(confirm?.confirmationSummary?.lead).toContain("Independent review disputes");
    expect(confirm?.confirmationSummary?.refute).toEqual({
      verdict: "refuted",
      reason: "misses error paths",
      issueRefs: ["x"],
    });
  });
});

describe("step_result confirmed-frame enrichment", () => {
  let db: Database.Database;

  const RESULT_JSON = JSON.stringify({
    stepId: "s1",
    stepStatus: "completed",
    evaluationStatus: "scored",
    successScore: 0.82,
    quality: {
      outputCompleteness: 0.8, outputCorrectness: 0.85,
      instructionAdherence: 0.9, downstreamReadiness: 0.8, riskLevel: 0.2,
    },
    performance: { durationSeconds: 96, retries: 0 },
    outcome: {
      reason: "Output complete.", producedArtifactsCount: 1,
      blockingIssuesCount: 0, warningsCount: 0, handoffReady: true,
    },
    resultSummary: "Replaces folder-browse with a registered-workspace picker.",
  });

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES ('g1', 'Goal', '', 'active', 1, '2026-06-21', '2026-06-21', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO workflow_templates (
         id, name, description, version, is_built_in, is_locked, steps_json,
         guardrails_json, created_at, updated_at
       ) VALUES ('tpl1', 'Test', '', 1, 0, 0, ?, '[]', '2026-06-21', '2026-06-21')`
    ).run(
      JSON.stringify([
        {
          id: "frame",
          name: "Coordinate",
          outputSchema: [
            { key: "problem", type: "string", required: true },
            { key: "constraints", type: "array", itemType: "string", required: true },
          ],
        },
      ])
    );
    db.prepare(
      `INSERT INTO workflow_runs (
         id, goal_id, template_id, template_version, status,
         current_step_run_id, blocked_reason, started_at, finished_at
       ) VALUES ('r1', 'g1', 'tpl1', 1, 'completed', 's1', NULL, '2026-06-21', '2026-06-21')`
    ).run();
    db.prepare(
      `INSERT INTO workflow_step_runs (
         id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
         satisfied_exit_criteria_json, outstanding_exit_criteria_json,
         blocked_reason, started_at, finished_at, fingerprint, step_result_json
       ) VALUES ('s1', 'g1', 'r1', 'frame', 0, 1, 'passed', '[]', '[]',
                 NULL, '2026-06-21', '2026-06-21', 'fp1', ?)`
    ).run(RESULT_JSON);
    db.prepare(
      `INSERT INTO workflow_artifacts (
         id, goal_id, workflow_run_id, step_run_id, type, title, body, source, created_at
       ) VALUES ('art1', 'g1', 'r1', 's1', 'step_output', 'Coordinate', ?, 'orchestrator', '2026-06-21T00:00:00.000Z')`
    ).run(
      JSON.stringify({
        problem: "The Coordinate step makes users browse the filesystem.",
        constraints: ["No inline folder browsing", "A goal may attach multiple workspaces"],
        _completion: { confidence: "medium", assumptions: [], openQuestions: [], whyComplete: "x" },
      })
    );
    // The persisted step_result card.
    db.prepare(
      `INSERT INTO activities (
         id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
         status, current_text, final_summary, source_kind, work_category, confidence,
         pending_question, created_at, updated_at, completed_at
       ) VALUES ('a-res', 'g1', 'r1', 's1', NULL, 1, 'completed', '', NULL,
                 'step_result', NULL, NULL, NULL,
                 '2026-06-21T00:01:00.000Z', '2026-06-21T00:01:00.000Z', '2026-06-21T00:01:00.000Z')`
    ).run();
  });

  afterEach(() => db.close());

  function insertExpiredConfirmation() {
    db.prepare(
      `INSERT INTO activities (
         id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
         status, current_text, final_summary, source_kind, work_category, confidence,
         pending_question, created_at, updated_at, completed_at
       ) VALUES ('a-conf', 'g1', 'r1', 's1', NULL, 0, 'expired', 'Awaiting confirmation', NULL,
                 'step_confirmation_pending', NULL, NULL, NULL,
                 '2026-06-21T00:00:30.000Z', '2026-06-21T00:00:30.000Z', '2026-06-21T00:00:45.000Z')`
    ).run();
  }

  it("rebuilds the frame when a confirmation was shown and resolved", () => {
    insertExpiredConfirmation();
    const a = listActivitiesByGoal(db, "g1").find((x) => x.id === "a-res")!;
    expect(a.confirmationSummary?.lead).toBe(
      "Replaces folder-browse with a registered-workspace picker."
    );
    expect(a.confirmationSummary?.fields).toEqual([
      { label: "Problem", value: "The Coordinate step makes users browse the filesystem." },
      { label: "Constraints", value: ["No inline folder browsing", "A goal may attach multiple workspaces"] },
    ]);
    // Scores stay on stepResult; the rebuilt frame's scoring is null.
    expect(a.confirmationSummary?.scoring).toBeNull();
    expect(a.stepResult?.successScore).toBe(0.82);
  });

  it("leaves an auto-completed step_result (no confirmation shown) compact", () => {
    // No expired step_confirmation_pending sibling.
    const a = listActivitiesByGoal(db, "g1").find((x) => x.id === "a-res")!;
    expect(a.confirmationSummary).toBeUndefined();
    expect(a.stepResult).toBeDefined();
  });

  it("uses the latest step_output block after a revise-then-continue cycle", () => {
    insertExpiredConfirmation();
    // A newer step_output artifact (the re-synthesized block after a Revise) must
    // win — the projection's ORDER BY created_at DESC selects the block tied to the
    // Continue the user actually saw.
    db.prepare(
      `INSERT INTO workflow_artifacts (
         id, goal_id, workflow_run_id, step_run_id, type, title, body, source, created_at
       ) VALUES ('art2', 'g1', 'r1', 's1', 'step_output', 'Coordinate', ?, 'orchestrator', '2026-06-21T00:05:00.000Z')`
    ).run(
      JSON.stringify({
        problem: "Revised problem statement.",
        constraints: ["Revised constraint"],
        _completion: { confidence: "high", assumptions: [], openQuestions: [], whyComplete: "x" },
      })
    );
    const a = listActivitiesByGoal(db, "g1").find((x) => x.id === "a-res")!;
    expect(a.confirmationSummary?.fields).toEqual([
      { label: "Problem", value: "Revised problem statement." },
      { label: "Constraints", value: ["Revised constraint"] },
    ]);
  });

  it("uses confirmed_lead snapshot over resultSummary when present", () => {
    insertExpiredConfirmation();
    // Simulate what the service writes at confirm-pause (scoring.reason text,
    // which differs from the resultSummary stored on the step_result).
    db.prepare("UPDATE workflow_step_runs SET confirmed_lead = ? WHERE id = ?")
      .run("Scored: workspace picker replaces filesystem browse.", "s1");
    const a = listActivitiesByGoal(db, "g1").find((x) => x.id === "a-res")!;
    expect(a.confirmationSummary?.lead).toBe(
      "Scored: workspace picker replaces filesystem browse."
    );
  });
});

describe("mark_done_pending recommendationId projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES ('g1', 'Goal', '', 'active', 1, '2026-06-27', '2026-06-27', NULL)`
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("projects recommendationId for mark_done_pending activities", () => {
    const { ctx } = ctxFor(db);
    pauseForMarkDone(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1", recommendationId: "rec-7" });
    const list = listActivitiesByGoal(db, "g1");
    const mark = list.find((a) => a.sourceKind === "mark_done_pending");
    expect(mark?.recommendationId).toBe("rec-7");
  });
});
