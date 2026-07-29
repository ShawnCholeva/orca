import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent, WorkflowStepResult } from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { getWorkflowRunById } from "../runs/projection.js";
import {
  completeWorkflowRun,
  markWorkflowRunBlocked,
  resumeWorkflowRun,
  startWorkflowRun,
  type WorkflowRunUsecaseCtx,
} from "../runs/usecases.js";
import {
  advanceToNextStep,
  advanceToNextStepOrGate,
  failStep,
  markStepBlocked,
  nextAttemptForStep,
  recordExitCriteriaSatisfaction,
  retryStep,
  stepFingerprint,
} from "./usecases.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

// Local fixture: engineering template used as a test fixture for linear step progression.
// Copied from the deleted seed-engineering.ts; the id and steps are intentionally preserved
// so that tests that check step counts, step IDs, and ordinals remain valid.
const ENGINEERING_ID = "orca/engineering";
const ENGINEERING_VERSION = 5;
const _ENG_AGENT = [{ adapterId: "claude-code", modelId: "claude-sonnet-4-6" }];
const _ENG_OUT = [{ key: "summary", type: "string", required: true }];
const ENGINEERING_STEPS = JSON.stringify([
  { id: "intake", ordinal: 0, name: "Intake", instructions: "intake", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
  { id: "research", ordinal: 1, name: "Research", instructions: "research", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
  { id: "prd", ordinal: 2, name: "PRD / Destination", instructions: "prd", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
  { id: "issue_breakdown", ordinal: 3, name: "Issue Breakdown", instructions: "breakdown", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
  { id: "execution", ordinal: 4, name: "Execution", instructions: "execute", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
  { id: "qa", ordinal: 5, name: "QA", instructions: "qa", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
  { id: "review", ordinal: 6, name: "Fresh-Context Review", instructions: "review", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
  { id: "done", ordinal: 7, name: "Done", instructions: "done", outputSchema: _ENG_OUT, agentPreference: _ENG_AGENT },
]);
function seedEngineeringTemplate(db: Database.Database, now: () => string): void {
  const existing = db.prepare("SELECT version FROM workflow_templates WHERE id = ?").get(ENGINEERING_ID) as { version: number } | undefined;
  if (existing && existing.version >= ENGINEERING_VERSION) return;
  const ts = now();
  if (existing) {
    db.prepare("UPDATE workflow_templates SET name = ?, description = ?, version = ?, is_built_in = 1, is_locked = 1, steps_json = ?, guardrails_json = ?, updated_at = ? WHERE id = ?")
      .run("Engineering", "Engineering template fixture", ENGINEERING_VERSION, ENGINEERING_STEPS, "[]", ts, ENGINEERING_ID);
  } else {
    db.prepare("INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)")
      .run(ENGINEERING_ID, "Engineering", "Engineering template fixture", ENGINEERING_VERSION, ENGINEERING_STEPS, "[]", ts, ts);
  }
}

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

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function getStep(db: Database.Database, id: string) {
  return db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, started_at, finished_at, blocked_reason, fingerprint, step_result_json FROM workflow_step_runs WHERE id = ?"
    )
    .get(id) as
    | {
        id: string;
        goal_id: string;
        workflow_run_id: string;
        step_template_id: string;
        ordinal: number;
        attempt: number;
        status: string;
        satisfied_exit_criteria_json: string;
        outstanding_exit_criteria_json: string;
        started_at: string | null;
        finished_at: string | null;
        blocked_reason: string | null;
        fingerprint: string;
        step_result_json: string | null;
      }
    | undefined;
}

function readStepResultJson(db: Database.Database, id: string) {
  const row = db
    .prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = ?")
    .get(id) as { step_result_json: string | null };
  expect(row.step_result_json).toBeTruthy();
  return JSON.parse(row.step_result_json!) as unknown;
}

function stepResultActivityCount(db: Database.Database, stepRunId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM activities WHERE step_run_id = ? AND source_kind = 'step_result'"
      )
      .get(stepRunId) as { count: number }
  ).count;
}

function scoredStepResult(stepId: string): WorkflowStepResult {
  return {
    stepId,
    stepStatus: "completed",
    evaluationStatus: "scored",
    successScore: 0.87,
    quality: {
      outputCompleteness: 0.9,
      outputCorrectness: 0.8,
      instructionAdherence: 0.9,
      downstreamReadiness: 0.85,
      riskLevel: 0.2,
    },
    performance: {
      durationSeconds: 0,
      retries: 0,
    },
    outcome: {
      reason: "Ready for the next step.",
      producedArtifactsCount: 0,
      blockingIssuesCount: 0,
      warningsCount: 0,
      handoffReady: true,
    },
  };
}

function setup(): {
  db: Database.Database;
  events: DomainEvent[];
  runCtx: WorkflowRunUsecaseCtx;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-steps-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const events: DomainEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((event) => {
    events.push(event);
  });
  let nextId = 0;
  return {
    db,
    events,
    runCtx: {
      db,
      bus,
      now: () => NOW,
      idFactory: () => `fixed-id-${++nextId}`,
    },
  };
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow step usecases", () => {
  it("advances through all eight Engineering steps and completes the run", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    expect(run.currentStepRunId).toBeTruthy();

    let currentRun = run;
    let terminalStepRunId: string | null = null;
    while (currentRun.currentStepRunId) {
      const step = getStep(db, currentRun.currentStepRunId);
      expect(step).toBeTruthy();
      const outstanding = JSON.parse(step!.outstanding_exit_criteria_json) as string[];
      recordExitCriteriaSatisfaction(db, () => NOW, step!.id, outstanding);
      const next = advanceToNextStep(db, () => NOW, step!.id);
      currentRun = getWorkflowRunById(db, run.id)!;
      // The terminal step yields (next === null) without completing the run.
      if (next === null) {
        terminalStepRunId = step!.id;
        break;
      }
    }

    // Terminal step finished: the run stays active until the user approves completion.
    const yieldedRun = getWorkflowRunById(db, run.id);
    expect(yieldedRun?.status).toBe("active");
    expect(yieldedRun?.currentStepRunId).toBe(terminalStepRunId);

    // Simulate the user approving the complete_workflow_run recommendation.
    completeWorkflowRun(runCtx, run.id);

    const completedRun = getWorkflowRunById(db, run.id);
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.finishedAt).toBe(NOW);
    const goalRow = db
      .prepare("SELECT active_workflow_run_id FROM goals WHERE id = ?")
      .get("goal-1") as { active_workflow_run_id: string | null };
    expect(goalRow.active_workflow_run_id).toBeNull();

    const stepCount = db
      .prepare("SELECT COUNT(*) as count FROM workflow_step_runs WHERE workflow_run_id = ?")
      .get(run.id) as { count: number };
    expect(stepCount.count).toBe(8);

    const eventTypes = db
      .prepare("SELECT type FROM events ORDER BY seq ASC")
      .all() as Array<{ type: string }>;
    expect(eventTypes.filter((event) => event.type === "workflow.step.started")).toHaveLength(8);
    expect(eventTypes.filter((event) => event.type === "workflow.step.completed")).toHaveLength(
      8
    );
    expect(eventTypes.at(-1)?.type).toBe("workflow.run.completed");
  });

  it("blocked + resume opens a fresh attempt of the same step (blocked rows are terminal)", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const initialStepId = run.currentStepRunId!;
    const initialStep = getStep(db, initialStepId)!;
    expect(initialStep.attempt).toBe(1);

    markStepBlocked(db, () => NOW, initialStepId, "Need <secret> detail");
    markWorkflowRunBlocked(runCtx, run.id, "waiting for operator");
    const resumed = resumeWorkflowRun(runCtx, run.id);
    expect(resumed.status).toBe("active");
    // markStepBlocked sets finished_at, so the blocked row is TERMINAL; resume must
    // not revive it — it opens a fresh attempt of the same step instead.
    expect(resumed.currentStepRunId).not.toBe(initialStepId);

    const freshStep = getStep(db, resumed.currentStepRunId!)!;
    expect(freshStep.step_template_id).toBe(initialStep.step_template_id);
    expect(freshStep.attempt).toBe(2);
    expect(freshStep.status).toBe("active");

    const stepAfterResume = getStep(db, initialStepId)!;
    expect(stepAfterResume.attempt).toBe(1);
    expect(stepAfterResume.status).toBe("blocked");
    expect(stepAfterResume.blocked_reason).toBe("Need <secret> detail");
  });

  it("fail + retry creates attempt 2 with a new fingerprint", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const stepId = run.currentStepRunId!;
    const attempt1 = getStep(db, stepId)!;

    const failed = failStep(db, () => NOW, stepId);
    expect(failed.status).toBe("failed");

    const retried = retryStep(db, () => NOW, stepId);
    expect(retried.attempt).toBe(2);
    expect(retried.stepTemplateId).toBe(attempt1.step_template_id);
    expect(retried.workflowRunId).toBe(run.id);

    const retryRow = getStep(db, retried.id)!;
    expect(retryRow.fingerprint).toBe(stepFingerprint(run.id, attempt1.step_template_id, 2));
    expect(retryRow.fingerprint).not.toBe(attempt1.fingerprint);
    expect(
      db
        .prepare("SELECT current_step_run_id FROM workflow_runs WHERE id = ?")
        .get(run.id) as { current_step_run_id: string | null }
    ).toEqual({ current_step_run_id: retried.id });
  });

  it("advanceToNextStep persists provided scored step result", () => {
    const { db, events, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const first = getStep(db, run.currentStepRunId!)!;
    const scored = scoredStepResult(first.id);

    advanceToNextStep(
      db,
      () => NOW,
      first.id,
      { activityCtx: runCtx },
      scored
    );

    expect(readStepResultJson(db, first.id)).toEqual(scored);
    expect(stepResultActivityCount(db, first.id)).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "activity.changed" &&
          (event.payload as { stepRunId?: string }).stepRunId === first.id
      )
    ).toHaveLength(1);
  });

  it("advanceToNextStep rejects supplied step result for a different step", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const first = getStep(db, run.currentStepRunId!)!;

    expect(() =>
      advanceToNextStep(db, () => NOW, first.id, undefined, scoredStepResult("other-step"))
    ).toThrow(/stepId/);
  });

  it("advanceToNextStep rejects supplied step result with mismatched status", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const first = getStep(db, run.currentStepRunId!)!;
    const scored: WorkflowStepResult = {
      ...scoredStepResult(first.id),
      stepStatus: "blocked",
    };

    expect(() =>
      advanceToNextStep(db, () => NOW, first.id, undefined, scored)
    ).toThrow(/stepStatus/);
  });

  it("advanceToNextStep redacts supplied step result reason before persisting", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const first = getStep(db, run.currentStepRunId!)!;
    const scored: WorkflowStepResult = {
      ...scoredStepResult(first.id),
      outcome: {
        ...scoredStepResult(first.id).outcome,
        reason: "Ready with password=supersecret123",
      },
    };

    advanceToNextStep(db, () => NOW, first.id, undefined, scored);

    expect(readStepResultJson(db, first.id)).toMatchObject({
      outcome: {
        reason: "Ready with password=[redacted]",
      },
    });
  });

  it("markStepBlocked persists daemon evaluation-failed step result", () => {
    const { db, events, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const first = getStep(db, run.currentStepRunId!)!;

    markStepBlocked(db, () => NOW, first.id, "Need input", {
      activityCtx: runCtx,
    });

    expect(readStepResultJson(db, first.id)).toMatchObject({
      stepId: first.id,
      stepStatus: "blocked",
      evaluationStatus: "failed",
      successScore: 0,
      outcome: {
        reason: "step result evaluation failed: orchestrator scoring not supplied",
        blockingIssuesCount: 1,
        handoffReady: false,
      },
    });
    expect(stepResultActivityCount(db, first.id)).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "activity.changed" &&
          (event.payload as { stepRunId?: string }).stepRunId === first.id
      )
    ).toHaveLength(1);
  });

  it("failStep persists daemon evaluation-failed step result", () => {
    const { db, events, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const first = getStep(db, run.currentStepRunId!)!;

    failStep(db, () => NOW, first.id, { activityCtx: runCtx });

    expect(readStepResultJson(db, first.id)).toMatchObject({
      stepId: first.id,
      stepStatus: "failed",
      evaluationStatus: "failed",
      successScore: 0,
      outcome: {
        reason: "step result evaluation failed: orchestrator scoring not supplied",
        blockingIssuesCount: 1,
        handoffReady: false,
      },
    });
    expect(stepResultActivityCount(db, first.id)).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "activity.changed" &&
          (event.payload as { stepRunId?: string }).stepRunId === first.id
      )
    ).toHaveLength(1);
  });

  it("step fingerprint uses sha256(run:step:attempt)", () => {
    const actual = stepFingerprint("run-1", "intake", 2);
    const expected = createHash("sha256").update("run-1:intake:2").digest("hex");
    expect(actual).toBe(expected);
  });

  it("sets the node cursor when the initial step is created", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    // startWorkflowRun calls createInitialStep internally; verify cursor was set
    const row = db
      .prepare("SELECT current_node_id, current_node_kind FROM workflow_runs WHERE id = ?")
      .get(run.id) as { current_node_id: string | null; current_node_kind: string | null };
    expect(row.current_node_kind).toBe("step");
    expect(row.current_node_id).toBeTruthy();
  });

  it("computes the next attempt as max(existing) + 1 for a revisited step", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-1");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-1", templateId: ENGINEERING_ID });
    const firstStep = getStep(db, run.currentStepRunId!)!;
    const stepTemplateId = firstStep.step_template_id;

    // Insert another attempt for the same step
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', '[]', NULL, ?, NULL, ?)"
    ).run(
      "step-attempt-2",
      "goal-1",
      run.id,
      stepTemplateId,
      firstStep.ordinal,
      2,
      NOW,
      stepFingerprint(run.id, stepTemplateId, 2)
    );

    const nextAttempt = nextAttemptForStep(db, run.id, stepTemplateId);
    expect(nextAttempt).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Graph-routing tests
