import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listGateDecisionsByTemplate } from "./fetch.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("listGateDecisionsByTemplate", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  it("returns gate-decision rows for a template within the window, newest fields intact", () => {
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
      `INSERT INTO workflow_gate_decisions
         (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, selected_edge_to,
          inputs_considered_json, issue_refs_json, created_at, recommended_outcome, recommended_reason)
       VALUES ('d1','g1','r1','review',1,'rejected','x','proposal','[]','["a"]',?, 'approved','looks done')`
    ).run(NOW);

    const rows = listGateDecisionsByTemplate(db, "tpl", "2026-07-15T00:00:00.000Z", "2026-07-17T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe("review");
    expect(rows[0].outcome).toBe("rejected");
    expect(rows[0].recommendedOutcome).toBe("approved");
    expect(rows[0].issueRefs).toEqual(["a"]);
  });
});
