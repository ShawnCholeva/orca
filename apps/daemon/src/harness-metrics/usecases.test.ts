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
  resetPreparedStatements,
  type HarnessTransitionCtx,
} from "../harness-transitions/usecases.js";
import { resetPreparedStatements as resetProjectionStmts } from "../harness-transitions/projection.js";
import { computeHarnessMetrics } from "./usecases.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-harness-metrics-"));
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

describe("computeHarnessMetrics", () => {
  it("computes available metrics and nulls absent-facet metrics with a reason", () => {
    seedGoal(db, "g");

    // tool_gate with a RiskFacet (allowed gate)
    recordHarnessTransition(ctx, {
      goalId: "g",
      boundary: "tool_gate",
      risk: {
        risk_class: "medium",
        permission_tier: "sandbox_edit",
        classification_reasons: [],
        gate_decision: "allow",
        hard_constraint_violations: [],
      },
    });

    // step_complete carrying an EvidenceFacet (passed) and TelemetryFacet (succeeded)
    recordHarnessTransition(ctx, {
      goalId: "g",
      boundary: "step_complete",
      evidence: {
        sensorsRun: [],
        verdict: "passed",
        untestedRegions: [],
        residualRisk: [],
        oracleAdequacy: { sufficient: true, gaps: [] },
      },
      telemetry: {
        cost: {
          tokens_in: 100,
          tokens_out: 50,
          cache_read_tokens: null,
          cache_creation_tokens: null,
          usd: 0.01,
        },
        latency_ms: 1200,
        model: "claude",
        provider_id: "anthropic",
        provider_version: null,
        prompt_ref: null,
        raw_output_ref: null,
        rejected_alternatives: [],
        human_interventions: [],
        outcome: { status: "succeeded", failure_code: null },
      },
    });

    // bare transition — no facets
    recordHarnessTransition(ctx, { goalId: "g", boundary: "step_launch" });

    const m = computeHarnessMetrics(db, "g");

    expect(m.trajectory_efficiency.value).not.toBeNull();
    expect(m.safety_compliance.value).not.toBeNull(); // RiskFacet present
    expect(m.verification_strength.value).not.toBeNull(); // EvidenceFacet present
    expect(m.state_consistency.value).toBeNull(); // StateDepsFacet absent
    expect(m.state_consistency.reason).toContain("StateDeps");
    expect(m.replayability.value).toBeGreaterThanOrEqual(0);
  });

  it("nulls every metric with a reason when there are no transitions", () => {
    seedGoal(db, "empty");
    const m = computeHarnessMetrics(db, "empty");

    expect(m.trajectory_efficiency.value).toBeNull();
    expect(m.trajectory_efficiency.reason).toBeTruthy();
    expect(m.verification_strength.value).toBeNull();
    expect(m.recovery.value).toBeNull();
    expect(m.state_consistency.value).toBeNull();
    expect(m.safety_compliance.value).toBeNull();
    expect(m.replayability.value).toBeNull();
  });

  it("scores recovery when a failure is followed by a success", () => {
    seedGoal(db, "rec");
    const tel = (status: "failed" | "succeeded") => ({
      cost: null,
      latency_ms: null,
      model: null,
      provider_id: null,
      provider_version: null,
      prompt_ref: null,
      raw_output_ref: null,
      rejected_alternatives: [],
      human_interventions: [],
      outcome: { status, failure_code: null },
    });
    recordHarnessTransition(ctx, { goalId: "rec", boundary: "step_complete", telemetry: tel("failed") });
    recordHarnessTransition(ctx, { goalId: "rec", boundary: "step_complete", telemetry: tel("succeeded") });

    const m = computeHarnessMetrics(db, "rec");
    expect(m.recovery.value).toBe(1);
  });
});
