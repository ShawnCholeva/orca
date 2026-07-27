import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { getTemplateMetricsDetail } from "./usecases.js";

// Real DB→graph→deriveVindication→predicate→StepMetrics.vindication chain (Task 3
// wiring), including the same version-safety rule as gate credit (usecases.gate.test.ts):
// only latest-version gate/split decisions feed the derivation, and only latest-version
// completions get labeled — an older-version run's completion is credited to neither
// bucket. This is purely observational: it must not move score/band/calibration.
describe("getTemplateMetricsDetail — vindication end-to-end (Task 3 wiring + version safety)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  const ROW_AT = "2026-07-16T12:00:00.000Z"; // step completion's created_at
  const GATE_AT = "2026-07-16T12:00:01.000Z"; // gate decision's created_at — strictly AFTER the completion
  const AFTER = "2026-07-17T00:00:00.000Z"; // query's nowIso (window upper bound is exclusive)
  // Graph: proposal --> critique(gate) --approved--> execution; --rejected--> proposal.
  // deriveVindication resolves "proposal"'s sole downstream node as "critique" and
  // reads the next gate decision on it after the step's completion.
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
    ).run(id, runId, GATE_AT);
  }

  it("an APPROVED gate decision on the latest version vindicates its upstream step's completion", () => {
    seedTemplate(2);
    seedRun("r1", 2); // latest version
    seedGateDecision("gd1", "r1");

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const proposal = detail!.steps.find((s) => s.stepTemplateId === "proposal");
    expect(proposal).toBeDefined();
    expect(proposal!.vindication).toEqual({ vindicated: 1, bounced: 0, pending: 0 });
  });

  it("VERSION SAFETY: an OLDER template version's completion is not counted toward vindication", () => {
    seedTemplate(2); // current graph_json reflects version 2's (only) topology
    seedRun("r1", 1); // run on the OLDER version 1 — reuses node id "proposal"/"critique"
    seedGateDecision("gd1", "r1"); // decision's templateVersion (via join) is 1, not latest

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const proposal = detail!.steps.find((s) => s.stepTemplateId === "proposal");
    expect(proposal).toBeDefined();
    // Without the version-safety filter, the (latest-topology) "critique" gate decision
    // would vindicate this older-version completion (vindicated: 1). With it, the
    // predicate returns "excluded" for the version-mismatched completion (Task 3: split
    // out of "pending") — it counts toward NEITHER bucket, not even pending.
    expect(proposal!.vindication).toEqual({ vindicated: 0, bounced: 0, pending: 0 });
  });
});

