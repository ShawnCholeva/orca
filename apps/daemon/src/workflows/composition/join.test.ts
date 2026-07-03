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
import { joinChildRun, type JoinDeps, type SensorRunner } from "./join.js";
import type { VersionProbe } from "../../harness-state/workspace-version.js";

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

// Parent template graph with validationRequired: true on dn1
const PARENT_GRAPH_VALIDATION_REQUIRED_JSON = JSON.stringify({
  nodes: [
    { id: "dn1", type: "delegate", name: "Delegate", childTemplateId: "child-tpl", childTemplateVersion: 1, validationRequired: true },
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
 * @param parentGraphJson - optional override for the parent template graph JSON
 * @param workspaceSnapshotJson - optional workspace snapshot to store on the composition row
 */
function seedFixtures(
  deps: JoinDeps,
  {
    parentGraphJson = PARENT_GRAPH_JSON,
    workspaceSnapshotJson = null,
  }: {
    parentGraphJson?: string;
    workspaceSnapshotJson?: string | null;
  } = {}
): string {
  // Templates
  db.prepare(
    `INSERT INTO workflow_templates
       (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`
  ).run("parent-tpl", "Parent Tpl", "desc", 1, PARENT_STEPS_JSON, "[]", parentGraphJson, NOW, NOW);

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
       (id, goal_id, parent_run_id, child_run_id, delegate_node_id, spawn_seq, reads_json, writes_json,
        parent_workspace_snapshot_json, depth, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    compositionId, "g1", "r-parent", "r-child", "dn1", 0,
    JSON.stringify({}),
    JSON.stringify({ review_findings: "findings" }),
    workspaceSnapshotJson,
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

/** A probe that always returns the given version — used for I3 testing. */
function makeProbe(branch: string | null, dirty: boolean | null): VersionProbe {
  return () => ({ branch, dirty });
}

/** A sensor runner that always returns the given verdict — used for I4 testing. */
function makeSensorRunner(verdict: "passed" | "failed" | "partial", reason?: string): SensorRunner {
  return async () => ({ verdict, reason });
}

describe("joinChildRun", () => {
  it("passed verdict → writes artifact, child completed, parent active, delegate_join emitted", async () => {
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

    const result = await joinChildRun(deps, "r-child");

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

    // Cursor advanced to delegate's outgoing target (ns1)
    const parentRunAfter = db.prepare(`SELECT current_node_id FROM workflow_runs WHERE id = 'r-parent'`).get() as { current_node_id: string };
    expect(parentRunAfter.current_node_id).toBe("ns1");

    // delegate_join transition against parent run with passed verdict
    const transition = db.prepare(
      `SELECT * FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    expect(transition).toBeTruthy();
    expect(transition!.workflow_run_id).toBe("r-parent");
    const compositionFacet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    expect(compositionFacet.childVerdict).toBe("passed");
    expect(compositionFacet.childRunId).toBe("r-child");
    // I3: null snapshot → { diverged: false } (nothing to compare)
    expect(compositionFacet.beliefDivergence).toEqual({ diverged: false });
    // I4: no validationRequired → ran: false
    expect(compositionFacet.verifyResult).toEqual({ ran: false, vetoed: false });
  });

  it("failed verdict → propagated_failure, parent blocked, no writes artifact", async () => {
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

    const result = await joinChildRun(deps, "r-child");

    // Outcome
    expect(result.outcome).toBe("propagated_failure");
    expect(result.parentRunId).toBe("r-parent");

    // Parent run: blocked
    const parentRun = db.prepare(`SELECT status, blocked_reason FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string; blocked_reason: string | null };
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

  it("child-reason: parent blocked_reason carries the child's actual failure reason", async () => {
    const deps = makeDeps();
    seedFixtures(deps);

    // Set a specific blocked_reason on the child run to simulate a previously
    // blocked child that joinChildRun is now propagating.
    db.prepare(`UPDATE workflow_runs SET blocked_reason = 'tests failed: 3 assertions' WHERE id = 'r-child'`).run();

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

    await joinChildRun(deps, "r-child");

    // Parent blocked_reason should carry the child's reason, not a generic string
    const parentRun = db.prepare(`SELECT blocked_reason FROM workflow_runs WHERE id = 'r-parent'`).get() as { blocked_reason: string | null };
    expect(parentRun.blocked_reason).not.toBe("child run failed");
    expect(parentRun.blocked_reason).toContain("tests failed: 3 assertions");
  });

  it("child-reason fallback: when child has no blocked_reason, uses verdict-based message", async () => {
    const deps = makeDeps();
    seedFixtures(deps);

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

    await joinChildRun(deps, "r-child");

    const parentRun = db.prepare(`SELECT blocked_reason FROM workflow_runs WHERE id = 'r-parent'`).get() as { blocked_reason: string | null };
    // Should be informative (not just "child run failed")
    expect(parentRun.blocked_reason).toBeTruthy();
    expect(parentRun.blocked_reason).not.toBe("child run failed");
    // Should mention the verdict or child run failure in a clear way
    expect(parentRun.blocked_reason).toMatch(/child|failed|verdict/i);
  });

  it("I3: workspace diverged → beliefDivergence.diverged = true on passed join", async () => {
    const deps = makeDeps();
    // Snapshot records branch = "main"; probe returns "feat/x" → diverged
    const snapshotJson = JSON.stringify({ id: "ws-1", path: "/fake/ws", branch: "main", dirty: false });
    seedFixtures(deps, { workspaceSnapshotJson: snapshotJson });

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

    const divergedProbe = makeProbe("feat/x", false);
    const result = await joinChildRun(deps, "r-child", divergedProbe);

    expect(result.outcome).toBe("joined");

    const transition = db.prepare(
      `SELECT composition_json FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    expect(transition).toBeTruthy();
    const facet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    const bd = facet.beliefDivergence as { diverged: boolean; details?: string } | null;
    expect(bd).not.toBeNull();
    expect(bd!.diverged).toBe(true);
    expect(bd!.details).toContain("main");
    expect(bd!.details).toContain("feat/x");
  });

  it("I3: workspace not diverged → beliefDivergence.diverged = false on passed join", async () => {
    const deps = makeDeps();
    const snapshotJson = JSON.stringify({ id: "ws-1", path: "/fake/ws", branch: "main", dirty: false });
    seedFixtures(deps, { workspaceSnapshotJson: snapshotJson });

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

    const matchingProbe = makeProbe("main", false);
    const result = await joinChildRun(deps, "r-child", matchingProbe);

    expect(result.outcome).toBe("joined");

    const transition = db.prepare(
      `SELECT composition_json FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    const facet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    const bd = facet.beliefDivergence as { diverged: boolean; details?: string };
    expect(bd.diverged).toBe(false);
  });

  it("I4: validationRequired + vetoed sensor → parent blocked, outcome propagated_failure", async () => {
    const deps = makeDeps();
    // Fixture with validationRequired: true on dn1
    seedFixtures(deps, { parentGraphJson: PARENT_GRAPH_VALIDATION_REQUIRED_JSON });

    // Add a workspace so the sensor runner gets invoked
    db.prepare(`INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run("ws-1", "test-ws", "/fake/workspace", NOW, NOW);
    db.prepare(`INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`).run("g1", "ws-1", NOW);

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

    const vetoingSensorRunner = makeSensorRunner("failed", "typecheck: type error in main.ts");
    const result = await joinChildRun(deps, "r-child", undefined, vetoingSensorRunner);

    // Vetoed → propagated_failure, parent blocked
    expect(result.outcome).toBe("propagated_failure");

    const parentRun = db.prepare(`SELECT status, blocked_reason FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string; blocked_reason: string | null };
    expect(parentRun.status).toBe("blocked");
    expect(parentRun.blocked_reason).toContain("typecheck: type error in main.ts");

    // Child still completed (its verdict was passed; join veto is parent-side)
    const childRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-child'`).get() as { status: string };
    expect(childRun.status).toBe("completed");

    // delegate_join transition carries verifyResult with vetoed: true
    const transition = db.prepare(
      `SELECT composition_json FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    expect(transition).toBeTruthy();
    const facet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    const vr = facet.verifyResult as { ran: boolean; vetoed: boolean; reason?: string };
    expect(vr.ran).toBe(true);
    expect(vr.vetoed).toBe(true);
    expect(vr.reason).toContain("typecheck: type error in main.ts");

    // No writes artifact in parent namespace (veto prevents materialization)
    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM workflow_artifacts WHERE workflow_run_id = 'r-parent' AND type = 'step_output'`
    ).get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("I4: validationRequired + sensor passes → joined, verifyResult ran:true vetoed:false", async () => {
    const deps = makeDeps();
    seedFixtures(deps, { parentGraphJson: PARENT_GRAPH_VALIDATION_REQUIRED_JSON });

    db.prepare(`INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run("ws-1", "test-ws", "/fake/workspace", NOW, NOW);
    db.prepare(`INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`).run("g1", "ws-1", NOW);

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

    const passingSensorRunner = makeSensorRunner("passed");
    const result = await joinChildRun(deps, "r-child", undefined, passingSensorRunner);

    expect(result.outcome).toBe("joined");

    const transition = db.prepare(
      `SELECT composition_json FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    const facet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    const vr = facet.verifyResult as { ran: boolean; vetoed: boolean };
    expect(vr.ran).toBe(true);
    expect(vr.vetoed).toBe(false);
  });

  it("I4: validationRequired absent → verifyResult ran:false (sensor runner never called)", async () => {
    const deps = makeDeps();
    seedFixtures(deps); // uses PARENT_GRAPH_JSON which has no validationRequired

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

    let sensorCalled = false;
    const trackingSensorRunner: SensorRunner = async () => {
      sensorCalled = true;
      return { verdict: "failed", reason: "should not run" };
    };

    const result = await joinChildRun(deps, "r-child", undefined, trackingSensorRunner);

    expect(result.outcome).toBe("joined");
    expect(sensorCalled).toBe(false);

    const transition = db.prepare(
      `SELECT composition_json FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    const facet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    expect(facet.verifyResult).toEqual({ ran: false, vetoed: false });
  });

  it("I4 fail-closed: validationRequired + sensor runner throws → parent blocked, outcome propagated_failure", async () => {
    const deps = makeDeps();
    seedFixtures(deps, { parentGraphJson: PARENT_GRAPH_VALIDATION_REQUIRED_JSON });

    // Add a workspace so the sensor-infra path is reached
    db.prepare(`INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run("ws-1", "test-ws", "/fake/workspace", NOW, NOW);
    db.prepare(`INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`).run("g1", "ws-1", NOW);

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

    const throwingSensorRunner: SensorRunner = async () => {
      throw new Error("sensor infra failure: disk read error");
    };

    const result = await joinChildRun(deps, "r-child", undefined, throwingSensorRunner);

    // Fail-closed: sensor infra error → propagated_failure, NOT joined
    expect(result.outcome).toBe("propagated_failure");

    const parentRun = db.prepare(`SELECT status, blocked_reason FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string; blocked_reason: string | null };
    expect(parentRun.status).toBe("blocked");
    expect(parentRun.blocked_reason).toContain("delegate validation could not run");
    expect(parentRun.blocked_reason).toContain("sensor infra failure: disk read error");

    // Child completed (its verdict passed; the block is join-side)
    const childRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-child'`).get() as { status: string };
    expect(childRun.status).toBe("completed");

    const comp = db.prepare(`SELECT status FROM workflow_run_compositions WHERE id = 'comp-1'`).get() as { status: string };
    expect(comp.status).toBe("failed");

    // verifyResult: ran:false, vetoed:false — the check didn't run (not a veto)
    const transition = db.prepare(
      `SELECT composition_json FROM harness_transitions WHERE goal_id = 'g1' AND boundary = 'delegate_join'`
    ).get() as Record<string, unknown> | undefined;
    expect(transition).toBeTruthy();
    const facet = JSON.parse(transition!.composition_json as string) as Record<string, unknown>;
    const vr = facet.verifyResult as { ran: boolean; vetoed: boolean };
    expect(vr.ran).toBe(false);
    expect(vr.vetoed).toBe(false);
  });

  it("I4 fail-closed: validationRequired + no workspace → parent blocked, outcome propagated_failure", async () => {
    const deps = makeDeps();
    seedFixtures(deps, { parentGraphJson: PARENT_GRAPH_VALIDATION_REQUIRED_JSON });
    // No workspace inserted — goal has no attached workspace

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

    let sensorCalled = false;
    const trackingSensorRunner: SensorRunner = async () => {
      sensorCalled = true;
      return { verdict: "passed" };
    };

    const result = await joinChildRun(deps, "r-child", undefined, trackingSensorRunner);

    // Fail-closed: no workspace → propagated_failure, NOT joined
    expect(result.outcome).toBe("propagated_failure");
    expect(sensorCalled).toBe(false); // sensor never reached

    const parentRun = db.prepare(`SELECT status, blocked_reason FROM workflow_runs WHERE id = 'r-parent'`).get() as { status: string; blocked_reason: string | null };
    expect(parentRun.status).toBe("blocked");
    expect(parentRun.blocked_reason).toContain("delegate validation could not run");
    expect(parentRun.blocked_reason).toContain("no workspace attached");

    const childRun = db.prepare(`SELECT status FROM workflow_runs WHERE id = 'r-child'`).get() as { status: string };
    expect(childRun.status).toBe("completed");

    const comp = db.prepare(`SELECT status FROM workflow_run_compositions WHERE id = 'comp-1'`).get() as { status: string };
    expect(comp.status).toBe("failed");
  });

  it("delegate re-entry: second join through same delegate node gets attempt=2 (no UNIQUE collision)", async () => {
    const deps = makeDeps();
    seedFixtures(deps);

    // First join: r-child through dn1 → surrogate attempt=1
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
    const result1 = await joinChildRun(deps, "r-child");
    expect(result1.outcome).toBe("joined");

    // Verify first surrogate has attempt=1
    const surrogate1 = db.prepare(
      `SELECT attempt FROM workflow_step_runs WHERE workflow_run_id = 'r-parent' AND step_template_id = 'dn1'`
    ).get() as { attempt: number } | undefined;
    expect(surrogate1?.attempt).toBe(1);

    // Simulate re-entry: parent loops back to delegate node, a new child is spawned.
    // Set parent back to delegating at dn1 (exits the active-per-goal unique index),
    // then insert a second child run + composition for the same delegate node.
    db.prepare(`UPDATE workflow_runs SET status = 'delegating', current_node_id = 'dn1', current_step_run_id = NULL WHERE id = 'r-parent'`).run();

    db.prepare(
      `INSERT INTO workflow_runs
         (id, goal_id, template_id, template_version, status, started_at)
       VALUES ('r-child2', 'g1', 'child-tpl', 1, 'active', ?)`
    ).run(NOW);

    db.prepare(
      `INSERT INTO workflow_run_compositions
         (id, goal_id, parent_run_id, child_run_id, delegate_node_id, spawn_seq, reads_json, writes_json, depth, status, created_at)
       VALUES ('comp-2', 'g1', 'r-parent', 'r-child2', 'dn1', 1, '{}', ?, 1, 'active', ?)`
    ).run(JSON.stringify({ review_findings: "findings" }), NOW);

    db.prepare(`UPDATE workflow_runs SET parent_composition_id = 'comp-2' WHERE id = 'r-child2'`).run();
    db.prepare(`UPDATE goals SET active_workflow_run_id = 'r-child2' WHERE id = 'g1'`).run();

    db.prepare(
      `INSERT INTO workflow_step_runs
         (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt,
          status, satisfied_exit_criteria_json, outstanding_exit_criteria_json,
          fingerprint, started_at, finished_at)
       VALUES ('sr-child2-1', 'g1', 'r-child2', 's-child-1', 0, 1, 'passed', '[]', '[]', 'fp-child2', ?, ?)`
    ).run(NOW, NOW);

    db.prepare(`UPDATE workflow_runs SET current_step_run_id = 'sr-child2-1' WHERE id = 'r-child2'`).run();

    db.prepare(
      `INSERT INTO workflow_artifacts
         (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, created_at)
       VALUES ('art-child2-1', 'g1', 'r-child2', 'sr-child2-1', 'step_output', 'child output', ?, 'orchestrator', ?)`
    ).run(JSON.stringify({ findings: ["y"] }), NOW);

    // Second join: r-child2 through dn1 → must not throw; surrogate gets attempt=2
    emitStepComplete(
      { db, bus: deps.bus, now: deps.now, idFactory: deps.idFactory },
      {
        goalId: "g1",
        workflowRunId: "r-child2",
        workflowStepRunId: "sr-child2-1",
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

    await expect(joinChildRun(deps, "r-child2")).resolves.not.toThrow();

    // Both surrogates exist with distinct attempt values
    const surrogates = db.prepare(
      `SELECT attempt FROM workflow_step_runs WHERE workflow_run_id = 'r-parent' AND step_template_id = 'dn1' ORDER BY attempt`
    ).all() as { attempt: number }[];
    expect(surrogates).toHaveLength(2);
    expect(surrogates[0].attempt).toBe(1);
    expect(surrogates[1].attempt).toBe(2);
  });
});
