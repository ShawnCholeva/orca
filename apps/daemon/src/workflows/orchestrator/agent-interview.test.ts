import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionOutputSnapshot } from "@orca/contracts";
import type { SessionOutputStore } from "../../sessions/output-store.js";
import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import {
  cleanupHarness,
  setupHarness,
  makeStep,
  fakeSelector,
  fakeRegistry,
  NOW,
} from "./skill-step-test-helpers.js";
import { OrchestratorService } from "./service.js";
import {
  formatAnswerForAgentStdin,
  injectAnswerToSession,
  detectPendingAgentQuestion,
} from "./agent-interview.js";

describe("formatAnswerForAgentStdin", () => {
  it("appends a newline", () => {
    expect(formatAnswerForAgentStdin("yes")).toBe("yes\n");
  });
  it("strips control sequences and trims", () => {
    expect(formatAnswerForAgentStdin("  hithere  ")).toBe("hithere\n");
  });
});

describe("injectAnswerToSession", () => {
  it("writes the answer to the PTY handle when session exists", () => {
    const write = vi.fn();
    const r = injectAnswerToSession({ getHandle: () => ({ write }) }, "s", "yes");
    expect(r).toBe("injected");
    expect(write).toHaveBeenCalledWith(Buffer.from("yes\n", "utf8"));
  });
  it("returns 'no_session' when no handle", () => {
    expect(injectAnswerToSession({ getHandle: () => undefined }, "s", "yes")).toBe("no_session");
  });
});

describe("detectPendingAgentQuestion", () => {
  it("extracts the sentinel question", () => {
    expect(detectPendingAgentQuestion('foo\n[orca:ask] question="Region?"\nbar')).toBe("Region?");
  });
  it("returns null when absent", () => {
    expect(detectPendingAgentQuestion("nothing here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: onSessionOutputChunk (10b)
// ---------------------------------------------------------------------------

function snapshotWithText(sessionId: string, text: string): SessionOutputSnapshot {
  return {
    sessionId,
    firstByteOffset: 0,
    nextSeq: 1,
    totalBytesKept: Buffer.byteLength(text),
    chunks: [{ seq: 0, byteOffset: 0, dataBase64: Buffer.from(text).toString("base64") }],
  };
}

function fakeOutputStore(tail: string): SessionOutputStore {
  return {
    appendChunk: vi.fn(() => ({ seq: 0, byteOffset: 0 })),
    readTail: vi.fn((id: string) => snapshotWithText(id, tail)),
  };
}

function makeServiceWithStore(outputStore: SessionOutputStore): OrchestratorService {
  return new OrchestratorService(
    fakeSelector(),
    { async propose() { return { status: "proposed" as const, attemptId: "a", transport: "one_shot" as const, parsed: {}, rawTextLength: null, latencyMs: 1 }; } },
    fakeRegistry(),
    undefined,
    outputStore
  );
}

function seedAgentSessionWithSentinel(
  db: Database.Database,
  opts: { stepRunStatus?: string } = {}
): { sessionId: string; goalId: string; stepRunId: string; runId: string } {
  const sessionId = "sess-interview-1";
  const goalId = "goal-interview-1";
  const runId = "run-interview-1";
  const stepRunId = "step-interview-1";
  const stepRunStatus = opts.stepRunStatus ?? "active";

  const step = makeStep({
    id: "implement",
    ordinal: 0,
    name: "Implement",
    instructions: "Do the work.",
    outputSchema: [{ key: "result", type: "string", required: true }],
  });

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run(goalId, NOW, NOW);

  db.prepare(
    "INSERT INTO workspaces (id, goal_id, name, path, workspace_type, git_probe, attached_at) VALUES ('ws-int-1', ?, 'main', '/tmp/repo', 'git', 'ok', ?)"
  ).run(goalId, NOW);

  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)"
  ).run(JSON.stringify([step]), NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES (?, ?, 'orca/engineering', 1, 'active', ?, NULL, ?, NULL)"
  ).run(runId, goalId, stepRunId, NOW);

  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES (?, ?, ?, ?, 0, 1, ?, '[]', '[]', NULL, ?, NULL, 'fp-1', NULL, NULL, NULL, NULL)"
  ).run(stepRunId, goalId, runId, step.id, stepRunStatus, NOW);

  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES (?, ?, 'ws-int-1', 'claude-code', 'Session', 'running', ?, ?)"
  ).run(sessionId, goalId, NOW, stepRunId);

  return { sessionId, goalId, runId, stepRunId };
}

function countDecisions(db: Database.Database, decisionType: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM workflow_decisions WHERE decision_type = ?")
      .get(decisionType) as { c: number }
  ).c;
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("OrchestratorService.onSessionOutputChunk", () => {
  it("sentinel in tail → emits request_user_input decision once (idempotent)", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedAgentSessionWithSentinel(db);

    const outputStore = fakeOutputStore('[orca:ask] question="Region?"');
    const service = makeServiceWithStore(outputStore);
    const opts = { bus, idFactory };

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, opts);
    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, opts);

    expect(countDecisions(db, "request_user_input")).toBe(1);
  });

  it("no sentinel → no decision emitted", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedAgentSessionWithSentinel(db);

    const outputStore = fakeOutputStore("just some output");
    const service = makeServiceWithStore(outputStore);

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(countDecisions(db, "request_user_input")).toBe(0);
  });

  it("session not linked to a step run → no-op", async () => {
    const { db, bus, idFactory } = setupHarness();

    const goalId = "goal-noop-1";
    const sessionId = "sess-noop-1";
    db.prepare(
      "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'G', 'd', 'active', 1, ?, ?, NULL, NULL, NULL)"
    ).run(goalId, NOW, NOW);
    db.prepare(
      "INSERT INTO workspaces (id, goal_id, name, path, workspace_type, git_probe, attached_at) VALUES ('ws-noop-1', ?, 'main', '/tmp', 'git', 'ok', ?)"
    ).run(goalId, NOW);
    db.prepare(
      "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at, workflow_step_run_id) VALUES (?, ?, 'ws-noop-1', 'claude-code', 'S', 'running', ?, NULL)"
    ).run(sessionId, goalId, NOW);

    const outputStore = fakeOutputStore('[orca:ask] question="test?"');
    const service = makeServiceWithStore(outputStore);

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(countDecisions(db, "request_user_input")).toBe(0);
  });

  it("step run not active → no-op", async () => {
    const { db, bus, idFactory } = setupHarness();
    const { sessionId, goalId } = seedAgentSessionWithSentinel(db, { stepRunStatus: "passed" });

    const outputStore = fakeOutputStore('[orca:ask] question="Region?"');
    const service = makeServiceWithStore(outputStore);

    await service.onSessionOutputChunk(db, () => NOW, { sessionId, goalId }, { bus, idFactory });

    expect(countDecisions(db, "request_user_input")).toBe(0);
  });
});
