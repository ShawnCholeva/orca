import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { HarnessTransition, StateDepsFacet } from "@orca/contracts";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { insertTransition } from "../harness-transitions/projection.js";
import { buildGoalWriteSetRollup } from "./write-set-rollup.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-rollup-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  db.pragma("foreign_keys = OFF");
  return db;
}

let seq = 0;
function seedStepComplete(
  db: Database.Database,
  opts: { id: string; goalId: string; runId: string; createdAt: string; boundary?: string; writeSet: StateDepsFacet["write_set"] }
): void {
  const t: HarnessTransition = {
    id: opts.id,
    goalId: opts.goalId,
    workflowRunId: opts.runId,
    workflowStepRunId: `sr-${seq++}`,
    boundary: (opts.boundary ?? "step_complete") as HarnessTransition["boundary"],
    risk: null,
    evidence: null,
    stateDeps: {
      read_set: [],
      write_set: opts.writeSet,
      assumptions: [],
      version_deps: [],
      conflict_policy: "escalate",
      conflicts: [],
    },
    telemetry: null,
    createdAt: opts.createdAt,
  };
  insertTransition(db, t);
}

describe("buildGoalWriteSetRollup", () => {
  it("unions the run's step_complete write_sets, deduped by kind:ref (latest change wins)", () => {
    const db = setupDb();
    // Step 1 (earlier): created src/a.ts + a memory item.
    seedStepComplete(db, {
      id: "t1", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:01:00.000Z",
      writeSet: [
        { kind: "file", ref: "src/a.ts", change_kind: "created" },
        { kind: "memory_item", ref: "m1", change_kind: "created" },
      ],
    });
    // Step 2 (later): modified src/a.ts (same ref → dedup, latest wins) + created src/b.ts.
    seedStepComplete(db, {
      id: "t2", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:02:00.000Z",
      writeSet: [
        { kind: "file", ref: "src/a.ts", change_kind: "modified" },
        { kind: "file", ref: "src/b.ts", change_kind: "created" },
      ],
    });

    const facet = buildGoalWriteSetRollup(db, "g1", "run1");

    expect(facet.write_set).toContainEqual({ kind: "file", ref: "src/a.ts", change_kind: "modified" });
    expect(facet.write_set).toContainEqual({ kind: "file", ref: "src/b.ts", change_kind: "created" });
    expect(facet.write_set).toContainEqual({ kind: "memory_item", ref: "m1", change_kind: "created" });
    // src/a.ts appears exactly once (deduped).
    expect(facet.write_set.filter((w) => w.kind === "file" && w.ref === "src/a.ts")).toHaveLength(1);
  });

  it("excludes other runs and non-step_complete boundaries", () => {
    const db = setupDb();
    seedStepComplete(db, {
      id: "t1", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:01:00.000Z",
      writeSet: [{ kind: "file", ref: "in-run.ts", change_kind: "created" }],
    });
    // A different run on the same goal.
    seedStepComplete(db, {
      id: "t2", goalId: "g1", runId: "run2", createdAt: "2026-06-26T00:02:00.000Z",
      writeSet: [{ kind: "file", ref: "other-run.ts", change_kind: "created" }],
    });
    // A step_launch (not a completion) in the run.
    seedStepComplete(db, {
      id: "t3", goalId: "g1", runId: "run1", createdAt: "2026-06-26T00:03:00.000Z", boundary: "step_launch",
      writeSet: [{ kind: "file", ref: "launch.ts", change_kind: "created" }],
    });

    const facet = buildGoalWriteSetRollup(db, "g1", "run1");

    expect(facet.write_set).toEqual([{ kind: "file", ref: "in-run.ts", change_kind: "created" }]);
  });
});
