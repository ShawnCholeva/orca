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
import { spawnChildRun, DelegationDepthError, type SpawnDeps } from "./spawn.js";
import { MAX_DELEGATION_DEPTH } from "./depth.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-spawn-"));
  dirs.push(dir);
  const db = openDatabase(cfg(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

let db: Database.Database;
let n: number;

function makeDeps(): SpawnDeps {
  return {
    db,
    bus: new EventBus(),
    now: () => NOW,
    idFactory: () => `id-${++n}`,
  };
}

const MINIMAL_STEP = JSON.stringify([{
  id: "s1", ordinal: 0, name: "Step", instructions: "Do it",
  outputSchema: [{ key: "diff_ref", type: "string", required: true }],
  agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
}]);

function seedTemplate(id: string, version = 1): void {
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`
  ).run(id, `Tpl ${id}`, "desc", version, MINIMAL_STEP, "[]", NOW, NOW);
}

function seedGoal(id: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 'G', '', 'active', 1, ?, ?, NULL)`
  ).run(id, NOW, NOW);
}

/** Seeds an active run and sets goals.active_workflow_run_id to that run. */
function seedActiveRun(goalId: string, templateId: string, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, ?, 1, 'active', ?)`
  ).run(runId, goalId, templateId, NOW);
  db.prepare(`UPDATE goals SET active_workflow_run_id = ? WHERE id = ?`).run(runId, goalId);
}

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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GOAL = "g1";
const PARENT_TPL = "parent-tpl";
const CHILD_TPL = "child-tpl";
const PARENT_RUN = "parent-run-1";

const delegateNode = {
  id: "delegate-node-1",
  childTemplateId: CHILD_TPL,
  childTemplateVersion: 1,
  reads: { diff_ref: "change_ref" },
  writes: { result: "output" },
};

function seedBase(): void {
  seedGoal(GOAL);
  seedTemplate(PARENT_TPL);
  seedTemplate(CHILD_TPL);
  seedActiveRun(GOAL, PARENT_TPL, PARENT_RUN);
}

describe("spawnChildRun", () => {
  it("creates child run active with parent_composition_id, parks parent, seeds composition + artifact, emits delegate_spawn", () => {
    seedBase();
    const deps = makeDeps();

    const { childRunId, compositionId } = spawnChildRun(deps, {
      goalId: GOAL,
      parentRun: { id: PARENT_RUN },
      delegateNode,
      parentOutputs: { change_ref: "abc" },
      workspaceSnapshotJson: null,
    });

    // child run is active with parent_composition_id set
    const childRun = db.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(childRunId) as
      Record<string, unknown>;
    expect(childRun.status).toBe("active");
    expect(childRun.parent_composition_id).toBe(compositionId);

    // composition row exists with correct linkage and depth
    const comp = db.prepare(`SELECT * FROM workflow_run_compositions WHERE id = ?`).get(compositionId) as
      Record<string, unknown>;
    expect(comp.parent_run_id).toBe(PARENT_RUN);
    expect(comp.child_run_id).toBe(childRunId);
    expect(comp.depth).toBe(1);
    expect(comp.status).toBe("active");

    // parent is parked to delegating
    const parentRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = ?`).get(PARENT_RUN) as
      Record<string, string>;
    expect(parentRun.status).toBe("delegating");

    // goal's active run pointer updated to child
    const goalRow = db.prepare(`SELECT active_workflow_run_id FROM goals WHERE id = ?`).get(GOAL) as
      Record<string, string>;
    expect(goalRow.active_workflow_run_id).toBe(childRunId);

    // entry artifact in child run with resolved reads and null step_run_id
    const artifact = db.prepare(
      `SELECT * FROM workflow_artifacts WHERE workflow_run_id = ? AND type = 'step_output' AND source = 'orchestrator'`
    ).get(childRunId) as Record<string, unknown>;
    expect(artifact).toBeTruthy();
    expect(JSON.parse(artifact.body as string)).toEqual({ diff_ref: "abc" });
    expect(artifact.step_run_id).toBeNull();

    // delegate_spawn harness transition emitted against parent run
    const transition = db.prepare(
      `SELECT * FROM harness_transitions WHERE goal_id = ? AND boundary = 'delegate_spawn'`
    ).get(GOAL) as Record<string, unknown>;
    expect(transition).toBeTruthy();
    expect(transition.workflow_run_id).toBe(PARENT_RUN);
    expect(transition.workflow_step_run_id).toBeNull();

    // composition facet stored in composition_json with correct delegation metadata
    const compositionFacet = JSON.parse(transition.composition_json as string) as Record<string, unknown>;
    expect(compositionFacet.childRunId).toBe(childRunId);
    expect(compositionFacet.readsKeys).toEqual(["diff_ref"]);
    expect(compositionFacet.writesKeys).toEqual(["result"]);
    expect(compositionFacet.depth).toBe(1);
  });

  it("throws DelegationDepthError when depth exceeds MAX_DELEGATION_DEPTH", () => {
    seedBase();
    // Build a depth-MAX chain from PARENT_RUN by directly inserting delegating runs
    let currentRunId = PARENT_RUN;
    for (let i = 0; i < MAX_DELEGATION_DEPTH; i++) {
      const childId = `deep-child-${i}`;
      const compId = `deep-comp-${i}`;
      db.prepare(
        `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, ?, 1, 'delegating', ?)`
      ).run(childId, GOAL, PARENT_TPL, NOW);
      db.prepare(
        `INSERT INTO workflow_run_compositions (id, goal_id, parent_run_id, child_run_id, delegate_node_id, spawn_seq, reads_json, writes_json, depth, status, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', ?, 'active', ?)`
      ).run(compId, GOAL, currentRunId, childId, "dn", i, i + 1, NOW);
      db.prepare(`UPDATE workflow_runs SET parent_composition_id = ? WHERE id = ?`).run(compId, childId);
      currentRunId = childId;
    }

    // currentRunId is now at depth MAX_DELEGATION_DEPTH; spawning from it would be MAX+1
    const deps = makeDeps();
    expect(() =>
      spawnChildRun(deps, {
        goalId: GOAL,
        parentRun: { id: currentRunId },
        delegateNode,
        parentOutputs: {},
        workspaceSnapshotJson: null,
      })
    ).toThrow(DelegationDepthError);
  });
});
