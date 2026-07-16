import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { getTemplateMetricsDetail } from "./usecases.js";

const NOW = "2026-07-16T12:00:00.000Z";

describe("getTemplateMetricsDetail — gates isolated from steps", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  it("excludes __gate__: rows from steps[] and returns them under gates[]", () => {
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('tpl','T','',1,0,0,'[]','[]',?,?,?)`
    ).run(
      JSON.stringify({ nodes: [{ id: "review", type: "gate", name: "Review", evalSubstrate: "shadow" }], edges: [] }),
      NOW,
      NOW
    );
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES ('r1','g1','tpl',1,'active',?,1)"
    ).run(NOW);
    db.prepare(
      `INSERT INTO workflow_gate_decisions
         (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, selected_edge_to,
          inputs_considered_json, issue_refs_json, ledger_version, created_at)
       VALUES ('d1','g1','r1','review',1,'approved','ok','next','[]','[]',0,?)`
    ).run(NOW);

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", "2026-07-17T00:00:00.000Z");
    expect(detail).not.toBeNull();
    expect(detail!.steps.some((s) => s.stepTemplateId.startsWith("__gate__:"))).toBe(false);
    expect(detail!.gates.map((g) => g.name)).toContain("Review");
    expect(detail!.policyGateway.decisionDist).toBeDefined();
    expect(detail!.summary.gateHealth).toBeDefined();
  });
});
