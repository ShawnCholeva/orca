import type Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import type { OperatorDescriptor } from "@orca/contracts";
import type { WorkflowSessionLauncher } from "./session-launcher.js";
import { OrchestratorService } from "./service.js";
import { DispatchEngine } from "./dispatch-engine.js";
import {
  cleanupHarness,
  NOW,
  setupHarness,
  fakeStepDispatch,
} from "./skill-step-test-helpers.js";
import type {
  BrokerCompatibilityOptions,
  OrchestrationTransportBroker,
} from "../orchestration-transport/broker.js";
import type { OrchestratorMediator } from "../../orchestrator-llm/mediator.js";
import type { OrchestratorAction } from "@orca/contracts";
import type { ShadowAsk } from "./recover-step-scoring.js";
import {
  listTransitionsByGoal,
  resetPreparedStatements as resetHarnessTransitionStmts,
} from "../../harness-transitions/usecases.js";

const AGENT_OPERATOR_ID = "agent:claude-code";

function agentOperatorDescriptor(): OperatorDescriptor {
  return {
    id: AGENT_OPERATOR_ID,
    kind: "agent",
    displayName: "Claude Code",
    capabilities: ["repo_navigation", "code_editing"],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  };
}

function fakeBrokerNoop(): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose(_request: unknown, options?: BrokerCompatibilityOptions) {
      const proposal = {};
      const validated = options?.validateProposal
        ? await options.validateProposal(proposal)
        : { accepted: true as const, parsed: proposal };
      return {
        status: "proposed" as const,
        attemptId: "attempt-1",
        transport: "one_shot" as const,
        parsed: Object.prototype.hasOwnProperty.call(validated, "parsed")
          ? (validated as { parsed: unknown }).parsed
          : proposal,
        rawTextLength: null,
        latencyMs: 1,
      };
    },
  };
}

function makeLauncher(): WorkflowSessionLauncher {
  return { launch: vi.fn(async () => ({ sessionId: "sess-1" })) };
}

function fakeMediator(action: OrchestratorAction): Pick<OrchestratorMediator, "invoke"> {
  return { async invoke() { return action; } };
}

/** Seed a workflow with a single agent-capable step ("step-1") on an active run. */
function setupAgentStepRun(db: Database.Database, opts: { guardrailsJson?: string } = {}) {
  const step = {
    id: "implement",
    ordinal: 0,
    name: "Implement",
    instructions: "Write the implementation.",
    outputSchema: [{ key: "result", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  };

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run("goal-1", NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, ?, ?, ?)"
  ).run(JSON.stringify([step]), opts.guardrailsJson ?? "[]", NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);

  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-1', 'goal-1', 'run-1', ?, ?, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1', NULL, NULL, NULL, NULL)"
  ).run(step.id, step.ordinal, NOW);
}

/** Mark the active step run as agent-selected, with orchestrator_provider set so
 *  resolveShadowAdapterId(goal) resolves, and link a live session to it. */
function seedAgentSession(db: Database.Database) {
  db.prepare(
    "UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-haiku-4-5' WHERE id = 'goal-1'"
  ).run();
  db.prepare(
    "UPDATE workflow_step_runs SET selected_operator_id = 'agent:claude-code', selected_provider_id = NULL, selected_model_id = 'claude-haiku-4-5', operator_selected_at = ? WHERE id = 'step-1'"
  ).run(NOW);
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES ('sess-judge', 'goal-1', 'ws-1', 'claude-code', 'Session', 'running', ?, 'step-1')"
  ).run(NOW);
}

function seedWorkspace(db: Database.Database) {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("ws-1", "/tmp/repo", "main", "", NOW, NOW);
  db.prepare(
    `INSERT OR IGNORE INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run("goal-1", "ws-1", NOW);
}

const tempDirs: string[] = [];

/** Like seedWorkspace but points 'ws-1' at a real temp dir with a package.json
 *  whose `typecheck` script exits with `exitCode`, so runSensors executes it. */
function seedWorkspaceWithTypecheck(db: Database.Database, exitCode: 0 | 1): void {
  const dir = join(tmpdir(), `orca-refute-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "refute-fixture", scripts: { typecheck: `node -e "process.exit(${exitCode})"` } })
  );
  tempDirs.push(dir);
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, path, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run("ws-1", dir, "main", "", NOW, NOW);
  db.prepare(
    `INSERT OR IGNORE INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES (?, ?, ?)`
  ).run("goal-1", "ws-1", NOW);
}

