import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { computeNodeLineage } from "./node-lineage.js";

const NOW = "2026-07-16T12:00:00.000Z";
const SINCE = "2026-07-01T00:00:00.000Z";
const UNTIL = "2026-07-17T00:00:00.000Z";

function snapshotJson(nodes: { id: string; type: string; name: string }[]) {
  return JSON.stringify({ graph: { nodes, edges: [] } });
}

describe("computeNodeLineage", () => {
  let db: Database.Database;
  let runSeq = 0;

  function insertRun(version: number, snapshot: string | null) {
    runSeq += 1;
    const id = `r${runSeq}`;
    db.prepare(
      `INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq, template_snapshot_json)
       VALUES (?, 'g1', 'tpl', ?, 'completed', ?, 1, ?)`
    ).run(id, version, NOW, snapshot);
    return id;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    runSeq = 0;
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at)
       VALUES ('tpl','T','',3,0,0,'[]','[]',?,?)`
    ).run(NOW, NOW);
  });

  it("derives changedFrom, renamedFrom, and eras for node x (step in v1, gate+renamed in v2-v3)", () => {
    // v1: node x is a step named "X" — 2 runs.
    insertRun(1, snapshotJson([{ id: "x", type: "step", name: "X" }]));
    insertRun(1, snapshotJson([{ id: "x", type: "step", name: "X" }]));
    // v2: node x is now a gate, still named "X" — 1 run.
    insertRun(2, snapshotJson([{ id: "x", type: "gate", name: "X" }]));
    // v3: node x is a gate, renamed to "X2" — 3 runs.
    insertRun(3, snapshotJson([{ id: "x", type: "gate", name: "X2" }]));
    insertRun(3, snapshotJson([{ id: "x", type: "gate", name: "X2" }]));
    insertRun(3, snapshotJson([{ id: "x", type: "gate", name: "X2" }]));

    const lineage = computeNodeLineage(db, "tpl", SINCE, UNTIL);
    const lin = lineage.get("x");
    expect(lin).toBeDefined();
    expect(lin!.changedFrom).toBe("step");
    expect(lin!.renamedFrom).toBe("X");
    expect(lin!.eras).toEqual([
      { type: "step", fromVersion: 1, toVersion: 1, runs: 2 },
      { type: "gate", fromVersion: 2, toVersion: 3, runs: 4 },
    ]);
  });

  it("returns no entry for a stable node (same type + name across versions)", () => {
    insertRun(1, snapshotJson([{ id: "y", type: "step", name: "Y" }]));
    insertRun(2, snapshotJson([{ id: "y", type: "step", name: "Y" }]));
    insertRun(3, snapshotJson([{ id: "y", type: "step", name: "Y" }]));

    const lineage = computeNodeLineage(db, "tpl", SINCE, UNTIL);
    expect(lineage.get("y")).toBeUndefined();
  });

  it("skips a malformed snapshot without throwing", () => {
    insertRun(1, snapshotJson([{ id: "x", type: "step", name: "X" }]));
    insertRun(2, "{not valid json");
    insertRun(3, snapshotJson([{ id: "x", type: "gate", name: "X" }]));

    expect(() => computeNodeLineage(db, "tpl", SINCE, UNTIL)).not.toThrow();
    const lin = computeNodeLineage(db, "tpl", SINCE, UNTIL).get("x");
    expect(lin).toBeDefined();
    expect(lin!.changedFrom).toBe("step");
    // v2's snapshot was skipped, so v1 (step) and v3 (gate) are the only observations —
    // still two eras even though v2's run count never enters the lineage.
    expect(lin!.eras.map((e) => e.type)).toEqual(["step", "gate"]);
  });

  it("skips a null/absent snapshot without throwing", () => {
    insertRun(1, null);
    expect(() => computeNodeLineage(db, "tpl", SINCE, UNTIL)).not.toThrow();
    expect(computeNodeLineage(db, "tpl", SINCE, UNTIL).size).toBe(0);
  });
});
