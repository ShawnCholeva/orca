import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import { listTransitionsByGoal, resetPreparedStatements, type HarnessTransitionCtx } from "./usecases.js";
import { resetPreparedStatements as resetProjStmts } from "./projection.js";
import { emitStepComplete, emitMarkDone, HARNESS_BOUNDARIES } from "./emit.js";

const dirs: string[] = [];
function cfg(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1<<20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1<<20, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","x.js"], getAuthToken: () => "t" };
}
function seedGoal(db: Database.Database, id: string) {
  db.prepare(`INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at)
    VALUES (?, 'G', '', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`).run(id);
}
let db: Database.Database; let ctx: HarnessTransitionCtx; let n = 0;
beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-emit-")); dirs.push(dir);
  db = openDatabase(cfg(dir)); runMigrations(db, defaultMigrationsDir());
  n = 0; ctx = { db, bus: new EventBus(), now: () => "2026-05-01T00:00:00.000Z", idFactory: () => `id-${++n}` };
});
afterEach(() => { closeDatabase(); resetPreparedStatements(); resetProjStmts(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("emit factory", () => {
  it("emitStepComplete records the step_complete boundary", () => {
    seedGoal(db, "g1");
    emitStepComplete(ctx, { goalId: "g1", workflowRunId: "r1", workflowStepRunId: "s1" });
    const items = listTransitionsByGoal(db, "g1");
    expect(items).toHaveLength(1);
    expect(items[0]!.boundary).toBe("step_complete");
  });

  it("emitMarkDone records a mark_done transition carrying telemetry", () => {
    seedGoal(db, "g1");
    emitMarkDone(ctx, {
      goalId: "g1", workflowRunId: "r1",
      telemetry: {
        cost: null, latency_ms: null, model: null, provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null, rejected_alternatives: [],
        human_interventions: [{ kind: "mark_done_approval", ref: "rec-1" }],
        outcome: { status: "succeeded", failure_code: null },
      },
    });
    const items = listTransitionsByGoal(db, "g1");
    expect(items[0]!.boundary).toBe("mark_done");
    expect(items[0]!.telemetry?.outcome.status).toBe("succeeded");
    expect(items[0]!.telemetry?.human_interventions[0]!.kind).toBe("mark_done_approval");
  });

  it("registers every boundary with its declared facets", () => {
    const byKey = Object.fromEntries(HARNESS_BOUNDARIES.map((b) => [b.key, b.facets]));
    expect(byKey).toEqual({
      tool_gate: ["risk"],
      step_complete: ["evidence", "stateDeps", "telemetry", "refute"],
      step_launch: ["stateDeps"],
      mark_done: ["telemetry", "stateDeps"],
      delegate_spawn: ["composition"],
      delegate_join: ["composition"],
    });
  });
});
