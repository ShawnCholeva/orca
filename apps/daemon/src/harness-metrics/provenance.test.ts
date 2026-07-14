import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { buildProvenance } from "./provenance.js";

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

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-provenance-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, NOW, NOW);
}

function seedRunAndStep(
  db: Database.Database,
  goalId: string,
  runId: string,
  stepRunId: string
): void {
  db.prepare(
    `INSERT INTO workflow_templates (id, name, created_at, updated_at) VALUES (?, 'T', ?, ?)`
  ).run("tmpl", NOW, NOW);
  db.prepare(
    `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at)
     VALUES (?, ?, 'tmpl', 1, 'active', ?)`
  ).run(runId, goalId, NOW);
  db.prepare(
    `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, status, fingerprint)
     VALUES (?, ?, ?, 'step-a', 0, 'active', 'fp')`
  ).run(stepRunId, goalId, runId);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildProvenance", () => {
  it("assembles all hops from a transition to its decisions, alternatives, influences, and guardrail evals", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    seedRunAndStep(db, "g", "run-1", "step-1");

    db.prepare(
      `INSERT INTO workflow_decisions
        (id, goal_id, workflow_run_id, step_run_id, decision_type, selected_action, reason,
         influenced_by_json, alternatives_considered_json, confidence, operator_selection_json, input_fingerprint, created_at)
       VALUES (?, 'g', 'run-1', 'step-1', 'select_operator', 'do-x', 'because',
         ?, ?, NULL, NULL, 'fp', ?)`
    ).run(
      "dec-1",
      JSON.stringify([
        { id: "feedback-1", kind: "memory", label: "prior failure", effect: "preferred" },
      ]),
      JSON.stringify(["do-y", "do-z"]),
      NOW
    );

    db.prepare(
      `INSERT INTO workflow_guardrail_evaluations
        (id, goal_id, workflow_run_id, step_run_id, guardrail_id, guardrail_kind, decision_id, result, message, created_at)
       VALUES (?, 'g', 'run-1', 'step-1', 'gr-1', 'validation_rule', 'dec-1', 'allow', NULL, ?)`
    ).run("ge-1", NOW);

    // A transition tied to the same run + step.
    db.prepare(
      `INSERT INTO harness_transitions
        (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, created_at)
       VALUES (?, 'g', 'run-1', 'step-1', 'step_complete', ?)`
    ).run("trans-1", NOW);

    const result = buildProvenance(db, "trans-1");
    expect(result).not.toBeNull();
    expect(result!.transition.id).toBe("trans-1");

    expect(result!.decisions).toHaveLength(1);
    expect(result!.decisions[0]!.decisionId).toBe("dec-1");

    expect(result!.alternatives).toEqual(["do-y", "do-z"]);
    expect(result!.influencedBy.map((i) => i.id)).toEqual(["feedback-1"]);

    expect(result!.guardrailEvals).toHaveLength(1);
    expect(result!.guardrailEvals[0]!.id).toBe("ge-1");
    expect(result!.guardrailEvals[0]!.result).toBe("allow");
  });

  it("returns empty hops (not an error) for a transition with no run/step", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    db.prepare(
      `INSERT INTO harness_transitions
        (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, created_at)
       VALUES (?, 'g', NULL, NULL, 'tool_gate', ?)`
    ).run("trans-2", NOW);

    const result = buildProvenance(db, "trans-2");
    expect(result).not.toBeNull();
    expect(result!.decisions).toEqual([]);
    expect(result!.alternatives).toEqual([]);
    expect(result!.influencedBy).toEqual([]);
    expect(result!.guardrailEvals).toEqual([]);
  });

  it("returns null for an unknown transition", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    expect(buildProvenance(db, "nope")).toBeNull();
  });
});
