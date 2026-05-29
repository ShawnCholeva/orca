import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult } from "../../../adapters/types.js";
import { AdapterRegistry } from "../../../adapters/registry.js";
import type { Config } from "../../../config.js";
import { closeDatabase, openDatabase } from "../../../db.js";
import { EventBus } from "../../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../../migrations.js";
import { FakePtyManager, controlFakePty } from "../../../pty/fake.js";
import type { PtyEvents, PtyHandle, PtyManager, PtyStartOptions } from "../../../pty/types.js";
import {
  createPendingTransportAttempt,
  type TransportAttemptUsecaseCtx,
} from "../attempts.js";
import { createOrchestrationWorkerStore, type OrchestrationWorkerStore } from "./store.js";
import {
  OrchestrationWorkerRuntime,
  type HiddenWorkerDriver,
  type RunHiddenWorkerAttemptInput,
} from "./runtime.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = "2026-01-01T00:00:00.000Z";
const tempDirs: string[] = [];
const PROPOSAL_START = "<PROPOSAL>";
const PROPOSAL_END = "</PROPOSAL>";
const VALID_SELECTION_PAYLOAD = {
  operatorId: "operator-1",
  operatorKind: "agent",
  reason: "best fit",
  requiredCapabilities: ["repo_edit"],
  alternativesConsidered: [],
  confidence: 0.8,
  requiresUserApproval: false,
};

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

function setupDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-worker-runtime-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedWorkflowGraph(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', '', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', NULL, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 1, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-step-1')"
  ).run(NOW);
  db.prepare("UPDATE workflow_runs SET current_step_run_id = 'step-1' WHERE id = 'run-1'").run();
}

function makeAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  const adapter: AgentAdapter = {
    id: "codex",
    title: "Codex",
    supportedExecutionModes: ["one_shot", "shadow_session"],
    contextDelivery: { mode: "preview_only", maxBytes: 32768 },
    async resolveSpawn(_input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
      return {
        command: "codex",
        args: ["agent"],
        cwd: "/tmp",
        env: {
          PATH: process.env["PATH"] ?? "",
          ORCA_GOAL_ID: "goal-1",
          ORCA_SESSION_ID: "worker-1",
          ORCA_AUTH_TOKEN: "desktop-secret",
          ORCA_MUTATION_TOKEN: "mutation-secret",
        },
      };
    },
    async probeAvailability() {
      return { status: "available" as const };
    },
    async checkInstalled() {
      return { name: "installed" as const, ok: true, command: "codex --version" };
    },
    async checkAuth() {
      return {
        name: "authenticated" as const,
        ok: true,
        authStatus: "ready" as const,
        command: "codex login status",
      };
    },
    repairFor() {
      return undefined;
    },
    supportsModel: () => false,
  };
  registry.register(adapter);
  return registry;
}

class CapturingPtyManager implements PtyManager {
  readonly inner = new FakePtyManager();
  lastStartOptions?: PtyStartOptions;
  lastHandle?: PtyHandle;

  start(opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents } {
    this.lastStartOptions = opts;
    const started = this.inner.start(opts);
    this.lastHandle = started.handle;
    return started;
  }
}

function makeRuntimeInput(attemptId: string): RunHiddenWorkerAttemptInput {
  return {
    attemptId,
    adapterId: "codex",
    workspacePath: "/tmp",
    request: {
      kind: "select_operator",
      goalId: "goal-1",
      workflowRunId: "run-1",
      stepRunId: "step-1",
      providerId: "orca/openai",
      modelId: "gpt-5",
      payload: {
        operators: [{ operatorId: "operator-1", operatorKind: "agent" }],
      },
    },
    driver: makeDriver(),
  };
}

function makeDriver(): HiddenWorkerDriver {
  return {
    buildRequestInput(request) {
      return `REQUEST:${JSON.stringify(request)}\n`;
    },
    detectReady(output) {
      return output.includes("[[READY]]");
    },
    detectAuthLost(output) {
      return /login required|auth required/i.test(output);
    },
    extractProposalOutput(output) {
      const start = output.indexOf(PROPOSAL_START);
      const end = output.indexOf(PROPOSAL_END);
      if (start < 0 || end <= start) return null;
      return output.slice(start + PROPOSAL_START.length, end).trim();
    },
  };
}

