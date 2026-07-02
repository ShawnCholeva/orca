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
import { emitDelegateSpawn, emitDelegateJoin } from "./emit.js";
import type { CompositionFacet } from "@orca/contracts";

const dirs: string[] = [];
function cfg(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1<<20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1<<20, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","x.js"], getAuthToken: () => "t" };
}
function seedGoal(db: Database.Database, id: string) {
  db.prepare(`INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
    VALUES (?, 'G', '', 'active', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`).run(id);
}
let db: Database.Database; let ctx: HarnessTransitionCtx; let n = 0;
beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-emit-comp-")); dirs.push(dir);
  db = openDatabase(cfg(dir)); runMigrations(db, defaultMigrationsDir());
  n = 0; ctx = { db, bus: new EventBus(), now: () => "2026-05-01T00:00:00.000Z", idFactory: () => `id-${++n}` };
});
afterEach(() => { closeDatabase(); resetPreparedStatements(); resetProjStmts(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const compositionFacet: CompositionFacet = {
  childRunId: "run-child-1",
  childTemplateId: "tpl-abc",
  childTemplateVersion: 1,
  readsKeys: ["context.goal"],
  writesKeys: ["output.result"],
  depth: 1,
  costRollupUsd: 0.05,
};

describe("emitDelegateSpawn / emitDelegateJoin", () => {
  it("emitDelegateSpawn records delegate_spawn boundary with composition facet round-tripped from DB", () => {
    seedGoal(db, "g1");
    emitDelegateSpawn(ctx, { goalId: "g1", workflowRunId: "r1", composition: compositionFacet });
    const items = listTransitionsByGoal(db, "g1");
    expect(items).toHaveLength(1);
    expect(items[0]!.boundary).toBe("delegate_spawn");
    expect(items[0]!.composition).toEqual(compositionFacet);
  });

  it("emitDelegateJoin records delegate_join boundary with composition facet round-tripped from DB", () => {
    seedGoal(db, "g1");
    emitDelegateJoin(ctx, { goalId: "g1", workflowRunId: "r1", composition: compositionFacet });
    const items = listTransitionsByGoal(db, "g1");
    expect(items).toHaveLength(1);
    expect(items[0]!.boundary).toBe("delegate_join");
    expect(items[0]!.composition).toEqual(compositionFacet);
  });

  it("emitDelegateSpawn accepts null workflowStepRunId (no step run for delegate boundaries)", () => {
    seedGoal(db, "g1");
    emitDelegateSpawn(ctx, { goalId: "g1", workflowRunId: "r1", workflowStepRunId: null, composition: compositionFacet });
    const items = listTransitionsByGoal(db, "g1");
    expect(items[0]!.workflowStepRunId).toBeNull();
    expect(items[0]!.composition!.childRunId).toBe("run-child-1");
  });
});
