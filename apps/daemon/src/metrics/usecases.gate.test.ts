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

// Real DB→graph→gateApprovalsByStep→predicate→score chain (Task 5 wiring), including
// the Critical version-safety fix: gate credit must resolve ONLY against latest-version
// decisions, unconditionally of the response's `scope`, because the current graph_json
// row is the LATEST version's topology only (templates are one row, overwritten on edit).
describe("getTemplateMetricsDetail — gate credit end-to-end (Task 5 wiring + version safety)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  const ROW_AT = "2026-07-16T12:00:00.000Z"; // row created_at, strictly BEFORE the query's `now`
  const AFTER = "2026-07-17T00:00:00.000Z"; // query's nowIso (window upper bound is exclusive)
  // Graph: proposal --> critique(gate) --approved--> execution; --rejected--> proposal.
  // gateApprovalsByStep resolves an approved "critique" decision to its sole step
  // predecessor "proposal" under THIS (current) topology.
  const graphJson = JSON.stringify({
    nodes: [
      { id: "proposal", type: "step", name: "Proposal", stepId: "proposal" },
      { id: "critique", type: "gate", name: "Critique", instructions: "x" },
      { id: "execution", type: "step", name: "Execution", stepId: "execution", terminal: true },
    ],
    edges: [
      { from: "proposal", to: "critique" },
      { from: "critique", to: "execution", port: "approved" },
      { from: "critique", to: "proposal", port: "rejected" },
    ],
    positions: {},
  });
  // Bare self-report evidence (no sensors, no grounding, no refute) — normally scores
  // null/unknown (see aggregate.steps.test.ts's selfReportTxs); gate credit is the only
  // thing that can establish a score for it here.
  const selfReportEvidenceJson = JSON.stringify({
    sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
    oracleAdequacy: { sufficient: false, gaps: ["no integration test"] },
  });
  const telemetryJson = JSON.stringify({
    cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null,
    prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
    outcome: { status: "succeeded", failure_code: null },
  });

  function seedTemplate(latestVersion: number) {
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(ROW_AT, ROW_AT);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('tpl','T','',?,0,0,'[{"id":"proposal","name":"Proposal"}]','[]',?,?,?)`
    ).run(latestVersion, graphJson, ROW_AT, ROW_AT);
  }

  function seedRun(runId: string, templateVersion: number) {
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES (?,'g1','tpl',?,'completed',?,1)"
    ).run(runId, templateVersion, ROW_AT);
    const srId = `sr-${runId}`;
    db.prepare(
      `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
       VALUES (?,'g1',?,'proposal',0,1,'passed','[]','[]',NULL,?,?,?)`
    ).run(srId, runId, ROW_AT, ROW_AT, `fp-${runId}`);
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?,'g1',?,?,'step_complete',NULL,?,NULL,?,?)`
    ).run(`ht-${runId}`, runId, srId, selfReportEvidenceJson, telemetryJson, ROW_AT);
  }

  function seedGateDecision(id: string, runId: string) {
    db.prepare(
      `INSERT INTO workflow_gate_decisions
         (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, selected_edge_to,
          inputs_considered_json, issue_refs_json, ledger_version, created_at)
       VALUES (?,'g1',?,'critique',1,'approved','ok','execution','[]','[]',0,?)`
    ).run(id, runId, ROW_AT);
  }

  it("an APPROVED gate decision on the latest version credits its reviewed step's score (~55)", () => {
    seedTemplate(2);
    seedRun("r1", 2); // latest version
    seedGateDecision("gd1", "r1");

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const proposal = detail!.steps.find((s) => s.stepTemplateId === "proposal");
    expect(proposal).toBeDefined();
    // Bare self-report alone would be null/unknown; gate credit (independent_review
    // confidence 0.55, full coverage) establishes it at 55.
    expect(proposal!.score).toBe(55);
  });

  it("VERSION SAFETY: a gate decision on an OLDER template version does NOT credit the current-version step", () => {
    seedTemplate(2); // current graph_json reflects version 2's (only) topology
    seedRun("r1", 1); // run on the OLDER version 1 — reuses node id "proposal"/"critique"
    seedGateDecision("gd1", "r1"); // decision's templateVersion (via join) is 1, not latest

    // scope="current" (default) still includes this older-version run's completion —
    // it's the join against the current-only graph that must be version-guarded, not
    // the run's inclusion in the window.
    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const proposal = detail!.steps.find((s) => s.stepTemplateId === "proposal");
    expect(proposal).toBeDefined();
    // Without the fix, gateApprovalsByStep would resolve "critique"'s current-graph
    // predecessor ("proposal") and mis-credit this older-version decision, scoring 55.
    // With the fix, the decision is filtered out before the join — score stays unknown.
    expect(proposal!.score).toBeNull();
  });
});
