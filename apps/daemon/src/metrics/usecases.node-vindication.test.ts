import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { getTemplateMetricsDetail } from "./usecases.js";

// Real DB -> graph -> deriveGateVindication/deriveSplitterVindication -> buildGateMetrics/
// buildSplitterMetrics -> TemplateMetricsDetail.gates[].decisionConfidence /
// .splitters[] chain (Task 4 wiring), including the same version-safety rule as gate
// credit / downstream-vindication (usecases.gate.test.ts / usecases.vindication.test.ts):
// only latest-version gate/split decisions feed the derivation. This is purely
// observational (advisory Metrics-tab signal) — it must not move step scores.
describe("getTemplateMetricsDetail — gate decisionConfidence end-to-end (Task 4 wiring)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  const BASE = "2026-07-16T12:00:00.000Z";
  const AFTER_DECISION = "2026-07-16T12:00:01.000Z"; // mark_done / terminal-failure timestamp, strictly after the decision
  const AFTER = "2026-07-17T00:00:00.000Z"; // query's nowIso (window upper bound is exclusive)

  // critique(gate, worker) --approved--> execution(step, terminal).
  const graphJson = JSON.stringify({
    nodes: [
      { id: "critique", type: "gate", name: "Critique", evalSubstrate: "worker" },
      { id: "execution", type: "step", name: "Execution", stepId: "execution", terminal: true },
    ],
    edges: [{ from: "critique", to: "execution", port: "approved" }],
    positions: {},
  });

  function seedTemplate(latestVersion: number) {
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(BASE, BASE);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('tpl','T','',?,0,0,'[]','[]',?,?,?)`
    ).run(latestVersion, graphJson, BASE, BASE);
  }

  function seedRun(runId: string, templateVersion: number) {
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES (?,'g1','tpl',?,'completed',?,1)"
    ).run(runId, templateVersion, BASE);
  }

  function seedApproval(id: string, runId: string) {
    db.prepare(
      `INSERT INTO workflow_gate_decisions
         (id, goal_id, workflow_run_id, node_id, traversal_seq, outcome, reason, selected_edge_to,
          inputs_considered_json, issue_refs_json, ledger_version, created_at)
       VALUES (?,'g1',?,'critique',1,'approved','ok','execution','[]','[]',0,?)`
    ).run(id, runId, BASE);
  }

  // Vindicated: the run reaches mark_done after the approval.
  function seedMarkDone(runId: string) {
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?,'g1',?,NULL,'mark_done',NULL,NULL,NULL,NULL,?)`
    ).run(`ht-done-${runId}`, runId, AFTER_DECISION);
  }

  // False-accept: the run terminally fails (hard-fail step_complete) after the approval, no mark_done.
  function seedTerminalFailure(runId: string) {
    const telemetryJson = JSON.stringify({
      cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null,
      prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
      outcome: { status: "failed", failure_code: null },
    });
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?,'g1',?,NULL,'step_complete',NULL,NULL,NULL,?,?)`
    ).run(`ht-fail-${runId}`, runId, telemetryJson, AFTER_DECISION);
  }

  it("mostly vindicated approvals (mark_done) ⇒ decisionConfidence high, 'measured' once sampleSize meets the floor", () => {
    seedTemplate(2);
    for (let i = 0; i < 4; i++) {
      const runId = `rv${i}`;
      seedRun(runId, 2);
      seedApproval(`gdv${i}`, runId);
      seedMarkDone(runId);
    }
    seedRun("rf0", 2);
    seedApproval("gdf0", "rf0");
    seedTerminalFailure("rf0");

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const gate = detail!.gates.find((g) => g.nodeId === "critique");
    expect(gate).toBeDefined();
    expect(gate!.decisionConfidence.sampleSize).toBe(5); // 4 vindicated + 1 false_accept, all labeled
    expect(gate!.decisionConfidence.state).toBe("measured"); // 5 >= NODE_CONFIDENCE_MIN(5)
    // Beta(prior=0.7 worker, K=4) posterior mean with pos=4, neg=1: (0.7*4+4)/(4+5) = 6.8/9.
    expect(gate!.decisionConfidence.value).toBeCloseTo((0.7 * 4 + 4) / (4 + 5), 10);
  });

  it("mostly false_accept approvals (terminal failure, no mark_done) ⇒ decisionConfidence low", () => {
    seedTemplate(2);
    for (let i = 0; i < 4; i++) {
      const runId = `rf${i}`;
      seedRun(runId, 2);
      seedApproval(`gdf${i}`, runId);
      seedTerminalFailure(runId);
    }
    seedRun("rv0", 2);
    seedApproval("gdv0", "rv0");
    seedMarkDone("rv0");

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const gate = detail!.gates.find((g) => g.nodeId === "critique");
    expect(gate).toBeDefined();
    expect(gate!.decisionConfidence.sampleSize).toBe(5);
    // pos=1, neg=4: (0.7*4+1)/(4+5) = 3.8/9.
    expect(gate!.decisionConfidence.value).toBeCloseTo((0.7 * 4 + 1) / (4 + 5), 10);
    expect(gate!.decisionConfidence.value!).toBeLessThan(0.5);
  });

  it("VERSION SAFETY: an older-version approval's false_accept does not leak into the latest version's decisionConfidence", () => {
    seedTemplate(2); // current graph_json reflects version 2's (only) topology
    for (let i = 0; i < 4; i++) {
      const runId = `rv${i}`;
      seedRun(runId, 2);
      seedApproval(`gdv${i}`, runId);
      seedMarkDone(runId);
    }
    // Older-version noise: an approval that terminally fails, on a run at version 1 —
    // reuses the SAME node id ("critique") under the current (v2-only) graph topology.
    // If it leaked in, sampleSize would be 5 and pos/neg 4/1 instead of 4/0.
    seedRun("rold", 1);
    seedApproval("gdold", "rold");
    seedTerminalFailure("rold");

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const gate = detail!.gates.find((g) => g.nodeId === "critique");
    expect(gate).toBeDefined();
    expect(gate!.decisionConfidence.sampleSize).toBe(4); // unaffected by the older-version run
    expect(gate!.decisionConfidence.value).toBeCloseTo((0.7 * 4 + 4) / (4 + 4), 10);
  });
});

// Phase 4 (confidence reason): a step credited ONLY via gate approval (independent
// review), whose completion is not yet vindicated downstream (no mark_done/terminal
// outcome after the gate's decision), surfaces weak_verifier naming the gate — and,
// critically, the score is IDENTICAL to the pre-Phase-4 value (usecases.gate.test.ts's
// "credits its reviewed step's score (~55)" fixture): this is display-only, it must not
// move the score. Forcing requiresExecution=true on the step (via a validation_rule
// guardrail) makes the band "weak" (ceiling-relative: review alone can't meet an
// execution ceiling) without touching composedScore's inputs at all.
describe("getTemplateMetricsDetail — confidenceReason end-to-end (Phase 4, display-only)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  const ROW_AT = "2026-07-16T12:00:00.000Z";
  const AFTER = "2026-07-17T00:00:00.000Z";
  // Graph: proposal --> critique(gate) --approved--> execution; --rejected--> proposal.
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
  // Bare self-report evidence (no sensors, no grounding, no refute) — gate credit is
  // the only thing that establishes a score for it.
  const selfReportEvidenceJson = JSON.stringify({
    sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
    oracleAdequacy: { sufficient: false, gaps: ["no integration test"] },
  });
  const telemetryJson = JSON.stringify({
    cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null,
    prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
    outcome: { status: "succeeded", failure_code: null },
  });
  const guardrailsJson = JSON.stringify([
    { id: "validation_required", kind: "validation_rule", label: "Require tests", configJson: { appliesToSteps: ["proposal"], required: ["unit_tests"] } },
  ]);

  function seedTemplate() {
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(ROW_AT, ROW_AT);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('tpl','T','',2,0,0,'[{"id":"proposal","name":"Proposal"}]',?,?,?,?)`
    ).run(guardrailsJson, graphJson, ROW_AT, ROW_AT);
  }

  function seedRun(runId: string) {
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES (?,'g1','tpl',2,'completed',?,1)"
    ).run(runId, ROW_AT);
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

  it("surfaces weak_verifier naming the gate, without moving the score", () => {
    seedTemplate();
    seedRun("r1");
    seedGateDecision("gd1", "r1");

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const proposal = detail!.steps.find((s) => s.stepTemplateId === "proposal");
    expect(proposal).toBeDefined();
    // Same value as usecases.gate.test.ts's un-gated-execution fixture — gate credit
    // (independent_review confidence 0.55, full coverage) establishes it at 55,
    // regardless of confidenceReason derivation running alongside it.
    expect(proposal!.score).toBe(55);
    expect(proposal!.confidenceReason).toEqual({ code: "weak_verifier", nodeName: "Critique" });
  });

  // M1: independent_review credit can come from a refute-upheld pass, not only a gate
  // approval (composed-score.ts: `independentReview = sp.independentReview || gateApproved`).
  // A review-verified step whose downstream gate never approved must NOT be labelled
  // "Critique approved this…" — verifyingGateNameByStep is gated on real approvals, so the
  // gate is never named here (contrast the gate-approved case above, which IS named).
  function seedRunRefuteUpheld(runId: string) {
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES (?,'g1','tpl',2,'completed',?,1)"
    ).run(runId, ROW_AT);
    const srId = `sr-${runId}`;
    db.prepare(
      `INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint)
       VALUES (?,'g1',?,'proposal',0,1,'passed','[]','[]',NULL,?,?,?)`
    ).run(srId, runId, ROW_AT, ROW_AT, `fp-${runId}`);
    // evidence NULL + refute upheld ⇒ conclusive, independent_review-verified, no gate approval.
    const refuteUpheldJson = JSON.stringify({
      verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: "held", issue_refs: [],
    });
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, refute_json, state_deps_json, telemetry_json, created_at)
       VALUES (?,'g1',?,?,'step_complete',NULL,NULL,?,NULL,?,?)`
    ).run(`ht-${runId}`, runId, srId, refuteUpheldJson, telemetryJson, ROW_AT);
  }

  it("does NOT name the gate when review credit came from a refute pass, not a gate approval (M1)", () => {
    seedTemplate();
    seedRunRefuteUpheld("r2"); // NO gate decision → proposal not in `approvals`

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    const proposal = detail!.steps.find((s) => s.stepTemplateId === "proposal");
    expect(proposal).toBeDefined();
    // Non-triviality: the refute pass DID establish an independent-review score (not a
    // coverage gap) — so `onlyReview` is true and, without the approvals guard, this
    // would render weak_verifier / "Critique".
    expect(proposal!.score).not.toBeNull();
    expect(proposal!.confidenceReason?.code).not.toBe("no_check_yet");
    // The truthful property: the gate is never falsely named.
    expect(proposal!.confidenceReason?.code).not.toBe("weak_verifier");
    expect(proposal!.confidenceReason?.nodeName).toBeUndefined();
  });
});

// Real DB -> graph -> deriveSplitterVindication -> buildSplitterMetrics ->
// TemplateMetricsDetail.splitters[] chain (Task 4 wiring), plus the attributedToNodeId
// identity fix (Task 4, own commit): the upstream decision-maker step's stepId, not the
// raw graph node id.
describe("getTemplateMetricsDetail — splitter misrouteRate end-to-end (Task 4 wiring)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
  });

  const BASE = "2026-07-16T12:00:00.000Z";
  const REDECISION_AT = "2026-07-16T12:00:01.000Z"; // second split decision, strictly after the first
  const AFTER_DECISION = "2026-07-16T12:00:01.000Z";
  const AFTER = "2026-07-17T00:00:00.000Z";

  // triage(step, id "triage-node" / stepId "triage") --> route(deterministic splitter) --> fast|slow (steps).
  // The predecessor step's node id deliberately differs from its stepId, to also exercise
  // the attributedToNodeId identity fix through the real DB->graph path.
  const graphJson = JSON.stringify({
    nodes: [
      { id: "triage-node", type: "step", name: "Triage", stepId: "triage" },
      { id: "route", type: "splitter", name: "Route", branchKey: "tier" },
      { id: "fast", type: "step", name: "Fast", stepId: "fast", terminal: true },
      { id: "slow", type: "step", name: "Slow", stepId: "slow", terminal: true },
    ],
    edges: [
      { from: "triage-node", to: "route" },
      { from: "route", to: "fast", port: "fast" },
      { from: "route", to: "slow", port: "slow" },
    ],
    positions: {},
  });

  function seedTemplate(latestVersion: number) {
    db.prepare(
      "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at) VALUES ('g1','G','','active',1,?,?)"
    ).run(BASE, BASE);
    db.prepare(
      `INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, graph_json, created_at, updated_at)
       VALUES ('tpl','T','',?,0,0,'[]','[]',?,?,?)`
    ).run(latestVersion, graphJson, BASE, BASE);
  }

  function seedRun(runId: string, templateVersion: number) {
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at, traversal_seq) VALUES (?,'g1','tpl',?,'completed',?,1)"
    ).run(runId, templateVersion, BASE);
  }

  function seedSplit(id: string, runId: string, traversalSeq: number, branch: string, at: string) {
    db.prepare(
      `INSERT INTO workflow_split_decisions
         (id, goal_id, workflow_run_id, node_id, traversal_seq, selected_branch, reason, selected_edge_to,
          inputs_considered_json, ledger_version, created_at)
       VALUES (?,'g1',?,'route',?,?,'x',?,'[]',0,?)`
    ).run(id, runId, traversalSeq, branch, branch, at);
  }

  function seedMarkDone(runId: string) {
    db.prepare(
      `INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, evidence_json, state_deps_json, telemetry_json, created_at)
       VALUES (?,'g1',?,NULL,'mark_done',NULL,NULL,NULL,NULL,?)`
    ).run(`ht-done-${runId}`, runId, AFTER_DECISION);
  }

  it("a re-decision (same run/node, different branch) misroutes the first decision ⇒ misrouteRate > 0, attributedToNodeId is the predecessor's stepId", () => {
    seedTemplate(2);
    // r1: routed 'fast' at t1, then re-decided to 'slow' at t2 — the FIRST decision is
    // walked back (false_accept / misroute). The second decision has no later re-decision
    // or terminal outcome ⇒ pending (unlabeled, excluded from the tally).
    seedRun("r1", 2);
    seedSplit("sd1", "r1", 1, "fast", BASE);
    seedSplit("sd2", "r1", 2, "slow", REDECISION_AT);
    // r2: routed once, run reaches mark_done ⇒ vindicated.
    seedRun("r2", 2);
    seedSplit("sd3", "r2", 1, "fast", BASE);
    seedMarkDone("r2");

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const splitter = detail!.splitters.find((s) => s.nodeId === "route");
    expect(splitter).toBeDefined();
    expect(splitter!.decisions).toBe(3); // sd1, sd2, sd3 all counted
    expect(splitter!.confidence.sampleSize).toBe(2); // sd1 (false_accept) + sd3 (vindicated); sd2 pending, excluded
    expect(splitter!.misrouteRate).toBeCloseTo(0.5, 5); // 1 false_accept / 2 labeled
    expect(splitter!.misrouteRate).toBeGreaterThan(0);
    expect(splitter!.retrospectiveOnly).toBe(true);
    // Task 4 identity fix: attributedToNodeId is the predecessor's stepId ("triage"),
    // not its raw graph node id ("triage-node").
    expect(splitter!.deterministic).toBe(true);
    expect(splitter!.attributedToNodeId).toBe("triage");
  });

  it("VERSION SAFETY: an older-version split decision does not leak into the latest version's misrouteRate", () => {
    seedTemplate(2);
    seedRun("r1", 2);
    seedSplit("sd1", "r1", 1, "fast", BASE);
    seedSplit("sd2", "r1", 2, "slow", REDECISION_AT); // r1's sd1 is a misroute (false_accept)
    seedRun("r2", 2);
    seedSplit("sd3", "r2", 1, "fast", BASE);
    seedMarkDone("r2"); // r2's sd3 is vindicated

    // Older-version noise: a run on version 1 whose split decision would also misroute if
    // it leaked in under the current (v2-only) graph topology.
    seedRun("rold", 1);
    seedSplit("sdold1", "rold", 1, "fast", BASE);
    seedSplit("sdold2", "rold", 2, "slow", REDECISION_AT);

    const detail = getTemplateMetricsDetail(db, "tpl", "7d", AFTER);
    expect(detail).not.toBeNull();
    const splitter = detail!.splitters.find((s) => s.nodeId === "route");
    expect(splitter).toBeDefined();
    // Unaffected by the older-version run — same as the no-noise scenario above.
    expect(splitter!.decisions).toBe(3); // sd1, sd2, sd3 (sdold1, sdold2 excluded as v1)
    expect(splitter!.confidence.sampleSize).toBe(2);
    expect(splitter!.misrouteRate).toBeCloseTo(0.5, 5);
  });
});
