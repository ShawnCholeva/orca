import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type {
  DomainEvent,
  OperatorSelection,
  WorkflowGuardrailConfig,
  WorkflowStepTemplate,
} from "@orca/contracts";
import { NextOrchestratorDecisionResponse } from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { createDaemonContext } from "../../daemon-context.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { createServer } from "../../server.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import type { OperatorSelector, SelectorInput } from "../operators/selector.js";
import { OrchestratorService } from "./service.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;

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
    getAuthToken: () => "test-token",
  };
}

function setup(): {
  db: Database.Database;
  events: DomainEvent[];
  bus: EventBus;
  idFactory: () => string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-orchestrator-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const bus = new EventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let nextId = 0;
  return {
    db,
    events,
    bus,
    idFactory: () => `fixed-id-${++nextId}`,
  };
}

function seedGoal(db: Database.Database, id = "goal-1"): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run(id, NOW, NOW);
}

function step(patch: Partial<WorkflowStepTemplate> = {}): WorkflowStepTemplate {
  return {
    id: "execution",
    ordinal: 0,
    name: "Execution",
    purpose: "Implement approved work",
    requiredInputs: [],
    requiredOutputs: ["implementation_result"],
    gateType: "automated",
    recommendedCapabilities: ["implementation", "code_editing"],
    validationExpectations: [],
    exitCriteria: ["implemented"],
    recommendedOperatorIds: ["agent:codex"],
    ...patch,
  };
}

function seedWorkflow(
  db: Database.Database,
  args: {
    steps?: WorkflowStepTemplate[];
    guardrails?: WorkflowGuardrailConfig[];
    currentStep?: WorkflowStepTemplate;
    outstanding?: string[];
    stepStatus?: string;
    goalId?: string;
  } = {}
): void {
  const current = args.currentStep ?? step();
  const steps = args.steps ?? [
    current,
    step({
      id: "qa",
      ordinal: 1,
      name: "QA",
      purpose: "Check implementation",
      requiredInputs: ["implementation_result"],
      requiredOutputs: ["qa_report"],
      recommendedCapabilities: ["qa"],
      recommendedOperatorIds: ["human"],
      exitCriteria: ["qa complete"],
    }),
  ];
  const goalId = args.goalId ?? "goal-1";
  seedGoal(db, goalId);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, ?, ?, ?)"
  ).run(JSON.stringify(steps), JSON.stringify(args.guardrails ?? []), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', ?, 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(goalId, NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', ?, 'run-1', ?, ?, 1, ?, '[]', ?, NULL, ?, NULL, 'fp-1')"
  ).run(
    goalId,
    current.id,
    current.ordinal,
    args.stepStatus ?? "active",
    JSON.stringify(args.outstanding ?? ["implemented"]),
    NOW
  );
}

function selection(operatorId = "agent:codex"): OperatorSelection {
  return {
    operatorId,
    operatorKind: operatorId === "human" ? "human" : "agent",
    reason: "best capability match",
    requiredCapabilities: ["implementation"],
    alternativesConsidered: ["human"],
    confidence: 0.8,
    requiresUserApproval: true,
  };
}

function fakeSelector(result: OperatorSelection, seen: SelectorInput[] = []): Pick<OperatorSelector, "select"> {
  return {
    async select(_db, _now, input) {
      seen.push(input);
      return { selection: result, source: "fallback" };
    },
  };
}

function recommendationRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT id, type, status, workflow_step_run_id, proposed_action_json FROM recommendations ORDER BY created_at ASC"
    )
    .all() as Array<Record<string, unknown>>;
}

