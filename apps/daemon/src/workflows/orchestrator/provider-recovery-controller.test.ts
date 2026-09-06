import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { ProviderRecoveryController } from "./provider-recovery-controller.js";
import type { RunnerPort } from "./runner-port.js";
import { makeStep } from "./skill-step-test-helpers.js";

const NOW = "2026-09-06T06:33:00.000Z";
const RESET_AT = "2026-09-06T06:50:00.000Z";

function seed(db: Database.Database, mode: "choose" | "waiting", resetAt: string | null) {
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', '', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, ?, '[]', ?, ?)"
  ).run(JSON.stringify([makeStep({ id: "intake", name: "Intake" })]), NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'intake', 0, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-1')"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES ('ws-1', '/tmp/ws', 'ws', '', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, role, title, status, created_at, started_at, workflow_step_run_id) VALUES ('sess-1', 'goal-1', 'ws-1', 'claude-code', 'engineer', 'Workflow step', 'running', ?, ?, 'step-1')"
  ).run(NOW, NOW);
  const checkpoint = {
    id: "ckpt-1", mode, failureCode: "session_limit", message: "Claude Code session limit reached",
    currentSessionId: "sess-1", currentAdapterId: "claude-code", currentProviderName: "Claude Code",
    resetTimeText: "1:50am", resetAt, timezone: "America/Chicago", detectedAt: NOW,
    retryOutputSeq: null, retryKind: "preserved_session", replacementSessionId: null,
    replacementOutputSeq: null, pendingGuidance: [], lastError: null, choices: [],
  };
  db.prepare("UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = 'step-1'").run(JSON.stringify(checkpoint));
}

function mode(db: Database.Database): string {
  return JSON.parse((db.prepare("SELECT pending_provider_recovery_json AS j FROM workflow_step_runs WHERE id = 'step-1'").get() as { j: string }).j).mode;
}

describe("ProviderRecoveryController automatic retry", () => {
  let db: Database.Database;
  let clock = Date.parse(NOW);
  const now = () => new Date(clock).toISOString();
  const runner: RunnerPort = {
    launch: vi.fn(async () => ({ sessionId: "x" })),
    workerSpawn: vi.fn(async () => undefined),
    workerDeliver: vi.fn(async () => "delivered" as const),
    workerWait: vi.fn(async () => undefined),
    readTail: vi.fn(() => ({ chunks: [], nextSeq: 7 })) as unknown as RunnerPort["readTail"],
  };
  const controller = () => new ProviderRecoveryController({ runner, operators: { list: async () => [] }, stepDispatch: undefined });

  beforeEach(() => {
    vi.useFakeTimers();
    clock = Date.parse(NOW);
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    vi.mocked(runner.workerDeliver).mockClear();
  });
  afterEach(() => { vi.useRealTimers(); db.close(); });

  it("Wait arms a retry at the reset time and fires it without a click", async () => {
    // "Wait for Claude Code" preserved the session and then left the run parked
    // past the reset until a human clicked Retry. The reset is a known instant.
    seed(db, "choose", RESET_AT);
    const c = controller();
    await c.waitForProvider(db, now, "run-1", "ckpt-1");
    expect(mode(db)).toBe("waiting");
    expect(c.armedAutoRetries()).toBe(1);

    // Just before the reset: nothing.
    clock = Date.parse(RESET_AT) - 1000;
    await vi.advanceTimersByTimeAsync(Date.parse(RESET_AT) - Date.parse(NOW) - 1000);
    expect(mode(db)).toBe("waiting");
    // Past the reset plus the grace: the retry the button would have made.
    clock = Date.parse(RESET_AT) + 31_000;
    await vi.advanceTimersByTimeAsync(32_000);
    expect(mode(db)).toBe("retrying");
    expect(runner.workerDeliver).toHaveBeenCalledWith("sess-1", "Continue the previous step request.");
    expect(c.armedAutoRetries()).toBe(0);
  });

  it("a human Retry disarms the timer, so the worker is not nudged twice", async () => {
    seed(db, "choose", RESET_AT);
    const c = controller();
    await c.waitForProvider(db, now, "run-1", "ckpt-1");
    clock = Date.parse(RESET_AT) + 1000;
    await c.retryProvider(db, now, "run-1", "ckpt-1");
    expect(c.armedAutoRetries()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runner.workerDeliver).toHaveBeenCalledTimes(1);
  });

  it("re-arms waiting checkpoints from the table at boot", () => {
    // Timers die with the process; the checkpoint does not.
    seed(db, "waiting", RESET_AT);
    const c = controller();
    expect(c.armAutoRetriesOnBoot(db, now, {})).toBe(1);
    expect(c.armedAutoRetries()).toBe(1);
  });

  it("keeps the manual button when no reset time is known", async () => {
    seed(db, "choose", null);
    const c = controller();
    await c.waitForProvider(db, now, "run-1", "ckpt-1");
    expect(c.armedAutoRetries()).toBe(0);
  });
});
