import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { EventBus } from "../../events.js";
import type { Config } from "../../config.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetPreparedStatements as resetRunProjection } from "../runs/projection.js";
import { resetPreparedStatements as resetTemplateProjection } from "../templates/projection.js";
import { resetPreparedStatements as resetHarnessProjection } from "../../harness-transitions/usecases.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { emitStepComplete } from "../../harness-transitions/emit.js";
import { joinChildRun, type JoinDeps } from "./join.js";

const NOW = "2026-07-01T00:00:00.000Z";
const dirs: string[] = [];

function cfg(d: string): Config {
  return {
    dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1 << 20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1 << 20,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "x.js"], getAuthToken: () => "t",
  };
}

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-join-"));
  dirs.push(dir);
  const db = openDatabase(cfg(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

let db: Database.Database;
let n: number;

function makeDeps(): JoinDeps {
  return {
    db,
    bus: new EventBus(),
    now: () => NOW,
    idFactory: () => `id-${++n}`,
  };
}

// Parent template graph: delegate node "dn1" → step node "ns1"
const PARENT_GRAPH_JSON = JSON.stringify({
  nodes: [
    { id: "dn1", type: "delegate", name: "Delegate", childTemplateId: "child-tpl", childTemplateVersion: 1 },
    { id: "ns1", type: "step", name: "Next Step", stepId: "s-next", terminal: true },
  ],
  edges: [{ from: "dn1", to: "ns1" }],
  positions: { dn1: { x: 110, y: 20 }, ns1: { x: 110, y: 112 } },
});

// Parent template steps (only the step after the delegate)
const PARENT_STEPS_JSON = JSON.stringify([{
  id: "s-next", ordinal: 0, name: "Next Step", instructions: "Do it",
  outputSchema: [{ key: "result", type: "string", required: true }],
  agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
}]);

// Child template: single step, no graph
const CHILD_STEPS_JSON = JSON.stringify([{
  id: "s-child-1", ordinal: 0, name: "Child Step", instructions: "Review it",
  outputSchema: [{ key: "findings", type: "string", required: true }],
  agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
}]);

beforeEach(() => {
  db = openTestDb();
  n = 0;
});

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetRunProjection();
  resetTemplateProjection();
  resetHarnessProjection();
  resetWorkflowStepProjectionPreparedStatements();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Seed the common fixtures used by both tests. Returns the composition id.
 */
function seedFixtures(deps: JoinDeps): string {
  // Templates
  db.prepare(
    `INSERT INTO workflow_templates
       (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
  ).run("parent-tpl", "Parent Tpl", "desc", 1, PARENT_STEPS_JSON, "[]", PARENT_GRAPH_JSON, NOW, NOW);

  db.prepare(
    `INSERT INTO workflow_templates
       (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`
  ).run("child-tpl", "Child Tpl", "desc", 1, CHILD_STEPS_JSON, "[]", NOW, NOW);

  // Goal
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run("g1", NOW, NOW);

  // Parent run: delegating, cursor parked at dn1
  db.prepare(
    `INSERT INTO workflow_runs
       (id, goal_id, template_id, template_version, status, current_node_id, started_at)
     VALUES (?, ?, ?, 1, 'delegating', 'dn1', ?)`
  ).run("r-parent", "g1", "parent-tpl", NOW);

  // Child run (no parent_composition_id yet — set after composition row)
  db.prepare(
    `INSERT INTO workflow_runs
       (id, goal_id, template_id, template_version, status, started_at)
     VALUES (?, ?, ?, 1, 'active', ?)`
  ).run("r-child", "g1", "child-tpl", NOW);

  // Composition row
  const compositionId = "comp-1";
  db.prepare(
    `INSERT INTO workflow_run_compositions
       (id, goal_id, parent_run_id, child_run_id, delegate_node_id, spawn_seq, reads_json, writes_json, depth, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    compositionId, "g1", "r-parent", "r-child", "dn1", 0,
    JSON.stringify({}),
    JSON.stringify({ review_findings: "findings" }),
    1, "active", NOW
  );

  // Link child run to composition
  db.prepare(`UPDATE workflow_runs SET parent_composition_id = ? WHERE id = ?`).run(compositionId, "r-child");

  // Goal's active run = child (child is active leaf during delegation)
  db.prepare(`UPDATE goals SET active_workflow_run_id = ? WHERE id = ?`).run("r-child", "g1");

  // Child step run (terminal, passed)
  db.prepare(
    `INSERT INTO workflow_step_runs
       (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt,
        status, satisfied_exit_criteria_json, outstanding_exit_criteria_json,
        fingerprint, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, 'passed', '[]', '[]', 'fp1', ?, ?)`
  ).run("sr-child-1", "g1", "r-child", "s-child-1", 0, 1, NOW, NOW);

  // Link child run cursor to the step run
  db.prepare(`UPDATE workflow_runs SET current_step_run_id = ? WHERE id = ?`).run("sr-child-1", "r-child");

  // Child step_output artifact
  db.prepare(
    `INSERT INTO workflow_artifacts
       (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, created_at)
     VALUES (?, ?, ?, ?, 'step_output', 'child output', ?, 'orchestrator', ?)`
  ).run("art-child-1", "g1", "r-child", "sr-child-1", JSON.stringify({ findings: ["x"] }), NOW);

  return compositionId;
}

describe("joinChildRun", () => {
  it("passed verdict → writes artifact, child completed, parent active, delegate_join emitted", () => {
    const deps = makeDeps();
    seedFixtures(deps);

    // Emit step_complete with passed verdict for child run
    emitStepComplete(
      { db, bus: deps.bus, now: deps.now, idFactory: deps.idFactory },
      {
        goalId: "g1",
        workflowRunId: "r-child",
        workflowStepRunId: "sr-child-1",
        evidence: {
          sensorsRun: [],
          verdict: "passed",
          untestedRegions: [],
          residualRisk: [],
          oracleAdequacy: { sufficient: true, gaps: [] },
        },
        telemetry: null,
        stateDeps: null,
      }
    );

    const result = joinChildRun(deps, "r-child");

    // Outcome
    expect(result.outcome).toBe("joined");
    expect(result.parentRunId).toBe("r-parent");

    // Writes artifact in parent namespace
    const writesArtifact = db.prepare(
      `SELECT * FROM workflow_artifacts
       WHERE workflow_run_id = 'r-parent' AND type = 'step_output' AND source = 'orchestrator'`
    ).get() as Record<string, unknown> | undefined;
    expect(writesArtifact).toBeTruthy();
    expect(writesArtifact!.step_run_id).not.toBeNull();
    expect(JSON.parse(writesArtifact!.body as string)).toEqual({ review_findings: ["x"] });

    // Child run: completed
    const childRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-child'`).get() as { status: string };
    expect(childRun.status).toBe("completed");

    // Composition: no longer active
    const comp = db.prepare(`SELECT status FROM workflow_run_compositions WHERE id = 'comp-1'`).get() as { status: string };
    expect(comp.status).not.toBe("active");
    expect(comp.status).toBe("completed");

    // Parent run: active
    const parentRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string };
    expect(parentRun.status).toBe("active");

    // Goal: active run = parent
    const goal = db.prepare(`SELECT active_workflow_run_id FROM goals WHERE id = 'g1'`).get() as { active_workflow_run_id: string };
    expect(goal.active_workflow_run_id).toBe("r-parent");

    // delegate_join transition against parent run with passed verdict
    const transition = db.prepare(
      `SELECT * FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    expect(transition).toBeTruthy();
    expect(transition!.workflow_run_id).toBe("r-parent");
    const compositionFacet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    expect(compositionFacet.childVerdict).toBe("passed");
    expect(compositionFacet.childRunId).toBe("r-child");
  });

  it("failed verdict → propagated_failure, parent blocked, no writes artifact", () => {
    const deps = makeDeps();
    seedFixtures(deps);

    // Emit step_complete with failed verdict for child run
    emitStepComplete(
      { db, bus: deps.bus, now: deps.now, idFactory: deps.idFactory },
      {
        goalId: "g1",
        workflowRunId: "r-child",
        workflowStepRunId: "sr-child-1",
        evidence: {
          sensorsRun: [],
          verdict: "failed",
          untestedRegions: [],
          residualRisk: [],
          oracleAdequacy: { sufficient: false, gaps: [] },
        },
        telemetry: null,
        stateDeps: null,
      }
    );

    const result = joinChildRun(deps, "r-child");

    // Outcome
    expect(result.outcome).toBe("propagated_failure");
    expect(result.parentRunId).toBe("r-parent");

    // Parent run: blocked
    const parentRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string };
    expect(parentRun.status).toBe("blocked");

    // Composition: failed
    const comp = db.prepare(`SELECT status FROM workflow_run_compositions WHERE id = 'comp-1'`).get() as { status: string };
    expect(comp.status).toBe("failed");

    // No step_output artifact in parent namespace
    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM workflow_artifacts WHERE workflow_run_id = 'r-parent' AND type = 'step_output'`
    ).get() as { c: number };
    expect(count.c).toBe(0);

    // delegate_join transition with failed verdict
    const transition = db.prepare(
      `SELECT * FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    expect(transition).toBeTruthy();
    expect(transition!.workflow_run_id).toBe("r-parent");
    const compositionFacet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    expect(compositionFacet.childVerdict).toBe("failed");
  });
});