afterEach(async () => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OrchestratorService", () => {
  it("records request_artifact when required inputs are missing", async () => {
    const { db, bus, events, idFactory } = setup();
    seedWorkflow(db, {
      currentStep: step({ requiredInputs: ["goal_brief"] }),
    });
    const service = new OrchestratorService(fakeSelector(selection()));

    const result = await service.requestNextDecision(db, () => NOW, "run-1", {
      bus,
      idFactory,
    });

    expect(result.recommendationIds).toEqual([]);
    expect(result.decision.decisionType).toBe("request_artifact");
    expect(result.decision.influencedBy).toEqual([
      { kind: "artifact", id: "goal_brief", label: "goal_brief", effect: "missing" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "workflow.decision.requested",
      "workflow.decision.recorded",
    ]);
    const decisionCount = db
      .prepare("SELECT COUNT(*) AS count FROM workflow_decisions")
      .get() as { count: number };
    expect(decisionCount.count).toBe(1);
  });

  it("selects an operator and creates a launch recommendation when criteria remain outstanding", async () => {
    const { db, bus, events, idFactory } = setup();
    const seen: SelectorInput[] = [];
    seedWorkflow(db);
    const service = new OrchestratorService(fakeSelector(selection(), seen));

    const result = await service.requestNextDecision(db, () => NOW, "run-1", {
      bus,
      idFactory,
    });

    expect(seen).toHaveLength(1);
    expect(result.decision.decisionType).toBe("select_operator");
    expect(result.decision.operatorSelectionJson?.operatorId).toBe("agent:codex");
    expect(result.recommendationIds).toHaveLength(1);
    expect(recommendationRows(db)).toMatchObject([
      {
        id: result.recommendationIds[0],
        type: "launch_workflow_session",
        status: "proposed",
        workflow_step_run_id: "step-1",
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "workflow.decision.requested",
      "workflow.decision.recorded",
      "workflow.operator.selected",
      "workflow.recommendation.created",
    ]);
  });

  it("creates an advance recommendation for satisfied exit criteria without mutating the run", async () => {
    const { db, bus, idFactory } = setup();
    seedWorkflow(db, { outstanding: [] });
    const service = new OrchestratorService(fakeSelector(selection()));

    const result = await service.requestNextDecision(db, () => NOW, "run-1", {
      bus,
      idFactory,
    });

    expect(result.decision.decisionType).toBe("advance_step");
    expect(result.recommendationIds).toHaveLength(1);
    const rec = recommendationRows(db)[0]!;
    expect(rec.type).toBe("advance_workflow_step");
    expect(JSON.parse(rec.proposed_action_json as string)).toEqual({
      kind: "advance_workflow_step",
      workflowRunId: "run-1",
      workflowStepRunId: "step-1",
      toStepTemplateId: "qa",
    });
    const run = db
      .prepare("SELECT current_step_run_id, status FROM workflow_runs WHERE id = 'run-1'")
      .get() as { current_step_run_id: string; status: string };
    const stepRow = db
      .prepare("SELECT status FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { status: string };
    expect(run).toEqual({ current_step_run_id: "step-1", status: "active" });
    expect(stepRow.status).toBe("active");
  });

  it("blocks the step when guardrails deny the selected operator", async () => {
    const { db, bus, events, idFactory } = setup();
    seedWorkflow(db, {
      guardrails: [
        {
          id: "allowed-human",
          kind: "allowed_operators",
          label: "Allowed operators",
          configJson: { allowed: ["human"] },
        },
      ],
    });
    const service = new OrchestratorService(fakeSelector(selection("agent:codex")));

    const result = await service.requestNextDecision(db, () => NOW, "run-1", {
      bus,
      idFactory,
    });

    expect(result.decision.decisionType).toBe("block_run");
    expect(result.recommendationIds).toEqual([]);
    const stepRow = db
      .prepare("SELECT status, blocked_reason FROM workflow_step_runs WHERE id = 'step-1'")
      .get() as { status: string; blocked_reason: string };
    expect(stepRow.status).toBe("blocked");
    expect(stepRow.blocked_reason).toContain("allowed-human");
    const guardrailRows = db
      .prepare("SELECT decision_id, result FROM workflow_guardrail_evaluations")
      .all() as Array<{ decision_id: string; result: string }>;
    expect(guardrailRows).toEqual([
      { decision_id: result.decision.decisionId, result: "deny" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "workflow.decision.requested",
      "workflow.decision.recorded",
      "workflow.guardrail.evaluated",
      "workflow.step.blocked",
    ]);
  });

  it("returns a user-input recommendation for human input gates", async () => {
    const { db, bus, idFactory } = setup();
    seedWorkflow(db, {
      currentStep: step({
        gateType: "human-input",
        purpose: "Answer the intake question",
        recommendedCapabilities: [],
        recommendedOperatorIds: [],
      }),
    });
    const service = new OrchestratorService(fakeSelector(selection()));

    const result = await service.requestNextDecision(db, () => NOW, "run-1", {
      bus,
      idFactory,
    });

    expect(result.decision.decisionType).toBe("request_user_input");
    expect(recommendationRows(db)[0]).toMatchObject({
      type: "request_user_input",
      workflow_step_run_id: "step-1",
    });
  });
});

describe("orchestrator routes", () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns 404 when the workflow run belongs to another goal", async () => {
    const { db, idFactory } = setup();
    seedWorkflow(db, { goalId: "goal-1" });
    const bus = new EventBus();
    const context = createDaemonContext(db, bus);
    server = createServer(createConfig(tempDirs[tempDirs.length - 1]!), {
      daemonContext: {
        ...context,
        operatorSelector: fakeSelector(selection()) as OperatorSelector,
        now: () => NOW,
        idFactory,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/goals/other-goal/workflow-runs/run-1/next-decision",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { workflowRunId: "run-1" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the next decision response for the owning goal", async () => {
    const { db, idFactory } = setup();
    seedWorkflow(db, { outstanding: [] });
    const bus = new EventBus();
    const context = createDaemonContext(db, bus);
    server = createServer(createConfig(tempDirs[tempDirs.length - 1]!), {
      daemonContext: {
        ...context,
        operatorSelector: fakeSelector(selection()) as OperatorSelector,
        now: () => NOW,
        idFactory,
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/v1/goals/goal-1/workflow-runs/run-1/next-decision",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { workflowRunId: "run-1" },
    });

    expect(response.statusCode).toBe(200);
    const body = NextOrchestratorDecisionResponse.parse(JSON.parse(response.body));
    expect(body.decision.decisionType).toBe("advance_step");
    expect(body.recommendationIds).toHaveLength(1);
  });
});
