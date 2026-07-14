import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { DomainEvent, WorkflowGuardrailConfig } from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import {
  evaluateAllGuardrails,
  evaluateAllGuardrailsInTx,
  evaluateGuardrail,
  evaluateGuardrailRequiresApproval,
  type GuardrailContext,
} from "./evaluator.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-guardrails-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  seedGoal(db, "goal-1");
  seedTemplate(db);
  seedWorkflowRun(db, "goal-1", "run-1");
  seedStepRun(db, "goal-1", "run-1", "step-1");
  return db;
}

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)"
  ).run(id, "Goal", "Goal desc", NOW, NOW);
}

function seedTemplate(db: Database.Database): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
}

function seedWorkflowRun(db: Database.Database, goalId: string, runId: string): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, 'orca/engineering', 1, 'active', NULL, NULL, ?, NULL)"
  ).run(runId, goalId, NOW);
}

function seedStepRun(
  db: Database.Database,
  goalId: string,
  runId: string,
  stepId: string
): void {
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES (?, ?, ?, 'execution', 4, 1, 'active', '[]', '[\"done\"]', NULL, ?, NULL, 'fp-1')"
  ).run(stepId, goalId, runId, NOW);
  db.prepare("UPDATE workflow_runs SET current_step_run_id = ? WHERE id = ?").run(
    stepId,
    runId
  );
}

function seedDecision(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO workflow_decisions (id, goal_id, workflow_run_id, step_run_id, decision_type, selected_action, reason, influenced_by_json, alternatives_considered_json, confidence, operator_selection_json, input_fingerprint, created_at) VALUES (?, 'goal-1', 'run-1', 'step-1', 'evaluate_guardrail', 'evaluate', 'reason', '[]', '[]', NULL, NULL, 'fp-1', ?)"
  ).run(id, NOW);
}

function guardrail(
  kind: WorkflowGuardrailConfig["kind"],
  configJson: unknown,
  id: string = kind
): WorkflowGuardrailConfig {
  return {
    id,
    kind,
    label: id,
    configJson,
  };
}