// Real DB→graph→deriveVindication→computeCalibration→effectiveSourceConfidence→
// composedScore chain (Task 3: calibration is now load-bearing on the score), including
// the same version-safety rule proven above — now proven at the CALIBRATION level, not
// just the display tally.
describe("getTemplateMetricsDetail — independent_review calibration is load-bearing on the score (Task 3 E2E)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  const ROW_AT = "2026-07-16T12:00:00.000Z";
  const GATE_AT = "2026-07-16T12:00:01.000Z";
  const AFTER = "2026-07-17T00:00:00.000Z";
  // Graph: execution --> critique(worker gate). Each "execution" completion is
  // refute-upheld (ai_reviewed, independent_review-passing on its OWN merits — NOT via
  // gate approval), so it enters both the score's independentReview credit and
  // computeCalibration's independent_review bucket regardless of what "critique" later
  // decides. "critique" is what supplies the DOWNSTREAM vindication label: approved →
  // vindicated, rejected → bounced. evalSubstrate "worker" → vindicatorWeight 0.55.
  const graphJson = JSON.stringify({
    nodes: [
      { id: "execution", type: "step", name: "Execution", stepId: "execution" },
      { id: "critique", type: "gate", name: "Critique", evalSubstrate: "worker" },
    ],
    edges: [{ from: "execution", to: "critique" }],
    positions: {},
  });
  const telemetryJson = JSON.stringify({
    cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null,
    prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
    outcome: { status: "succeeded", failure_code: null },
  });
  const refuteUpheldJson = JSON.stringify({ verdict: "upheld", triggered_by: [], risk_class: "low", reason: null, issue_refs: [] });

  function seedTemplate(latestVersion: number) {
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(ROW_AT, ROW_AT);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('tpl','T','',?,0,0,'[{"id":"execution","name":"Execution"}]','[]',?,?,?)`
    ).run(latestVersion, graphJson, ROW_AT, ROW_AT);
  }

  function seedCompletion(runId: string, templateVersion: number) {
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES (?,'g1','tpl',?,'completed',?,1)"
    ).run(runId, templateVersion, ROW_AT);
    const srId = `sr-${runId}`;
    db.prepare(
      `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
       VALUES (?,'g1',?,'execution',0,1,'passed','[]','[]',NULL,?,?,?)`
    ).run(srId, runId, ROW_AT, ROW_AT, `fp-${runId}`);
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, refute_json, state_deps_json, telemetry_json, created_at)
       VALUES (?,'g1',?,?,'step_complete',NULL,NULL,?,NULL,?,?)`
    ).run(`ht-${runId}`, runId, srId, refuteUpheldJson, telemetryJson, ROW_AT);
  }

  function seedGateDecision(id: string, runId: string, outcome: "approved" | "rejected") {
    db.prepare(
      `INSERT INTO workflow_gate_decisions
         (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, selected_edge_to,
          inputs_considered_json, issue_refs_json, ledger_version, created_at)
       VALUES (?,'g1',?,'critique',1,?,'ok','execution','[]','[]',0,?)`
    ).run(id, runId, outcome, GATE_AT);
  }

  it("mostly-bounced downstream (17 rejected / 2 approved, weight 0.55) calibrates independent_review down and the score reflects it", () => {
    seedTemplate(2);
    for (let i = 0; i < 19; i++) {
      const runId = `r${i}`;
      seedCompletion(runId, 2);
      seedGateDecision(`gd${i}`, runId, i < 17 ? "rejected" : "approved"); // 17 bounced, 2 vindicated
    }

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const step = detail!.steps.find((s) => s.stepTemplateId === "execution")!;
    expect(step).toBeDefined();
    expect(step.vindication).toEqual({ vindicated: 2, bounced: 17, pending: 0 });

    // alpha0=2.2, beta0=1.8 (prior 0.55, K=4); alpha=2*0.55=1.1, beta=17*0.55=9.35.
    // sampleSize = 10.45 (>= CALIBRATION_SCORE_MIN=10) -> measured applies to the score.
    const expectedMeasured = (2.2 + 1.1) / (4 + 10.45);
    const mix = step.quality.scoreBreakdown!.calibrationMix!.independent_review;
    expect(mix.state).toBe("measured");
    expect(mix.sampleSize).toBeCloseTo(10.45, 5);
    expect(mix.measured).toBeCloseTo(expectedMeasured, 5);
    // Every completion here scores as a single independent_review credit (no other
    // verifier passed), so the step's headline score equals the calibrated value.
    expect(step.score).toBe(Math.round(expectedMeasured * 100));
    expect(step.score).toBeLessThan(55); // calibrated below the raw prior
  });

  it("VERSION SAFETY: older-version gate decisions do not feed independent_review calibration", () => {
    seedTemplate(2);
    // Same latest-version (v2) bucket as above: 17 bounced / 2 vindicated, weight 0.55.
    for (let i = 0; i < 19; i++) {
      const runId = `r${i}`;
      seedCompletion(runId, 2);
      seedGateDecision(`gd${i}`, runId, i < 17 ? "rejected" : "approved");
    }
    // Older-version (v1) noise: 5 MORE completions, all APPROVED — if leaked into
    // calibration this would push alpha up by 5*0.55=2.75 (measured ~0.35 instead of
    // ~0.23) and the score up by ~12 points. The v1 run reuses the SAME node ids
    // ("execution"/"critique") under the current (v2-only) graph topology.
    for (let i = 0; i < 5; i++) {
      const runId = `ov${i}`;
      seedCompletion(runId, 1);
      seedGateDecision(`ogd${i}`, runId, "approved");
    }

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const step = detail!.steps.find((s) => s.stepTemplateId === "execution")!;
    expect(step).toBeDefined();
    // The 5 older-version completions are "excluded" from the display tally too —
    // vindicated/bounced/pending stay exactly the latest-version-only counts.
    expect(step.vindication).toEqual({ vindicated: 2, bounced: 17, pending: 0 });

    const expectedMeasured = (2.2 + 1.1) / (4 + 10.45);
    const mix = step.quality.scoreBreakdown!.calibrationMix!.independent_review;
    // Unaffected by the older-version noise — sampleSize/measured identical to the
    // no-noise scenario above, NOT the leaked 13.2 / ~0.35.
    expect(mix.sampleSize).toBeCloseTo(10.45, 5);
    expect(mix.measured).toBeCloseTo(expectedMeasured, 5);
    expect(step.score).toBe(Math.round(expectedMeasured * 100));
  });
});
