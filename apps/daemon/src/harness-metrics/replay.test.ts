import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { replayControlPlane } from "./replay.js";

const tempDirs: string[] = [];

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-replay-"));
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

// Full, schema-valid facet fixtures (HarnessTransition.parse is strict on read).
function riskFacet(gate_decision: string): unknown {
  return {
    risk_class: "low",
    permission_tier: "read_only",
    classification_reasons: [],
    gate_decision,
    hard_constraint_violations: [],
  };
}

function evidenceFacet(verdict: string): unknown {
  return {
    sensorsRun: [],
    verdict,
    untestedRegions: [],
    residualRisk: [],
    oracleAdequacy: { sufficient: true, gaps: [] },
  };
}

function telemetryFacet(status: string): unknown {
  return {
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
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("replayControlPlane", () => {
  it("returns transitions in chronological order with seq, boundary, summary, and facets", () => {
    const db = openTestDb();
    seedGoal(db, "g");

    // Inserted OUT of chronological order on purpose (varying createdAt).
    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'tool_gate', ?, NULL, NULL, NULL, ?)`
    ).run("t-b", JSON.stringify(riskFacet("deny")), "2026-01-01T00:00:02.000Z");

    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'step_complete', NULL, ?, NULL, NULL, ?)`
    ).run("t-a", JSON.stringify(evidenceFacet("passed")), "2026-01-01T00:00:01.000Z");

    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'step_complete', NULL, NULL, NULL, ?, ?)`
    ).run("t-c", JSON.stringify(telemetryFacet("failed")), "2026-01-01T00:00:03.000Z");

    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'step_launch', NULL, NULL, NULL, NULL, ?)`
    ).run("t-d", "2026-01-01T00:00:04.000Z");

    const { steps } = replayControlPlane(db, "g");

    // Chronological order by created_at, seq assigned 0..n-1.
    expect(steps.map((s) => s.at)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
    ]);
    expect(steps.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    expect(steps.map((s) => s.boundary)).toEqual([
      "step_complete",
      "tool_gate",
      "step_complete",
      "step_launch",
    ]);

    // Per-boundary summary derivation.
    expect(steps[0]!.summary).toBe("passed"); // step_complete -> evidence.verdict
    expect(steps[1]!.summary).toBe("deny"); // tool_gate -> risk.gate_decision
    expect(steps[2]!.summary).toBe("failed"); // step_complete, no evidence -> telemetry.outcome.status
    expect(steps[3]!.summary).toBe("step_launch"); // fallback -> boundary name

    // Facets are carried through.
    expect(steps[0]!.facets.evidence).toMatchObject({ verdict: "passed" });
    expect(steps[1]!.facets.risk).toMatchObject({ gate_decision: "deny" });
    expect(steps[2]!.facets.telemetry).toMatchObject({ outcome: { status: "failed" } });
  });

  it("is deterministic across repeated calls", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    db.prepare(
      `INSERT INTO harness_transitions
         (id, goal_id, workflow_run_id, workflow_step_run_id, boundary,
          risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?, 'g', NULL, NULL, 'tool_gate', ?, NULL, NULL, NULL, ?)`
    ).run("x", JSON.stringify(riskFacet("allow")), "2026-01-01T00:00:05.000Z");

    const first = replayControlPlane(db, "g");
    const second = replayControlPlane(db, "g");
    expect(second).toEqual(first);
  });

  it("returns an empty trajectory for a goal with no transitions", () => {
    const db = openTestDb();
    seedGoal(db, "g");
    expect(replayControlPlane(db, "g")).toEqual({ steps: [] });
  });
});