function createAttempt(ctx: TransportAttemptUsecaseCtx): string {
  return createPendingTransportAttempt(ctx, {
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    decisionKind: "select_operator",
    providerId: "orca/openai",
    modelId: "gpt-5",
    transport: "hidden_interactive",
    inputFingerprint: "fp-1",
  }).id;
}

function makeIdFactory(): () => string {
  let counter = 0;
  return () => `id-${++counter}`;
}

function wrapRecordingStore(store: OrchestrationWorkerStore): {
  store: OrchestrationWorkerStore;
  states: string[];
} {
  const states: string[] = [];
  return {
    store: {
      createWorker(input) {
        states.push(input.state);
        return store.createWorker(input);
      },
      getWorker(workerId) {
        return store.getWorker(workerId);
      },
      transitionWorkerState(input) {
        states.push(input.state);
        return store.transitionWorkerState(input);
      },
      updateWorkerAssignment(input) {
        return store.updateWorkerAssignment(input);
      },
      clearWorkerAssignment(workerId) {
        return store.clearWorkerAssignment(workerId);
      },
      appendWorkerOutput(workerId, data) {
        return store.appendWorkerOutput(workerId, data);
      },
      readWorkerOutputTail(workerId, options) {
        return store.readWorkerOutputTail(workerId, options);
      },
      markWorkerStopped(workerId, stoppedAt) {
        states.push("stopped");
        return store.markWorkerStopped(workerId, stoppedAt);
      },
      markWorkerFailed(input) {
        states.push("failed");
        return store.markWorkerFailed(input);
      },
    },
    states,
  };
}

