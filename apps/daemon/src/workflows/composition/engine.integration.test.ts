import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { StepSkillProposal, TelemetryFacet, WorkflowArtifact } from "@orca/contracts";

import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { EventBus } from "../../events.js";
import type { Config } from "../../config.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetPreparedStatements as resetRunProjection } from "../runs/projection.js";
import { resetPreparedStatements as resetTemplateProjection } from "../templates/projection.js";
import { resetPreparedStatements as resetHarnessProjection } from "../../harness-transitions/usecases.js";
import { resetPreparedStatements as resetDecisionProjection } from "../../decisions/projection.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { emitStepComplete } from "../../harness-transitions/emit.js";
import { startWorkflowRun, cancelWorkflowRun } from "../runs/usecases.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { buildGoalCostRollup, buildGoalCostRollupAcross } from "../../harness-state/cost-rollup.js";
import { buildStepExecutionInput } from "../orchestrator/step-input.js";
import { descendantRunIds } from "./store.js";
import { DispatchEngine } from "../orchestrator/dispatch-engine.js";
import {
  fakeBroker,
  fakeRegistry,
  fakeStepDispatch,
} from "../orchestrator/skill-step-test-helpers.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-comp-eng-"));
  dirs.push(dir);
  const db = openDatabase(cfg(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

let db: Database.Database;
let bus: EventBus;
let n: number;
let sessions: number;

const idFactory = () => `id-${++n}`;
const now = () => NOW;

// Parent graph: step s-p0 → delegate dn → terminal step s-p1.
// Node ids equal step template ids (resolveStepNext keys off step_template_id).
const PARENT_GRAPH = JSON.stringify({
  nodes: [
    { id: "s-p0", type: "step", name: "Prep", stepId: "s-p0" },
    { id: "dn", type: "delegate", name: "Delegate", childTemplateId: "child-tpl", childTemplateVersion: 1,
      reads: { c_in: "seed" }, writes: { review: "findings" } },
    { id: "s-p1", type: "step", name: "Finish", stepId: "s-p1", terminal: true },
  ],
  edges: [{ from: "s-p0", to: "dn" }, { from: "dn", to: "s-p1" }],
  positions: { "s-p0": { x: 0, y: 0 }, dn: { x: 0, y: 90 }, "s-p1": { x: 0, y: 180 } },
});

const PARENT_STEPS = JSON.stringify([
  { id: "s-p0", ordinal: 0, name: "Prep", instructions: "Prep", outputSchema: [{ key: "seed", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
  { id: "s-p1", ordinal: 1, name: "Finish", instructions: "Finish", outputSchema: [{ key: "final", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
]);

const CHILD_STEPS = JSON.stringify([
  { id: "s-c0", ordinal: 0, name: "Child", instructions: "Do child work", outputSchema: [{ key: "findings", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] },
]);

function seedTemplates(): void {
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
     VALUES ('parent-tpl','Parent','d',1,0,0,?,?,?,?,?)`
  ).run(PARENT_STEPS, "[]", PARENT_GRAPH, NOW, NOW);
  db.prepare(
    `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
     VALUES ('child-tpl','Child','d',1,0,0,?,?,?,?)`
  ).run(CHILD_STEPS, "[]", NOW, NOW);
}

function seedGoal(operatingMode = "automated"): void {
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, operating_mode, created_at, updated_at, archived_at)
     VALUES ('g1','G','', 'active', 1, ?, ?, ?, NULL)`
  ).run(operatingMode, NOW, NOW);
}

function makeEngine(): DispatchEngine {
  const ask: StepSkillProposal = { action: "ask", question: "q?" };
  return new DispatchEngine(
    fakeBroker(ask),
    fakeRegistry(),
    { launch: async () => ({ sessionId: `sess-${++sessions}` }) },
    fakeStepDispatch(),
    undefined,
    undefined,
    undefined,
  );
}

function currentStepRunId(runId: string): string {
  return getWorkflowRunById(db, runId)!.currentStepRunId!;
}

function insertStepOutput(goalId: string, runId: string, stepRunId: string, body: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, created_at)
     VALUES (?, ?, ?, ?, 'step_output', 'out', ?, 'orchestrator', ?)`
  ).run(idFactory(), goalId, runId, stepRunId, JSON.stringify(body), NOW);
}

function costTelemetry(usd: number): TelemetryFacet {
  return {
    cost: { tokens_in: 10, tokens_out: 5, cache_read_tokens: null, cache_creation_tokens: null, usd },
    latency_ms: null, model: null, provider_id: null, provider_version: null,
    prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
    outcome: { status: "succeeded", failure_code: null },
  };
}

beforeEach(() => {
  db = openTestDb();
  bus = new EventBus();
  n = 0;
  sessions = 0;
});

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetRunProjection();
  resetTemplateProjection();
  resetHarnessProjection();
  resetDecisionProjection();
  resetWorkflowStepProjectionPreparedStatements();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Drive the parent to the delegate node → child spawned, parent delegating. */
async function driveToDelegating(engine: DispatchEngine): Promise<{ parentRunId: string; childRunId: string }> {
  const parent = startWorkflowRun({ db, bus, now, idFactory }, { goalId: "g1", templateId: "parent-tpl" });
  // Complete parent step s-p0 (produces `seed`), then advance → delegate entry.
  insertStepOutput("g1", parent.id, currentStepRunId(parent.id), { seed: "S" });
  await engine.advanceToNextStep(db, now, parent.id, { bus, idFactory });

  const comp = db.prepare("SELECT child_run_id FROM workflow_run_compositions WHERE parent_run_id = ?").get(parent.id) as { child_run_id: string } | undefined;
  return { parentRunId: parent.id, childRunId: comp?.child_run_id ?? "" };
}

describe("composition engine wiring", () => {
  it("(a)+(b) end-to-end: parent delegates, child joins back, parent reaches its own terminal", async () => {
    seedTemplates();
    seedGoal("automated");
    const engine = makeEngine();

    // ── (a) Delegate-node entry ──────────────────────────────────────────────
    const { parentRunId, childRunId } = await driveToDelegating(engine);
    expect(childRunId).toBeTruthy();

    expect(getWorkflowRunById(db, parentRunId)!.status).toBe("delegating");
    expect(getWorkflowRunById(db, childRunId)!.status).toBe("active");
    const goalActive = () => (db.prepare("SELECT active_workflow_run_id AS a FROM goals WHERE id='g1'").get() as { a: string }).a;
    expect(goalActive()).toBe(childRunId);

    const comp = db.prepare("SELECT * FROM workflow_run_compositions WHERE parent_run_id = ?").get(parentRunId) as Record<string, unknown>;
    expect(comp.status).toBe("active");
    // Auditable GoalDecision recorded at spawn.
    const decision = db.prepare("SELECT title FROM goal_decisions WHERE goal_id='g1' AND title LIKE 'Delegate to%'").get() as { title: string } | undefined;
    expect(decision?.title).toBe("Delegate to child-tpl v1");
    // Child seeded with the resolved reads only (isolated state).
    const entry = db.prepare("SELECT body FROM workflow_artifacts WHERE workflow_run_id=? AND step_run_id IS NULL AND type='step_output'").get(childRunId) as { body: string };
    expect(JSON.parse(entry.body)).toEqual({ c_in: "S" });

    // ── (b) Child terminal → join → parent resumes ───────────────────────────
    const childStepRunId = currentStepRunId(childRunId);
    // Child terminal evidence (passed verdict) + a $2 step cost.
    emitStepComplete({ db, bus, now, idFactory }, {
      goalId: "g1", workflowRunId: childRunId, workflowStepRunId: childStepRunId,
      evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
      telemetry: costTelemetry(2), stateDeps: null,
    });
    insertStepOutput("g1", childRunId, childStepRunId, { findings: "F" });
    await engine.advanceToNextStep(db, now, childRunId, { bus, idFactory });

    // Parent resumed active; child + composition completed; goal points back to parent.
    expect(getWorkflowRunById(db, childRunId)!.status).toBe("completed");
    expect(getWorkflowRunById(db, parentRunId)!.status).toBe("active");
    expect(goalActive()).toBe(parentRunId);
    const compAfter = db.prepare("SELECT status FROM workflow_run_compositions WHERE parent_run_id=?").get(parentRunId) as { status: string };
    expect(compAfter.status).toBe("completed");

    // Parent cursor advanced to the post-delegate terminal step; writes artifact present.
    const resumed = getWorkflowRunById(db, parentRunId)!;
    expect(resumed.currentNodeId).toBe("s-p1");
    const writes = db.prepare("SELECT body FROM workflow_artifacts WHERE workflow_run_id=? AND title='delegate writes'").get(parentRunId) as { body: string };
    expect(JSON.parse(writes.body)).toEqual({ review: "F" });

    // ── Parent reaches its OWN terminal (mark_run_complete, not a join) ───────
    insertStepOutput("g1", parentRunId, currentStepRunId(parentRunId), { final: "done" });
    await engine.advanceToNextStep(db, now, parentRunId, { bus, idFactory });
    const rec = db.prepare("SELECT type FROM recommendations WHERE goal_id='g1' AND type='complete_workflow_run'").get() as { type: string } | undefined;
    expect(rec?.type).toBe("complete_workflow_run");
    expect(getWorkflowRunById(db, parentRunId)!.status).toBe("active");

    // ── (e) Budget scope: child cost counts toward the parent workflow scope ──
    const across = buildGoalCostRollupAcross(db, "g1", descendantRunIds(db, parentRunId));
    expect(across?.usd).toBe(2);
    // The parent-run-only rollup does NOT include the child's cost.
    expect(buildGoalCostRollup(db, "g1", parentRunId)).toBeNull();

    // ── (f) mark_done roll-up spans descendants (same across-runs sum) ────────
    expect(descendantRunIds(db, parentRunId)).toContain(childRunId);
  });

  it("(g) cancelling the parent cascades the child + composition to cancelled", async () => {
    seedTemplates();
    seedGoal("automated");
    const engine = makeEngine();
    const { parentRunId, childRunId } = await driveToDelegating(engine);

    cancelWorkflowRun({ db, bus, now, idFactory }, parentRunId);

    expect(getWorkflowRunById(db, parentRunId)!.status).toBe("cancelled");
    expect(getWorkflowRunById(db, childRunId)!.status).toBe("cancelled");
    const comp = db.prepare("SELECT status FROM workflow_run_compositions WHERE parent_run_id=?").get(parentRunId) as { status: string };
    expect(comp.status).toBe("cancelled");
    // Goal pointer must be cleared — the leaf child was the active run, not the parent.
    const goalPtr = (db.prepare("SELECT active_workflow_run_id AS a FROM goals WHERE id='g1'").get() as { a: string | null }).a;
    expect(goalPtr).toBeNull();
  });

  it("(governance B) human_review + requiresLaunchApproval parks before spawning; confirm spawns", async () => {
    // Parent graph with requiresLaunchApproval on the delegate node.
    const graph = JSON.parse(PARENT_GRAPH);
    graph.nodes.find((x: { id: string }) => x.id === "dn").requiresLaunchApproval = true;
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('parent-tpl','Parent','d',1,0,0,?,?,?,?,?)`
    ).run(PARENT_STEPS, "[]", JSON.stringify(graph), NOW, NOW);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
       VALUES ('child-tpl','Child','d',1,0,0,?,?,?,?)`
    ).run(CHILD_STEPS, "[]", NOW, NOW);
    seedGoal("human_review");
    const engine = makeEngine();

    const parent = startWorkflowRun({ db, bus, now, idFactory }, { goalId: "g1", templateId: "parent-tpl" });
    insertStepOutput("g1", parent.id, currentStepRunId(parent.id), { seed: "S" });
    await engine.advanceToNextStep(db, now, parent.id, { bus, idFactory });

    // Parked: no child spawned, GoalDecision recorded, run still active on delegate node.
    expect(db.prepare("SELECT COUNT(*) AS c FROM workflow_run_compositions").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT title FROM goal_decisions WHERE title LIKE 'Delegate to%'").get()).toBeTruthy();
    const parked = getWorkflowRunById(db, parent.id)!;
    expect(parked.status).toBe("active");
    expect(parked.currentNodeKind).toBe("delegate");

    // Confirm the launch → child spawned, parent delegating.
    await engine.confirmDelegateLaunch(db, now, parent.id, { bus, idFactory });
    expect(db.prepare("SELECT COUNT(*) AS c FROM workflow_run_compositions").get()).toEqual({ c: 1 });
    expect(getWorkflowRunById(db, parent.id)!.status).toBe("delegating");
  });

  it("(c) delegate writes surface on the skill/model prior-output path", () => {
    // The delegate surrogate step-run is NOT a template step; assert buildStepExecutionInput
    // still surfaces its output when threaded via delegatePriorOutputs.
    const artifacts: WorkflowArtifact[] = [];
    const input = buildStepExecutionInput({
      goal: { id: "g1", description: "d" },
      steps: [{ id: "s-p1", ordinal: 1, name: "Finish", instructions: "", outputSchema: [], agentPreference: [] } as never],
      currentStep: { id: "s-p1", ordinal: 1, name: "Finish", instructions: "", outputSchema: [] } as never,
      artifacts,
      transcript: [],
      stepRunByStepId: {},
      delegatePriorOutputs: [{ stepId: "dn", stepName: "Delegate", output: { review: "F" } }],
    });
    expect(input.priorStepOutputs).toContainEqual({ stepId: "dn", stepName: "Delegate", output: { review: "F" } });
    expect(input.previousStepOutput).toEqual({ review: "F" });
  });
});
