import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { createArtifact, getArtifact, listArtifactsForGoal, listArtifactsForRun } from "./usecases.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-artifacts-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function seedTemplate(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?, ?)"
  ).run(
    id,
    "Engineering",
    "desc",
    JSON.stringify([
      {
        id: "intake",
        ordinal: 0,
        name: "Intake",
        purpose: "Collect input",
        requiredInputs: [],
        requiredOutputs: ["goal_brief"],
        gateType: "human-input",
        recommendedCapabilities: [],
        validationExpectations: [],
        exitCriteria: ["captured"],
        recommendedOperatorIds: [],
      },
    ]),
    JSON.stringify([]),
    NOW,
    NOW
  );
}

function seedRun(db: Database.Database, goalId: string, runId: string): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, ?, 1, 'active', NULL, NULL, ?, NULL)"
  ).run(runId, goalId, "orca/engineering", NOW);
}

function seedStep(db: Database.Database, goalId: string, runId: string, stepId: string): void {
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, 'intake', 0, 1, 'active', '[]', '[\"captured\"]', NULL, ?, NULL, 'fp-1')"
  ).run(stepId, goalId, runId, NOW);
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow artifacts usecases", () => {
  it("create -> list by goal -> list by run -> get", () => {
    const db = setup();
    seedGoal(db, "goal-1");
    seedTemplate(db, "orca/engineering");
    seedRun(db, "goal-1", "run-1");
    seedStep(db, "goal-1", "run-1", "step-1");

    const first = createArtifact(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        type: "goal_brief",
        title: "Goal Brief",
        body: "brief body",
        source: "user",
      },
      () => "artifact-1"
    );

    const second = createArtifact(
      db,
      () => "2026-01-01T00:00:01.000Z",
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        type: "research_summary",
        title: "Research",
        body: "research body",
        source: "agent",
      },
      () => "artifact-2"
    );

    expect(first.id).toBe("artifact-1");
    expect(second.id).toBe("artifact-2");

    const byGoal = listArtifactsForGoal(db, "goal-1");
    expect(byGoal.map((artifact) => artifact.id)).toEqual(["artifact-2", "artifact-1"]);

    const byRun = listArtifactsForRun(db, "run-1");
    expect(byRun.map((artifact) => artifact.id)).toEqual(["artifact-1", "artifact-2"]);

    const fetched = getArtifact(db, "artifact-1");
    expect(fetched?.title).toBe("Goal Brief");
    expect(fetched?.goalId).toBe("goal-1");
  });

  it("rejects oversized artifact body", () => {
    const db = setup();
    seedGoal(db, "goal-1");

    const body = "a".repeat(65537);
    expect(() =>
      createArtifact(
        db,
        () => NOW,
        {
          goalId: "goal-1",
          workflowRunId: null,
          stepRunId: null,
          type: "goal_brief",
          title: "too big",
          body,
          source: "user",
        },
        () => "artifact-oversize"
      )
    ).toThrow("artifact_body_too_large");
  });

  it("emits event with byte count and no body content", () => {
    const db = setup();
    seedGoal(db, "goal-1");

    createArtifact(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: null,
        stepRunId: null,
        type: "goal_brief",
        title: "unicode",
        body: "A🤖",
        source: "user",
      },
      () => "artifact-1"
    );

    const event = db
      .prepare("SELECT type, payload FROM events ORDER BY seq DESC LIMIT 1")
      .get() as { type: string; payload: string };

    expect(event.type).toBe("workflow.artifact.created");
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(payload.bodyBytes).toBe(Buffer.byteLength("A🤖", "utf8"));
    expect(payload).not.toHaveProperty("body");
  });
});