// ---------------------------------------------------------------------------

const GRAPH_TEMPLATE_ID = "test/graph-template";
const AGENT_PREF = [{ adapterId: "claude-code", modelId: "claude-sonnet-4-6" }];

/**
 * Minimal steps + graph: analysis(0) -> execution(1) -> validation(2, terminal)
 */
const STEP_OUTPUT = [{ key: "summary", type: "string", required: true }];
const GRAPH_STEPS = JSON.stringify([
  { id: "analysis", ordinal: 0, name: "Analysis", instructions: "analyse", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
  { id: "execution", ordinal: 1, name: "Execution", instructions: "execute", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
  { id: "validation", ordinal: 2, name: "Validation", instructions: "validate", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
]);
const GRAPH_JSON = JSON.stringify({
  nodes: [
    { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution" },
    { id: "validation", type: "step", name: "Validation", stepId: "validation", terminal: true },
  ],
  edges: [
    { from: "analysis", to: "execution" },
    { from: "execution", to: "validation" },
  ],
  positions: { analysis: { x: 0, y: 0 }, execution: { x: 0, y: 92 }, validation: { x: 0, y: 184 } },
});

/**
 * Steps + graph with a gate after execution: execution(0) -> gate -> validation(1, terminal)
 */
const GATE_STEPS = JSON.stringify([
  { id: "execution", ordinal: 0, name: "Execution", instructions: "execute", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
  { id: "validation", ordinal: 1, name: "Validation", instructions: "validate", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
]);
const GATE_GRAPH_JSON = JSON.stringify({
  nodes: [
    { id: "execution", type: "step", name: "Execution", stepId: "execution" },
    { id: "quality-gate", type: "gate", name: "Quality Gate", instructions: "approve if ready" },
    { id: "validation", type: "step", name: "Validation", stepId: "validation", terminal: true },
  ],
  edges: [
    { from: "execution", to: "quality-gate" },
    { from: "quality-gate", to: "validation", port: "approved" },
    { from: "quality-gate", to: "execution", port: "rejected" },
  ],
  positions: {
    execution: { x: 0, y: 0 },
    "quality-gate": { x: 0, y: 92 },
    validation: { x: 0, y: 184 },
  },
});

function seedGraphTemplate(db: Database.Database, id: string, stepsJson: string, graphJson: string): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0, ?, '[]', ?, ?, ?)"
  ).run(id, "Test Graph Template", "desc", stepsJson, graphJson, NOW, NOW);
}

function seedRunWithGraph(db: Database.Database, runCtx: WorkflowRunUsecaseCtx): ReturnType<typeof startWorkflowRun> {
  seedGoal(db, "goal-graph");
  seedGraphTemplate(db, GRAPH_TEMPLATE_ID, GRAPH_STEPS, GRAPH_JSON);
  return startWorkflowRun(runCtx, { goalId: "goal-graph", templateId: GRAPH_TEMPLATE_ID });
}

const GATE_TEMPLATE_ID = "test/gate-template";

function seedRunAtExecutionStep(db: Database.Database, runCtx: WorkflowRunUsecaseCtx): ReturnType<typeof startWorkflowRun> {
  seedGoal(db, "goal-gate");
  seedGraphTemplate(db, GATE_TEMPLATE_ID, GATE_STEPS, GATE_GRAPH_JSON);
  return startWorkflowRun(runCtx, { goalId: "goal-gate", templateId: GATE_TEMPLATE_ID });
}

describe("graph-routed step advancement", () => {
  it("advances to the graphed next step rather than the next ordinal", () => {
    const { db, runCtx } = setup();
    const run = seedRunWithGraph(db, runCtx);
    expect(run.currentStepRunId).toBeTruthy();
    // Current step is 'analysis'; graph routes analysis -> execution
    const next = advanceToNextStep(db, () => NOW, run.currentStepRunId!);
    expect(next).not.toBeNull();
    expect(next!.stepTemplateId).toBe("execution");
  });

  it("returns a gate sentinel when the next node is a gate", () => {
    const { db, runCtx } = setup();
    const run = seedRunAtExecutionStep(db, runCtx);
    expect(run.currentStepRunId).toBeTruthy();
    // Current step is 'execution'; graph routes execution -> quality-gate
    const result = advanceToNextStepOrGate(db, () => NOW, run.currentStepRunId!);
    expect(result).toEqual({ kind: "gate", nodeId: "quality-gate" });
  });

  it("does not complete the run on a terminal step; returns completed-terminal", () => {
    const { db, runCtx } = setup();
    const run = seedRunWithGraph(db, runCtx);
    // Advance analysis -> execution
    const step2 = advanceToNextStep(db, () => NOW, run.currentStepRunId!)!;
    expect(step2.stepTemplateId).toBe("execution");
    // Advance execution -> validation
    const step3 = advanceToNextStep(db, () => NOW, step2.id)!;
    expect(step3.stepTemplateId).toBe("validation");
    // Advance validation -> terminal: the run yields for user approval, it does NOT auto-complete.
    const result = advanceToNextStepOrGate(db, () => NOW, step3.id);
    expect(result.kind).toBe("completed-terminal");
    const after = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(run.id) as { status: string };
    expect(after.status).toBe("active");
  });

  it("legacy advanceToNextStep maps a terminal step to null without completing the run", () => {
    const { db, runCtx } = setup();
    const run = seedRunWithGraph(db, runCtx);
    const step2 = advanceToNextStep(db, () => NOW, run.currentStepRunId!)!;
    const step3 = advanceToNextStep(db, () => NOW, step2.id)!;
    // Advance validation -> terminal via the legacy wrapper.
    expect(advanceToNextStep(db, () => NOW, step3.id)).toBeNull();
    const after = db.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(run.id) as { status: string };
    expect(after.status).toBe("active");
  });

  it("gate sentinel parks cursor on gate node", () => {
    const { db, runCtx } = setup();
    const run = seedRunAtExecutionStep(db, runCtx);
    advanceToNextStepOrGate(db, () => NOW, run.currentStepRunId!);
    const row = db
      .prepare("SELECT current_node_id, current_node_kind, current_step_run_id FROM workflow_runs WHERE id = ?")
      .get(run.id) as { current_node_id: string | null; current_node_kind: string | null; current_step_run_id: string | null };
    expect(row.current_node_id).toBe("quality-gate");
    expect(row.current_node_kind).toBe("gate");
    expect(row.current_step_run_id).toBeNull();
  });

  it("null graph still advances linearly (ordinal-based fallback via effectiveGraph)", () => {
    const { db, runCtx } = setup();
    seedGoal(db, "goal-linear");
    seedEngineeringTemplate(db, () => NOW);
    const run = startWorkflowRun(runCtx, { goalId: "goal-linear", templateId: ENGINEERING_ID });
    // Engineering template has no graph; effectiveGraph materializes linear; first step is 'intake' (ordinal 0)
    const next = advanceToNextStep(db, () => NOW, run.currentStepRunId!);
    // Next ordinal=1 is 'research'
    expect(next!.stepTemplateId).toBe("research");
  });

  // ---------------------------------------------------------------------------
  // Splitter node routing
  // ---------------------------------------------------------------------------

  const SPLITTER_TEMPLATE_ID = "test/splitter-template";
  const SPLITTER_STEPS = JSON.stringify([
    { id: "triage", ordinal: 0, name: "Triage", instructions: "triage", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
    { id: "a", ordinal: 1, name: "A", instructions: "do a", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
    { id: "b", ordinal: 2, name: "B", instructions: "do b", outputSchema: STEP_OUTPUT, agentPreference: AGENT_PREF },
  ]);
  const SPLITTER_GRAPH_JSON = JSON.stringify({
    nodes: [
      { id: "triage", type: "step", name: "Triage", stepId: "triage" },
      { id: "route", type: "splitter", name: "Route", instructions: "pick", branches: ["go_a", "go_b"] },
      { id: "a", type: "step", name: "A", stepId: "a" },
      { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
    ],
    edges: [
      { from: "triage", to: "route" },
      { from: "route", to: "a", port: "go_a" },
      { from: "route", to: "b", port: "go_b" },
      { from: "a", to: "b" },
    ],
    positions: { triage: { x: 0, y: 0 }, route: { x: 0, y: 92 }, a: { x: -100, y: 184 }, b: { x: 100, y: 184 } },
  });

  function seedRunAtTriageStep(db: Database.Database, runCtx: WorkflowRunUsecaseCtx): ReturnType<typeof startWorkflowRun> {
    seedGoal(db, "goal-splitter");
    seedGraphTemplate(db, SPLITTER_TEMPLATE_ID, SPLITTER_STEPS, SPLITTER_GRAPH_JSON);
    return startWorkflowRun(runCtx, { goalId: "goal-splitter", templateId: SPLITTER_TEMPLATE_ID });
  }

  it("advances a step into a splitter node, parking the cursor", () => {
    const { db, runCtx } = setup();
    // triage -> route (splitter with branches go_a, go_b) -> a, b -> terminal
    const run = seedRunAtTriageStep(db, runCtx);
    expect(run.currentStepRunId).toBeTruthy();
    // Current step is 'triage'; graph routes triage -> route (splitter)
    const result = advanceToNextStepOrGate(db, () => "2026-06-22T00:00:01.000Z", run.currentStepRunId!);
    expect(result).toEqual({ kind: "splitter", nodeId: "route" });
    const row = db
      .prepare("SELECT current_node_id, current_node_kind, current_step_run_id FROM workflow_runs WHERE id = ?")
      .get(run.id) as { current_node_id: string | null; current_node_kind: string | null; current_step_run_id: string | null };
    expect(row).toMatchObject({ current_node_id: "route", current_node_kind: "splitter", current_step_run_id: null });
  });
});
