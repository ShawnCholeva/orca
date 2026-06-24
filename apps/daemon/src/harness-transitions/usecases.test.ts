import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import {
  recordHarnessTransition,
  listTransitionsByGoal,
  resetPreparedStatements,
  type HarnessTransitionCtx,
} from "./usecases.js";
import { resetPreparedStatements as resetProjectionStmts } from "./projection.js";

const tempDirs: string[] = [];

class SpyBus extends EventBus {
  readonly captured: DomainEvent[] = [];
  override publish(event: DomainEvent): void {
    this.captured.push(event);
    super.publish(event);
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

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-harness-transitions-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, now, now);
}

let db: Database.Database;
let bus: SpyBus;
let ctx: HarnessTransitionCtx;
let counter = 0;

beforeEach(() => {
  db = openTestDb();
  bus = new SpyBus();
  counter = 0;
  ctx = {
    db,
    bus,
    now: () => "2026-05-01T00:00:00.000Z",
    idFactory: () => `id-${++counter}`,
  };
});

afterEach(() => {
  closeDatabase();
  resetPreparedStatements();
  resetProjectionStmts();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recordHarnessTransition", () => {
  it("persists a spine transition and emits harness.transition.recorded", () => {
    seedGoal(db, "goal-1");

    const t = recordHarnessTransition(ctx, {
      goalId: "goal-1",
      workflowRunId: "run-1",
      workflowStepRunId: "step-1",
      boundary: "step_complete",
    });

    expect(t.boundary).toBe("step_complete");
    expect(t.evidence).toBeNull();

    const listed = listTransitionsByGoal(db, "goal-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(t.id);

    expect(bus.captured).toHaveLength(1);
    expect(bus.captured[0]!.type).toBe("harness.transition.recorded");
    expect(bus.captured[0]!.payload).toMatchObject({
      transitionId: t.id,
      goalId: "goal-1",
      boundary: "step_complete",
    });
  });

  it("round-trips a non-null facet", () => {
    seedGoal(db, "goal-1");
    const t = recordHarnessTransition(ctx, {
      goalId: "goal-1",
      boundary: "tool_gate",
      risk: {
        risk_class: "medium",
        permission_tier: "sandbox_edit",
        classification_reasons: [],
        gate_decision: "allow",
        hard_constraint_violations: [],
      },
    });
    const listed = listTransitionsByGoal(db, "goal-1");
    expect(listed[0]!.risk).toEqual({
      risk_class: "medium",
      permission_tier: "sandbox_edit",
      classification_reasons: [],
      gate_decision: "allow",
      hard_constraint_violations: [],
    });
    expect(t.workflowRunId).toBeNull();
  });
});
