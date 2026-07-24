import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listSplitDecisionsByTemplate } from "./fetch.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("listSplitDecisionsByTemplate", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  it("returns split-decision rows for a template within the window", () => {
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('tpl','T','',1,0,0,'[]','[]',?,?)"
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r1','g1','tpl',1,'active',?)"
    ).run(NOW);
    db.prepare(
      `INSERT INTO workflow_split_decisions
         (id, goal_id, workflow_run_id, node_id, traversal_seq, selected_branch, reason, selected_edge_to,
          inputs_considered_json, ledger_version, created_at)
       VALUES ('sd1','g1','r1','splitter',1,'branch-a','x','proposal','[]',0,?)`
    ).run(NOW);

    const rows = listSplitDecisionsByTemplate(db, "tpl", "2026-07-15T00:00:00.000Z", "2026-07-17T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "sd1",
      workflowRunId: "r1",
      nodeId: "splitter",
      traversalSeq: 1,
      selectedBranch: "branch-a",
      selectedEdgeTo: "proposal",
      createdAt: NOW,
      templateVersion: 1,
    });
  });
});
