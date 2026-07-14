import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { TelemetryFacet } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { attributeFailures, resetPreparedStatements } from "./attribution.js";

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

function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-attribution-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedGoal(db: Database.Database, goalId: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Goal', '', 'active', 1, ?, ?, NULL)`
  ).run(goalId, NOW, NOW);
}

function telemetry(
  status: TelemetryFacet["outcome"]["status"],
  failureCode: TelemetryFacet["outcome"]["failure_code"]
): string {
  const facet: TelemetryFacet = {
    cost: null,
    latency_ms: null,
    model: null,
    provider_id: null,
    provider_version: null,
    prompt_ref: null,
    raw_output_ref: null,
    rejected_alternatives: [],
    human_interventions: [],
    outcome: { status, failure_code: failureCode },
  };
  return JSON.stringify(facet);
}

function seedTransition(
  db: Database.Database,
  id: string,
  goalId: string,
  boundary: string,
  telemetryJson: string | null
): void {
  db.prepare(
    `INSERT INTO harness_transitions
       (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, telemetry_json, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?)`
  ).run(id, goalId, boundary, telemetryJson, NOW);
}

beforeEach(() => resetPreparedStatements());

afterEach(() => {
  resetPreparedStatements();
  closeDatabase();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("attributeFailures", () => {
  it("clusters failed transitions by (failure_code, boundary), ordered by count desc, with sample ids", () => {
    const db = openTestDb();
    seedGoal(db, "g");

    // Cluster A: timeout @ step_launch — 3 failures (most frequent).
    seedTransition(db, "a1", "g", "step_launch", telemetry("failed", "timeout"));
    seedTransition(db, "a2", "g", "step_launch", telemetry("failed", "timeout"));
    seedTransition(db, "a3", "g", "step_launch", telemetry("failed", "timeout"));
    // Cluster B: evidence_veto @ step_complete — 2 failures.
    seedTransition(db, "b1", "g", "step_complete", telemetry("failed", "evidence_veto"));
    seedTransition(db, "b2", "g", "step_complete", telemetry("escalated", "evidence_veto"));
    // Cluster C: timeout @ step_complete — 1 (denied).
    seedTransition(db, "c1", "g", "step_complete", telemetry("denied", "timeout"));

    // Non-failures that must NOT be counted.
    seedTransition(db, "ok1", "g", "step_launch", telemetry("succeeded", null));
    seedTransition(db, "ok2", "g", "step_complete", telemetry("succeeded", null));
    // No telemetry at all — must NOT be counted.
    seedTransition(db, "none1", "g", "tool_gate", null);

    const clusters = attributeFailures(db, "g");

    expect(clusters).toEqual([
      {
        failure_code: "timeout",
        boundary: "step_launch",
        count: 3,
        sample_transition_ids: ["a1", "a2", "a3"],
      },
      {
        failure_code: "evidence_veto",
        boundary: "step_complete",
        count: 2,
        sample_transition_ids: ["b1", "b2"],
      },
      {
        failure_code: "timeout",
        boundary: "step_complete",
        count: 1,
        sample_transition_ids: ["c1"],
      },
    ]);
  });

  it("caps sample_transition_ids at 3 per cluster", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    for (let i = 0; i < 5; i++) {
      seedTransition(db, `t${i}`, "g", "step_launch", telemetry("failed", "timeout"));
    }
    const clusters = attributeFailures(db, "g");
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(5);
    expect(clusters[0]!.sample_transition_ids).toHaveLength(3);
  });

  it("returns [] for a goal with no failures", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    seedTransition(db, "ok1", "g", "step_launch", telemetry("succeeded", null));
    expect(attributeFailures(db, "g")).toEqual([]);
  });

  it("returns [] for an empty goal", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    expect(attributeFailures(db, "g")).toEqual([]);
  });
});
