import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { buildJudgeCorpus } from "./corpus.js";
import type { TemplateInstructionProposal } from "@orca/contracts";

function schema(db: Database.Database) {
  db.exec(`
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, template_id TEXT);
    CREATE TABLE workflow_step_runs (id TEXT PRIMARY KEY, workflow_run_id TEXT, step_template_id TEXT);
    CREATE TABLE workflow_artifacts (id TEXT PRIMARY KEY, workflow_run_id TEXT, step_run_id TEXT, type TEXT, body TEXT, created_at TEXT);
    CREATE TABLE harness_transitions (id TEXT PRIMARY KEY, workflow_step_run_id TEXT, boundary TEXT, evidence_json TEXT, refute_json TEXT, created_at TEXT);
    CREATE TABLE step_revision_signals (id TEXT PRIMARY KEY, step_run_id TEXT);
  `);
}
function stepRun(db: Database.Database, runId: string, srId: string, tpl: string, stTpl: string) {
  db.prepare("INSERT OR IGNORE INTO workflow_runs (id, template_id) VALUES (?,?)").run(runId, tpl);
  db.prepare("INSERT INTO workflow_step_runs (id, workflow_run_id, step_template_id) VALUES (?,?,?)").run(srId, runId, stTpl);
}
function artifact(db: Database.Database, runId: string, srId: string, body: string, at: string) {
  db.prepare("INSERT INTO workflow_artifacts (id, workflow_run_id, step_run_id, type, body, created_at) VALUES (?,?,?,?,?,?)")
    .run(`a-${srId}-${at}`, runId, srId, "step_output", body, at);
}
function stepComplete(db: Database.Database, srId: string, evidence: unknown, refute: unknown) {
  db.prepare("INSERT INTO harness_transitions (id, workflow_step_run_id, boundary, evidence_json, refute_json, created_at) VALUES (?,?,?,?,?,?)")
    .run(`ht-${srId}`, srId, "step_complete", evidence ? JSON.stringify(evidence) : null, refute ? JSON.stringify(refute) : null, "2026-07-01T00:00:00.000Z");
}
// Like stepComplete, but writes the raw refute_json string verbatim (for malformed/corrupt-shape fixtures).
function stepCompleteRawRefute(db: Database.Database, srId: string, evidence: unknown, rawRefuteJson: string) {
  db.prepare("INSERT INTO harness_transitions (id, workflow_step_run_id, boundary, evidence_json, refute_json, created_at) VALUES (?,?,?,?,?,?)")
    .run(`ht-${srId}`, srId, "step_complete", evidence ? JSON.stringify(evidence) : null, rawRefuteJson, "2026-07-01T00:00:00.000Z");
}
const passedEvidence = { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } };
const upheldRefute = { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] };
const refutedRefute = { verdict: "refuted", triggered_by: ["no_oracle"], risk_class: "low", reason: "bad", issue_refs: ["x"] };

function proposal(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return { id: "p1", templateId: "t1", templateVersionAtProposal: 1, stepTemplateId: "st1",
    component: "step_instructions", beforeInstructions: "a", afterInstructions: "b",
    targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: [], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending", createdAt: "2026-07-01T00:00:00.000Z",
    decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over };
}