afterEach(() => {
  vi.useRealTimers();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OrchestrationWorkerRuntime", () => {
  it("runs hidden interactive worker lifecycle and succeeds with parsed proposal", async () => {
    const db = setupDb();
    seedWorkflowGraph(db);
    const bus = new EventBus();
    const idFactory = makeIdFactory();
    const attemptCtx: TransportAttemptUsecaseCtx = {
      db,
      bus,
      now: () => NOW,
      idFactory,
    };
    const attemptId = createAttempt(attemptCtx);
    const pty = new CapturingPtyManager();
    const recording = wrapRecordingStore(createOrchestrationWorkerStore(db, { now: () => NOW }));
    const runtime = new OrchestrationWorkerRuntime({
      db,
      bus,
      adapterRegistry: makeAdapterRegistry(),
      ptyManager: pty,
      workerStore: recording.store,
      now: () => NOW,
      idFactory,
      startupTimeoutMs: 1000,
      decisionTimeoutMs: 1000,
      heartbeatTimeoutMs: 500,
      pollIntervalMs: 1,
    });

    const runPromise = runtime.runAttempt(makeRuntimeInput(attemptId));
    await delayMs(5);
    const ctrl = controlFakePty(pty.lastHandle!);
    ctrl.emitData(Buffer.from("[[READY]]\n", "utf8"));
    await delayMs(5);
    ctrl.emitData(
      Buffer.from(
        `${PROPOSAL_START}\n${JSON.stringify({
          orcaProposalVersion: 1,
          kind: "select_operator",
          payload: VALID_SELECTION_PAYLOAD,
        })}\n${PROPOSAL_END}\n`,
        "utf8"
      )
    );

    const result = await runPromise;
    expect(result.status).toBe("proposed");
    expect(result.rawTextLength).toBeGreaterThan(0);
    expect(recording.states).toEqual([
      "starting",
      "ready",
      "awaiting_input",
      "producing_decision",
      "stopped",
    ]);

    const attempt = db
      .prepare("SELECT status, failure_reason FROM orchestration_transport_attempts WHERE id = ?")
      .get(attemptId) as { status: string; failure_reason: string | null };
    expect(attempt.status).toBe("succeeded");
    expect(attempt.failure_reason).toBeNull();

    const worker = db
      .prepare("SELECT state, failure_reason FROM orchestration_workers WHERE id = ?")
      .get(result.workerId) as { state: string; failure_reason: string | null };
    expect(worker.state).toBe("stopped");
    expect(worker.failure_reason).toBeNull();

    expect(pty.lastStartOptions?.env["ORCA_AUTH_TOKEN"]).toBeUndefined();
    expect(pty.lastStartOptions?.env["ORCA_MUTATION_TOKEN"]).toBeUndefined();
  });

  it("marks proposal as rejected when validator rejects parsed output", async () => {
    const db = setupDb();
    seedWorkflowGraph(db);
    const bus = new EventBus();
    const idFactory = makeIdFactory();
    const attemptId = createAttempt({ db, bus, now: () => NOW, idFactory });
    const pty = new CapturingPtyManager();
    const runtime = new OrchestrationWorkerRuntime({
      db,
      bus,
      adapterRegistry: makeAdapterRegistry(),
      ptyManager: pty,
      workerStore: createOrchestrationWorkerStore(db, { now: () => NOW }),
      now: () => NOW,
      idFactory,
      pollIntervalMs: 1,
    });

    const runPromise = runtime.runAttempt({
      ...makeRuntimeInput(attemptId),
      validateProposal: () => ({ accepted: false, failureMessage: "guardrail denied choice" }),
    });
    await delayMs(5);
    const ctrl = controlFakePty(pty.lastHandle!);
    ctrl.emitData(Buffer.from("[[READY]]\n", "utf8"));
    await delayMs(5);
    ctrl.emitData(
      Buffer.from(
        `${PROPOSAL_START}${JSON.stringify({
          orcaProposalVersion: 1,
          kind: "select_operator",
          payload: VALID_SELECTION_PAYLOAD,
        })}${PROPOSAL_END}`,
        "utf8"
      )
    );

    const result = await runPromise;
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error(`expected rejected result, got ${result.status}`);
    }
    expect(result.failureReason).toBe("proposal_rejected");

    const attempt = db
      .prepare("SELECT status, failure_reason FROM orchestration_transport_attempts WHERE id = ?")
      .get(attemptId) as { status: string; failure_reason: string | null };
    expect(attempt.status).toBe("rejected");
    expect(attempt.failure_reason).toBe("proposal_rejected");
  });

  it("maps PTY start failure to interactive_spawn_failed", async () => {
    const db = setupDb();
    seedWorkflowGraph(db);
    const bus = new EventBus();
    const idFactory = makeIdFactory();
    const attemptId = createAttempt({ db, bus, now: () => NOW, idFactory });
    const throwingPty: PtyManager = {
      start(): { handle: PtyHandle; events: PtyEvents } {
        throw new Error("spawn failed");
      },
    };
    const runtime = new OrchestrationWorkerRuntime({
      db,
      bus,
      adapterRegistry: makeAdapterRegistry(),
      ptyManager: throwingPty,
      workerStore: createOrchestrationWorkerStore(db, { now: () => NOW }),
      now: () => NOW,
      idFactory,
      pollIntervalMs: 1,
    });

    const result = await runtime.runAttempt(makeRuntimeInput(attemptId));
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error(`expected failed result, got ${result.status}`);
    }
    expect(result.failureReason).toBe("interactive_spawn_failed");

    const attempt = db
      .prepare("SELECT status, failure_reason FROM orchestration_transport_attempts WHERE id = ?")
      .get(attemptId) as { status: string; failure_reason: string | null };
    expect(attempt.status).toBe("failed");
    expect(attempt.failure_reason).toBe("interactive_spawn_failed");
  });

  it("maps startup timeout to interactive_hung", async () => {
    vi.useFakeTimers();

    const db = setupDb();
    seedWorkflowGraph(db);
    const bus = new EventBus();
    const idFactory = makeIdFactory();
    const attemptId = createAttempt({ db, bus, now: () => NOW, idFactory });
    const pty = new CapturingPtyManager();
    const runtime = new OrchestrationWorkerRuntime({
      db,
      bus,
      adapterRegistry: makeAdapterRegistry(),
      ptyManager: pty,
      workerStore: createOrchestrationWorkerStore(db, { now: () => NOW }),
      now: () => NOW,
      idFactory,
      nowMs: () => Date.now(),
      startupTimeoutMs: 100,
      decisionTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      pollIntervalMs: 25,
    });

    const runPromise = runtime.runAttempt(makeRuntimeInput(attemptId));
    await vi.advanceTimersByTimeAsync(150);

    const result = await runPromise;
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error(`expected failed result, got ${result.status}`);
    }
    expect(result.failureReason).toBe("interactive_hung");
  });

  it("maps decision heartbeat timeout to interactive_hung", async () => {
    vi.useFakeTimers();

    const db = setupDb();
    seedWorkflowGraph(db);
    const bus = new EventBus();
    const idFactory = makeIdFactory();
    const attemptId = createAttempt({ db, bus, now: () => NOW, idFactory });
    const pty = new CapturingPtyManager();
    const runtime = new OrchestrationWorkerRuntime({
      db,
      bus,
      adapterRegistry: makeAdapterRegistry(),
      ptyManager: pty,
      workerStore: createOrchestrationWorkerStore(db, { now: () => NOW }),
      now: () => NOW,
      idFactory,
      nowMs: () => Date.now(),
      startupTimeoutMs: 1000,
      decisionTimeoutMs: 1000,
      heartbeatTimeoutMs: 100,
      pollIntervalMs: 25,
    });

    const runPromise = runtime.runAttempt(makeRuntimeInput(attemptId));
    await vi.advanceTimersByTimeAsync(25);
    controlFakePty(pty.lastHandle!).emitData(Buffer.from("[[READY]]\n", "utf8"));
    await vi.advanceTimersByTimeAsync(200);
    const result = await runPromise;

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error(`expected failed result, got ${result.status}`);
    }
    expect(result.failureReason).toBe("interactive_hung");
  });

  it("maps auth/login prompt detection to interactive_auth_lost", async () => {
    const db = setupDb();
    seedWorkflowGraph(db);
    const bus = new EventBus();
    const idFactory = makeIdFactory();
    const attemptId = createAttempt({ db, bus, now: () => NOW, idFactory });
    const pty = new CapturingPtyManager();
    const recording = wrapRecordingStore(createOrchestrationWorkerStore(db, { now: () => NOW }));
    const runtime = new OrchestrationWorkerRuntime({
      db,
      bus,
      adapterRegistry: makeAdapterRegistry(),
      ptyManager: pty,
      workerStore: recording.store,
      now: () => NOW,
      idFactory,
      startupTimeoutMs: 1000,
      decisionTimeoutMs: 1000,
      heartbeatTimeoutMs: 1000,
      pollIntervalMs: 1,
    });

    const runPromise = runtime.runAttempt(makeRuntimeInput(attemptId));
    await delayMs(5);
    const ctrl = controlFakePty(pty.lastHandle!);
    ctrl.emitData(Buffer.from("[[READY]]\n", "utf8"));
    await delayMs(5);
    ctrl.emitData(Buffer.from("login required\n", "utf8"));

    const result = await runPromise;
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error(`expected failed result, got ${result.status}`);
    }
    expect(result.failureReason).toBe("interactive_auth_lost");
    expect(recording.states).toContain("auth_required");
  });

  it("maps malformed proposal envelope to interactive_output_invalid", async () => {
    const db = setupDb();
    seedWorkflowGraph(db);
    const bus = new EventBus();
    const idFactory = makeIdFactory();
    const attemptId = createAttempt({ db, bus, now: () => NOW, idFactory });
    const pty = new CapturingPtyManager();
    const runtime = new OrchestrationWorkerRuntime({
      db,
      bus,
      adapterRegistry: makeAdapterRegistry(),
      ptyManager: pty,
      workerStore: createOrchestrationWorkerStore(db, { now: () => NOW }),
      now: () => NOW,
      idFactory,
      pollIntervalMs: 1,
    });

    const runPromise = runtime.runAttempt(makeRuntimeInput(attemptId));
    await delayMs(5);
    const ctrl = controlFakePty(pty.lastHandle!);
    ctrl.emitData(Buffer.from("[[READY]]\n", "utf8"));
    await delayMs(5);
    ctrl.emitData(Buffer.from(`${PROPOSAL_START}{not-json}${PROPOSAL_END}`, "utf8"));

    const result = await runPromise;
    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error(`expected failed result, got ${result.status}`);
    }
    expect(result.failureReason).toBe("interactive_output_invalid");
  });
});

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