function baseContext(
  candidateAction: GuardrailContext["candidateAction"]
): GuardrailContext {
  return {
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepTemplateId: "execution",
    candidateAction,
  };
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow guardrail evaluator", () => {
  it("approval_required matches configured action set", () => {
    const result = evaluateGuardrail(
      guardrail("approval_required", { actions: ["advance_step"] }),
      baseContext({ kind: "advance_step" })
    );

    expect(result).toEqual({
      guardrailId: "approval_required",
      kind: "approval_required",
      result: "require_approval",
    });

    expect(
      evaluateGuardrail(
        guardrail("approval_required", { actions: ["mark_run_complete"] }),
        baseContext({ kind: "advance_step" })
      ).result
    ).toBe("allow");
  });

  it("allowed_operators denies unlisted selected or launched operators", () => {
    expect(
      evaluateGuardrail(
        guardrail("allowed_operators", { allowed: ["human"] }),
        baseContext({ kind: "select_operator", operatorId: "codex" })
      )
    ).toMatchObject({ result: "deny", message: "operator codex not allowed" });

    expect(
      evaluateGuardrail(
        guardrail("allowed_operators", { allowed: ["codex"] }),
        baseContext({ kind: "launch_workflow_session", operatorId: "codex" })
      ).result
    ).toBe("allow");
  });

  it("validation_rule requires approval on validation skip for matching steps", () => {
    const result = evaluateGuardrail(
      guardrail("validation_rule", {
        appliesToSteps: ["execution"],
        required: ["test_report"],
      }),
      baseContext({ kind: "skip_validation" })
    );

    expect(result).toMatchObject({
      result: "require_approval",
      message: "validation skip requires explicit reason",
    });

    expect(
      evaluateGuardrail(
        guardrail("validation_rule", { appliesToSteps: ["review"] }),
        baseContext({ kind: "skip_validation" })
      ).result
    ).toBe("allow");
  });

  it("context_rule denies raw terminal output by default", () => {
    expect(
      evaluateGuardrail(
        guardrail("context_rule", { allowRawTerminalOutput: false }),
        baseContext({ kind: "use_raw_terminal_output" })
      )
    ).toMatchObject({ result: "deny", message: "raw terminal output not allowed" });

    expect(
      evaluateGuardrail(
        guardrail("context_rule", { allowRawTerminalOutput: true }),
        baseContext({ kind: "use_raw_terminal_output" })
      ).result
    ).toBe("allow");
  });

  it("concurrency_rule denies launch when active executions reach the limit", () => {
    const ctx = {
      ...baseContext({ kind: "launch_workflow_session", operatorId: "codex" }),
      activeExecutionCount: 2,
    };

    expect(
      evaluateGuardrail(
        guardrail("concurrency_rule", { maxConcurrentExecution: 2 }),
        ctx
      )
    ).toMatchObject({ result: "deny", message: "execution concurrency limit reached" });

    expect(
      evaluateGuardrail(
        guardrail("concurrency_rule", { maxConcurrentExecution: 3 }),
        ctx
      ).result
    ).toBe("allow");
  });

  it("budget_rule denies launch when scoped spend reaches the cap", () => {
    const overCtx = {
      ...baseContext({ kind: "launch_workflow_session", operatorId: "codex" }),
      budgetSpentUsd: 1.5,
    };
    expect(
      evaluateGuardrail(guardrail("budget_rule", { maxUsd: 1.0 }), overCtx)
    ).toMatchObject({ result: "deny" });

    const underCtx = {
      ...baseContext({ kind: "launch_workflow_session", operatorId: "codex" }),
      budgetSpentUsd: 0.5,
    };
    expect(
      evaluateGuardrail(guardrail("budget_rule", { maxUsd: 1.0 }), underCtx).result
    ).toBe("allow");
  });

  it("budget_rule allows when no spend signal is supplied (generic pass is a no-op)", () => {
    expect(
      evaluateGuardrail(
        guardrail("budget_rule", { maxUsd: 1.0 }),
        baseContext({ kind: "launch_workflow_session", operatorId: "codex" })
      ).result
    ).toBe("allow");
  });

  it("risk_rule requires approval for matched risk labels", () => {
    const ctx = {
      ...baseContext({ kind: "advance_step" }),
      riskLabels: ["destructive", "database"],
    };

    expect(
      evaluateGuardrail(guardrail("risk_rule", { escalateOn: ["database"] }), ctx)
    ).toMatchObject({ result: "require_approval", message: "risk rule requires approval" });

    expect(
      evaluateGuardrail(guardrail("risk_rule", { escalateOn: ["network"] }), ctx)
        .result
    ).toBe("allow");
  });

  it("cost_speed_preference remains allow and records decision-influence hint text", () => {
    expect(
      evaluateGuardrail(
        guardrail("cost_speed_preference", { prefer: "fast" }),
        baseContext({ kind: "select_operator", operatorId: "codex" })
      )
    ).toMatchObject({
      result: "allow",
      message: "cost/speed preference applies to operator ranking",
    });
  });

  it("writes one evaluation row and one content-free event per guardrail", () => {
    const db = setup();
    seedDecision(db, "decision-1");
    const ids = ["eval-1", "event-1", "eval-2", "event-2"];
    const results = evaluateAllGuardrails(
      db,
      () => NOW,
      [
        guardrail("approval_required", { actions: ["advance_step"] }, "approval"),
        guardrail("allowed_operators", { allowed: ["human"] }, "operators"),
      ],
      baseContext({ kind: "select_operator", operatorId: "codex" }),
      "decision-1",
      { idFactory: () => ids.shift() ?? "extra-id" }
    );

    expect(results.map((result) => result.result)).toEqual(["allow", "deny"]);

    const rows = db
      .prepare(
        "SELECT id, guardrail_id, guardrail_kind, decision_id, result, message FROM workflow_guardrail_evaluations ORDER BY created_at ASC, id ASC"
      )
      .all() as Array<{
      id: string;
      guardrail_id: string;
      guardrail_kind: string;
      decision_id: string | null;
      result: string;
      message: string | null;
    }>;
    expect(rows).toEqual([
      {
        id: "eval-1",
        guardrail_id: "approval",
        guardrail_kind: "approval_required",
        decision_id: "decision-1",
        result: "allow",
        message: null,
      },
      {
        id: "eval-2",
        guardrail_id: "operators",
        guardrail_kind: "allowed_operators",
        decision_id: "decision-1",
        result: "deny",
        message: "operator codex not allowed",
      },
    ]);

    const events = db
      .prepare("SELECT type, goal_id, payload FROM events ORDER BY seq ASC")
      .all() as Array<{ type: string; goal_id: string | null; payload: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "workflow.guardrail.evaluated",
      "workflow.guardrail.evaluated",
    ]);
    expect(events[1]?.goal_id).toBe("goal-1");
    const payload = JSON.parse(events[1]!.payload) as Record<string, unknown>;
    expect(payload).toEqual({
      guardrailEvaluationId: "eval-2",
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      guardrailId: "operators",
      guardrailKind: "allowed_operators",
      result: "deny",
    });
    expect(payload).not.toHaveProperty("message");
    expect(Buffer.byteLength(events[1]!.payload, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("redacts and caps persisted messages without adding them to events", () => {
    const db = setup();
    const operatorId = `codex password=${"x".repeat(400)}`;
    evaluateAllGuardrails(
      db,
      () => NOW,
      [guardrail("allowed_operators", { allowed: ["human"] }, "operators")],
      baseContext({ kind: "select_operator", operatorId }),
      null,
      { idFactory: (() => {
        const ids = ["eval-1", "event-1"];
        return () => ids.shift() ?? "extra-id";
      })() }
    );

    const row = db
      .prepare("SELECT message FROM workflow_guardrail_evaluations WHERE id = 'eval-1'")
      .get() as { message: string };
    expect(row.message).toContain("password=[redacted]");
    expect(row.message.length).toBeLessThanOrEqual(256);

    const event = db.prepare("SELECT payload FROM events").get() as { payload: string };
    expect(event.payload).not.toContain("password");
    expect(event.payload).not.toContain("redacted");
  });

  it("internal helper participates in caller transaction and stages events", () => {
    const db = setup();
    const stagedEvents: DomainEvent[] = [];
    const ids = ["eval-1", "event-1"];

    const results = db.transaction(() =>
      evaluateAllGuardrailsInTx(
        db,
        () => NOW,
        [guardrail("risk_rule", { escalateOn: ["secret"] }, "risk")],
        {
          ...baseContext({ kind: "advance_step" }),
          riskLabels: ["secret"],
        },
        null,
        { stagedEvents, idFactory: () => ids.shift() ?? "extra-id" }
      )
    )();

    expect(results).toHaveLength(1);
    expect(stagedEvents).toHaveLength(1);
    expect(stagedEvents[0]?.type).toBe("workflow.guardrail.evaluated");
    expect(
      (db.prepare("SELECT count(*) AS c FROM workflow_guardrail_evaluations").get() as { c: number }).c
    ).toBe(1);
  });

  it("public helper publishes staged events only after commit", () => {
    const db = setup();
    const bus = new EventBus();
    const publishObservations: number[] = [];
    const ids = ["eval-1", "event-1"];
    bus.subscribe(() => {
      publishObservations.push(
        (db.prepare("SELECT count(*) AS c FROM workflow_guardrail_evaluations").get() as { c: number }).c
      );
    });

    evaluateAllGuardrails(
      db,
      () => NOW,
      [guardrail("context_rule", { allowRawTerminalOutput: false }, "context")],
      baseContext({ kind: "use_raw_terminal_output" }),
      null,
      { bus, idFactory: () => ids.shift() ?? "extra-id" }
    );

    expect(publishObservations).toEqual([1]);
  });
});

const validationGuardrail: WorkflowGuardrailConfig = {
  id: "validation_required",
  kind: "validation_rule",
  label: "Require tests/typecheck",
  configJson: { appliesToSteps: ["execution"], required: ["unit_tests", "typecheck"] },
};

describe("validation_rule advance_with_failing_checks", () => {
  it("requires approval to advance a covered step with failing checks", () => {
    const result = evaluateGuardrailRequiresApproval([validationGuardrail], {
      goalId: "g", workflowRunId: "r", stepRunId: "s", stepTemplateId: "execution",
      candidateAction: { kind: "advance_with_failing_checks" },
    });
    expect(result).toBe("require_approval");
  });

  it("allows advancing an uncovered step", () => {
    const result = evaluateGuardrailRequiresApproval([validationGuardrail], {
      goalId: "g", workflowRunId: "r", stepRunId: "s", stepTemplateId: "research",
      candidateAction: { kind: "advance_with_failing_checks" },
    });
    expect(result).toBe("allow");
  });
});