describe("buildJudgeCorpus", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); schema(db); });

  it("buckets solved cases by refute-upheld primary / evidence-passed fallback", () => {
    stepRun(db, "r1", "sr-upheld", "t1", "st1"); artifact(db, "r1", "sr-upheld", "{\"ok\":1}", "2026-07-02T00:00:00.000Z"); stepComplete(db, "sr-upheld", null, upheldRefute);
    stepRun(db, "r2", "sr-passed", "t1", "st1"); artifact(db, "r2", "sr-passed", "{\"ok\":2}", "2026-07-02T00:00:00.000Z"); stepComplete(db, "sr-passed", passedEvidence, null);
    stepRun(db, "r3", "sr-refuted", "t1", "st1"); artifact(db, "r3", "sr-refuted", "{\"bad\":1}", "2026-07-02T00:00:00.000Z"); stepComplete(db, "sr-refuted", passedEvidence, refutedRefute);
    const c = buildJudgeCorpus(db, proposal());
    const ids = c.solved.map((s) => s.stepRunId).sort();
    expect(ids).toEqual(["sr-passed", "sr-upheld"]); // refuted excluded even though evidence passed (refute primary)
  });

  it("resolves failure bucket from the proposal's sampleTransitionIds (earliest attempt) and excludes them from solved", () => {
    stepRun(db, "r1", "sr-fail", "t1", "st1");
    artifact(db, "r1", "sr-fail", "{\"attempt\":1}", "2026-07-02T00:00:00.000Z"); // earliest = the failing one
    artifact(db, "r1", "sr-fail", "{\"attempt\":2}", "2026-07-03T00:00:00.000Z");
    stepComplete(db, "sr-fail", passedEvidence, null); // later succeeded, but it's the diagnosed failure case
    const c = buildJudgeCorpus(db, proposal({ evidence: { sampleTransitionIds: ["ht-sr-fail"], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } } }));
    expect(c.failure).toEqual([{ stepRunId: "sr-fail", output: "{\"attempt\":1}" }]);
    expect(c.solved.some((s) => s.stepRunId === "sr-fail")).toBe(false);
  });

  it("resolves failure bucket from revisionSignalIds", () => {
    stepRun(db, "r1", "sr-rev", "t1", "st1"); artifact(db, "r1", "sr-rev", "{\"v\":1}", "2026-07-02T00:00:00.000Z");
    db.prepare("INSERT INTO step_revision_signals (id, step_run_id) VALUES (?,?)").run("sig1", "sr-rev");
    const c = buildJudgeCorpus(db, proposal({ evidence: { sampleTransitionIds: [], revisionSignalIds: ["sig1"], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } } }));
    expect(c.failure.map((f) => f.stepRunId)).toEqual(["sr-rev"]);
  });

  it("excludes a step run whose refute_json is present but malformed (non-JSON), even when evidence passed", () => {
    stepRun(db, "r1", "sr-malformed", "t1", "st1");
    artifact(db, "r1", "sr-malformed", "{\"ok\":1}", "2026-07-02T00:00:00.000Z");
    stepCompleteRawRefute(db, "sr-malformed", passedEvidence, "{not json");
    const c = buildJudgeCorpus(db, proposal());
    // must not throw, and must NOT fall through to the evidence-passed fallback: refute is present, so it's authoritative.
    expect(c.solved.some((s) => s.stepRunId === "sr-malformed")).toBe(false);
  });

  it("excludes a step run whose refute_json fails RefuteFacet shape validation, even when evidence passed", () => {
    stepRun(db, "r1", "sr-badshape", "t1", "st1");
    artifact(db, "r1", "sr-badshape", "{\"ok\":1}", "2026-07-02T00:00:00.000Z");
    stepCompleteRawRefute(db, "sr-badshape", passedEvidence, JSON.stringify({ triggered_by: ["x"] })); // missing required "verdict"
    const c = buildJudgeCorpus(db, proposal());
    expect(c.solved.some((s) => s.stepRunId === "sr-badshape")).toBe(false);
  });

  it("includes a step run with NULL refute_json and evidence.verdict='passed' (evidence fallback only applies when refute is absent)", () => {
    stepRun(db, "r1", "sr-passed-only", "t1", "st1");
    artifact(db, "r1", "sr-passed-only", "{\"ok\":1}", "2026-07-02T00:00:00.000Z");
    stepComplete(db, "sr-passed-only", passedEvidence, null);
    const c = buildJudgeCorpus(db, proposal());
    expect(c.solved.some((s) => s.stepRunId === "sr-passed-only")).toBe(true);
  });

  it("caps each bucket at K and clamps output length", () => {
    for (let i = 0; i < 7; i++) { stepRun(db, `r${i}`, `sr${i}`, "t1", "st1"); artifact(db, `r${i}`, `sr${i}`, "y".repeat(5000), `2026-07-0${i + 1}T00:00:00.000Z`); stepComplete(db, `sr${i}`, null, upheldRefute); }
    const c = buildJudgeCorpus(db, proposal());
    expect(c.solved.length).toBe(5);
    expect(c.solved[0].output.length).toBe(2000);
  });
});
