import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { CostEntry, HarnessTransition } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { insertTransition } from "../harness-transitions/projection.js";
import { buildGoalCostRollup } from "./cost-rollup.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

function setupDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-cost-rollup-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  db.pragma("foreign_keys = OFF");
  return db;
}

let seq = 0;
function seedStepComplete(
  db: Database.Database,
  opts: {
    id: string;
    goalId: string;
    runId: string;
    createdAt: string;
    boundary?: string;
    cost: CostEntry | null;
    stepRunId?: string;
  }
): void {
  const t: HarnessTransition = {
    id: opts.id,
    goalId: opts.goalId,
    workflowRunId: opts.runId,
    workflowStepRunId: opts.stepRunId ?? `sr-${seq++}`,
    boundary: (opts.boundary ?? "step_complete") as HarnessTransition["boundary"],
    risk: null,
    evidence: null,
    stateDeps: null,
    telemetry:
      opts.cost === null
        ? null
        : {
            cost: opts.cost,
            latency_ms: null,
            model: null,
            provider_id: null,
            provider_version: null,
            prompt_ref: null,
            raw_output_ref: null,
            rejected_alternatives: [],
            human_interventions: [],
            outcome: { status: "succeeded", failure_code: null },
          },
    createdAt: opts.createdAt,
  };
  insertTransition(db, t);
}

function cost(partial: Partial<CostEntry>): CostEntry {
  return {
    tokens_in: 0,
    tokens_out: 0,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    usd: 0,
    ...partial,
  };
}

describe("buildGoalCostRollup", () => {
  it("sums usd and token counts across the run's step_complete costs", () => {
    const db = setupDb();
    seedStepComplete(db, {
      id: "t1", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:01:00.000Z",
      cost: cost({ tokens_in: 100, tokens_out: 40, usd: 0.01 }),
    });
    seedStepComplete(db, {
      id: "t2", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:02:00.000Z",
      cost: cost({ tokens_in: 200, tokens_out: 60, usd: 0.02 }),
    });

    const rollup = buildGoalCostRollup(db, "g1", "run1");

    expect(rollup).not.toBeNull();
    expect(rollup!.tokens_in).toBe(300);
    expect(rollup!.tokens_out).toBe(100);
    expect(rollup!.usd).toBeCloseTo(0.03, 10);
  });

  it("sums cache tokens, staying null only when no step reported them", () => {
    const db = setupDb();
    seedStepComplete(db, {
      id: "t1", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:01:00.000Z",
      cost: cost({ usd: 0.01, cache_read_tokens: 500, cache_creation_tokens: null }),
    });
    seedStepComplete(db, {
      id: "t2", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:02:00.000Z",
      cost: cost({ usd: 0.01, cache_read_tokens: 250, cache_creation_tokens: 80 }),
    });

    const rollup = buildGoalCostRollup(db, "g1", "run1");

    expect(rollup!.cache_read_tokens).toBe(750);
    expect(rollup!.cache_creation_tokens).toBe(80);
  });

  it("returns null when no step in the run reported a cost", () => {
    const db = setupDb();
    seedStepComplete(db, {
      id: "t1", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:01:00.000Z", cost: null,
    });

    expect(buildGoalCostRollup(db, "g1", "run1")).toBeNull();
  });

  it("excludes other runs and non-step_complete boundaries", () => {
    const db = setupDb();
    seedStepComplete(db, {
      id: "t1", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:01:00.000Z",
      cost: cost({ usd: 0.01 }),
    });
    seedStepComplete(db, {
      id: "t2", goalId: "g1", runId: "run2", createdAt: "2026-06-26T00:02:00.000Z",
      cost: cost({ usd: 5.0 }),
    });
    seedStepComplete(db, {
      id: "t3", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:03:00.000Z",
      boundary: "step_launch", cost: cost({ usd: 9.0 }),
    });

    const rollup = buildGoalCostRollup(db, "g1", "run1");

    expect(rollup!.usd).toBeCloseTo(0.01, 10);
  });

  it("scopes to a single step template when stepTemplateId is given", () => {
    const db = setupDb();
    // execution runs twice (attempt 1 + 2 — the re-run / runaway case).
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, fingerprint) VALUES (?, 'g1', 'run1', ?, ?, ?, 'passed', ?)"
    ).run("execA", "execution", 0, 1, "fp-a");
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, fingerprint) VALUES (?, 'g1', 'run1', ?, ?, ?, 'passed', ?)"
    ).run("execB", "execution", 1, 2, "fp-b");
    db.prepare(
      "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, fingerprint) VALUES (?, 'g1', 'run1', ?, ?, ?, 'passed', ?)"
    ).run("review1", "review", 2, 1, "fp-r");

    seedStepComplete(db, {
      id: "t1", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:01:00.000Z",
      stepRunId: "execA", cost: cost({ usd: 0.10 }),
    });
    seedStepComplete(db, {
      id: "t2", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:02:00.000Z",
      stepRunId: "execB", cost: cost({ usd: 0.20 }),
    });
    seedStepComplete(db, {
      id: "t3", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:03:00.000Z",
      stepRunId: "review1", cost: cost({ usd: 1.0 }),
    });

    const rollup = buildGoalCostRollup(db, "g1", "run1", { stepTemplateId: "execution" });

    expect(rollup!.usd).toBeCloseTo(0.30, 10);
  });
});