/** Seed a `tool_gate` harness_transition carrying `risk_json.risk_class`, read
 *  by stepToolRiskClass. Mirrors refute-gate.test.ts's seedTx. */
function seedToolGate(db: Database.Database, stepRunId: string, riskClass: "low" | "medium" | "high" | "critical") {
  db.prepare(
    "INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(
    `tg-${Math.random()}`,
    "goal-1",
    "run-1",
    stepRunId,
    "tool_gate",
    JSON.stringify({
      risk_class: riskClass,
      permission_tier: "sandbox_edit",
      classification_reasons: [],
      gate_decision: "allow",
      hard_constraint_violations: [],
    }),
    NOW
  );
}

/** Fake ShadowAsk for the refute pass: returns a fixed tri-state verdict and
 *  records every session key it was asked with (independence assertions). */
function fakeRefuteAsk(
  verdict: "upheld" | "refuted" | "uncertain",
  opts: { reason?: string; issueRefs?: string[]; reasoning?: string } = {}
): ShadowAsk & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async ask(sessionKey: string) {
      calls.push(sessionKey);
      return {
        text: JSON.stringify({
          reasoning: opts.reasoning ?? "independent review of the step output",
          verdict,
          reason: opts.reason ?? "An independent reason.",
          issueRefs: opts.issueRefs ?? [],
          inputsConsidered: ["stepOutput"],
        }),
      };
    },
  };
}

function stepOutputCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM workflow_artifacts WHERE step_run_id = 'step-1' AND type = 'step_output'").get() as {
      c: number;
    }
  ).c;
}

function pendingCompletion(db: Database.Database): string | null {
  return (
    db.prepare("SELECT pending_completion_json FROM workflow_step_runs WHERE id = 'step-1'").get() as {
      pending_completion_json: string | null;
    }
  ).pending_completion_json;
}

function reviseAttempts(db: Database.Database): number {
  return (
    db.prepare("SELECT revise_attempts FROM workflow_step_runs WHERE id = 'step-1'").get() as { revise_attempts: number }
  ).revise_attempts;
}

const approveScoring = {
  reasoning: "output is complete and meets the step's instructions",
  successScore: 0.82,
  quality: {
    outputCompleteness: 0.8,
    outputCorrectness: 0.8,
    instructionAdherence: 0.85,
    downstreamReadiness: 0.8,
    riskLevel: 0.2,
  },
  reason: "Looks complete.",
  handoffReady: true,
};

function makeRefuteService(shadowAsk?: ShadowAsk): OrchestratorService {
  const broker = fakeBrokerNoop();
  const operators = { async list() { return [agentOperatorDescriptor()]; } };
  const engine = new DispatchEngine(broker, operators, makeLauncher(), fakeStepDispatch(), undefined, undefined, undefined);
  return new OrchestratorService(
    engine,
    broker,
    operators,
    undefined,
    fakeStepDispatch(),
    fakeMediator({ kind: "approve_step_complete", scoring: approveScoring }),
    vi.fn(async () => "delivered" as const),
    undefined,
    shadowAsk
  );
}

const responseText = "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";

/** Let the deferred revision flush (scheduled via setImmediate) run to completion. */
const flushDeferred = () =>
  new Promise<void>((resolve) => setImmediate(() => setImmediate(() => resolve())));

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  resetHarnessTransitionStmts();
  cleanupHarness();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OrchestratorService L5 refute gate", () => {
  it("high-risk refuted -> reviseStep (not committed); RefuteFacet + failure_code refute_veto recorded", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    seedToolGate(db, "step-1", "high");
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const ask = fakeRefuteAsk("refuted", {
      issueRefs: ["fix-x"],
      reason: "The output is wrong.",
      reasoning: "checked the diff against the spec; found a mismatch",
    });
    const service = makeRefuteService(ask);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );
    await flushDeferred();

    expect(stepOutputCount(db)).toBe(0);
    expect(reviseAttempts(db)).toBe(1);
    const t = listTransitionsByGoal(db, "goal-1").find((x) => x.boundary === "step_complete");
    expect(t?.refute).toMatchObject({
      verdict: "refuted",
      issue_refs: ["fix-x"],
      reasoning: "checked the diff against the spec; found a mismatch",
    });
    expect(t?.telemetry?.outcome).toMatchObject({ status: "failed", failure_code: "refute_veto" });
  });

  it("high-risk upheld -> commits; RefuteFacet verdict upheld, no veto", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    seedToolGate(db, "step-1", "high");
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const ask = fakeRefuteAsk("upheld");
    const service = makeRefuteService(ask);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    expect(stepOutputCount(db)).toBe(1);
    const t = listTransitionsByGoal(db, "goal-1").find(
      (x) => x.boundary === "step_complete" && x.workflowStepRunId === "step-1"
    );
    expect(t?.refute).toMatchObject({ verdict: "upheld" });
    expect(t?.telemetry?.outcome.failure_code).toBeNull();
  });

  it("uncertain -> human confirmation pause (not committed, not revised)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    seedToolGate(db, "step-1", "high");
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const ask = fakeRefuteAsk("uncertain");
    const service = makeRefuteService(ask);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    expect(stepOutputCount(db)).toBe(0);
    expect(reviseAttempts(db)).toBe(0);
    expect(pendingCompletion(db)).not.toBeNull();
    expect(JSON.parse(pendingCompletion(db)!)).toMatchObject({ refute: { verdict: "uncertain" } });
  });

  it("refute unavailable (ask throws) -> human pause (fail-safe, not auto-approved)", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" });
    seedWorkspace(db);
    seedAgentSession(db);
    seedToolGate(db, "step-1", "high");
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const throwingAsk: ShadowAsk = { async ask() { throw new Error("shadow down"); } };
    const service = makeRefuteService(throwingAsk);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );
    warnSpy.mockRestore();

    expect(stepOutputCount(db)).toBe(0);
    expect(reviseAttempts(db)).toBe(0);
    expect(pendingCompletion(db)).not.toBeNull();
    expect(JSON.parse(pendingCompletion(db)!)).toMatchObject({ refute: { verdict: "unavailable" } });
  });

  it("gate: adequately-verified low-risk exec step -> refute NOT called (0 ask calls); step commits", async () => {
    const { db, bus, idFactory } = setupHarness();
    const guardrailsJson = JSON.stringify([
      {
        id: "validation_required",
        kind: "validation_rule",
        label: "x",
        configJson: { appliesToSteps: ["implement"], required: ["typecheck"] },
      },
    ]);
    setupAgentStepRun(db, { guardrailsJson });
    seedWorkspaceWithTypecheck(db, 0); // sensors pass, no gaps
    seedAgentSession(db);
    // No tool_gate seeded -> low risk; sensors passed with no gaps -> gate skips.
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const ask = fakeRefuteAsk("upheld");
    const service = makeRefuteService(ask);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    expect(ask.calls).toHaveLength(0);
    expect(stepOutputCount(db)).toBe(1);
    const t = listTransitionsByGoal(db, "goal-1").find((x) => x.boundary === "step_complete");
    expect(t?.refute).toBeNull();
  });

  it("exec step whose sensors PASS reaches the refute: refuted rides the SINGLE gate emit as {failed, refute_veto}", async () => {
    const { db, bus, idFactory } = setupHarness();
    const guardrailsJson = JSON.stringify([
      {
        id: "validation_required",
        kind: "validation_rule",
        label: "x",
        configJson: { appliesToSteps: ["implement"], required: ["typecheck"] },
      },
    ]);
    setupAgentStepRun(db, { guardrailsJson });
    seedWorkspaceWithTypecheck(db, 0); // sensors pass -> step reaches the refute
    seedAgentSession(db);
    seedToolGate(db, "step-1", "high");
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const ask = fakeRefuteAsk("refuted", { issueRefs: ["fix-y"], reason: "Semantically wrong." });
    const service = makeRefuteService(ask);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );
    await flushDeferred();

    // Did NOT advance/commit; a revise was taken.
    expect(stepOutputCount(db)).toBe(0);
    expect(reviseAttempts(db)).toBe(1);

    // Exactly ONE step_complete transition for the step, and it carries BOTH the
    // evidence (passed) and the refute (refuted) facets, with a coherent failed
    // status + refute_veto failure code — not the self-contradictory
    // {succeeded, refute_veto} the pre-fix code emitted.
    const stepComplete = listTransitionsByGoal(db, "goal-1").filter(
      (t) => t.boundary === "step_complete" && t.workflowStepRunId === "step-1"
    );
    expect(stepComplete).toHaveLength(1);
    const t = stepComplete[0];
    expect(t.evidence?.verdict).toBe("passed");
    expect(t.refute).toMatchObject({ verdict: "refuted", issue_refs: ["fix-y"] });
    expect(t.telemetry?.outcome).toMatchObject({ status: "failed", failure_code: "refute_veto" });

    // The step is being revised because the refute vetoed it, so the workflow
    // event stream must NOT claim validation.passed (the sensors ran — validation.run
    // is present — but the step did not pass as a whole).
    const validationTypes = (
      db.prepare("SELECT type FROM events WHERE type LIKE 'workflow.validation%'").all() as { type: string }[]
    ).map((e) => e.type);
    expect(validationTypes).toContain("workflow.validation.run");
    expect(validationTypes).not.toContain("workflow.validation.passed");
  });

  it("degrades to no-refute (does not throw) when the step output is too large to fit the refute request", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" }); // non-exec -> no_oracle triggers the refute gate
    seedWorkspace(db);
    seedAgentSession(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    let askCalls = 0;
    const ask: ShadowAsk = {
      async ask() {
        askCalls += 1;
        return { text: JSON.stringify({ verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] }) };
      },
    };
    const service = makeRefuteService(ask);
    // A step-complete block whose serialized size blows the refute request payload
    // cap. Without the degrade, building the refute request throws FIRST
    // ("RefuteCompletionRequest too large") — a refute-introduced crash. With it, the
    // refute is skipped and control reaches the commit, where the same oversized
    // output legitimately trips the pre-existing artifact-body cap instead. So the
    // observable proof of the degrade is that the propagated error is the artifact
    // cap, not the refute request — and the refute was never asked.
    const oversized =
      "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "x".repeat(80000) }) + "\n```";

    await expect(
      service.onAgentResponseDone(
        db,
        () => NOW,
        { sessionId: "sess-judge", adapterId: "claude-code", responseText: oversized },
        { bus, idFactory }
      )
    ).rejects.toThrow("artifact_body_too_large");

    expect(askCalls).toBe(0); // refute request build degraded to no-op before the ask
  });

  it("gate: no-oracle step -> refute called with the independent '<goalId>::refute' session key", async () => {
    const { db, bus, idFactory } = setupHarness();
    setupAgentStepRun(db, { guardrailsJson: "[]" }); // non-exec: no oracle at all
    seedWorkspace(db);
    seedAgentSession(db);
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const ask = fakeRefuteAsk("upheld");
    const service = makeRefuteService(ask);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    expect(ask.calls).toEqual(["goal-1::refute"]);
    expect(ask.calls).not.toContain("goal-1");
  });

  it("a step already vetoed by the evidence gate never reaches the refute", async () => {
    const { db, bus, idFactory } = setupHarness();
    const guardrailsJson = JSON.stringify([
      {
        id: "validation_required",
        kind: "validation_rule",
        label: "x",
        configJson: { appliesToSteps: ["implement"], required: ["typecheck"] },
      },
    ]);
    setupAgentStepRun(db, { guardrailsJson });
    seedWorkspaceWithTypecheck(db, 1); // sensor fails -> evidence veto
    seedAgentSession(db);
    seedToolGate(db, "step-1", "critical"); // even high risk must not reach refute once vetoed
    db.prepare("UPDATE goals SET operating_mode = 'automated' WHERE id = 'goal-1'").run();

    const ask = fakeRefuteAsk("upheld");
    const service = makeRefuteService(ask);

    await service.onAgentResponseDone(
      db,
      () => NOW,
      { sessionId: "sess-judge", adapterId: "claude-code", responseText },
      { bus, idFactory }
    );

    expect(ask.calls).toHaveLength(0);
    expect(stepOutputCount(db)).toBe(0);
    const t = listTransitionsByGoal(db, "goal-1").find((x) => x.boundary === "step_complete");
    expect(t?.evidence?.verdict).toBe("failed");
    expect(t?.refute).toBeNull();
  });
});
