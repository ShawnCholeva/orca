import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { insertProposal, getProposal, updateProposalDecision } from "./store.js";
import { judgeProposal, type JudgeDeps } from "./usecases.js";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
import type { TemplateInstructionProposal } from "@orca/contracts";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-judge-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

const passedEvidence = { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } };
const refutedRefute = { verdict: "refuted", triggered_by: ["no_oracle"], risk_class: "low", reason: "bad", issue_refs: ["x"] };

function seedGoalAndRun(db: Database.Database) {
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g1','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-opus-4-8' WHERE id = 'g1'`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','T','',1,0,0,'[]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g1','tpl',1,'completed',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-07-01T01:00:00.000Z')`).run();
}

// Seeds one workflow_step_runs row + its step_output artifact + its step_complete
// harness_transition, in the shape buildJudgeCorpus / anchorForStep expect.
function seedStepCase(
  db: Database.Database,
  opts: { srId: string; stepTemplateId: string; ordinal: number; status: "passed" | "failed"; body: string; at: string; refute: unknown; evidence: unknown },
) {
  // attempt must be unique per (workflow_run_id, step_template_id) — derive it from ordinal
  // rather than hardcoding 1, since several cases here share the same step_template_id.
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES (?, 'g1','run1',?,?,?,?,'[]','[]',NULL,?,?,?)`)
    .run(opts.srId, opts.stepTemplateId, opts.ordinal, opts.ordinal + 1, opts.status, opts.at, opts.at, `fp-${opts.srId}`);
  db.prepare(`INSERT INTO workflow_artifacts (id,goal_id,workflow_run_id,step_run_id,type,title,body,source,created_at)
              VALUES (?, 'g1','run1',?, 'step_output','t',?, 'agent', ?)`)
    .run(`art-${opts.srId}`, opts.srId, opts.body, opts.at);
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,refute_json,created_at)
              VALUES (?, 'g1','run1',?, 'step_complete',NULL,?,NULL,NULL,?, ?)`)
    .run(`ht-${opts.srId}`, opts.srId,
      opts.evidence ? JSON.stringify(opts.evidence) : null,
      opts.refute ? JSON.stringify(opts.refute) : null,
      opts.at);
}

function proposalFixture(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "st1",
    component: "step_instructions", beforeInstructions: "before", afterInstructions: "after",
    targetedFailureMode: { rule: "R1", failureCode: null, clusterCount: null, signalCount: null },
    predictedImprovement: "x", invariantsPreserved: [],
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    rationale: "r", humanEdited: false, status: "pending", createdAt: "2026-07-01T00:00:00.000Z",
    decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over,
  };
}

function fakeAsk(text: string, seen: string[] = []): ShadowAsk {
  return { async ask(key) { seen.push(key); return { text }; } };
}
const PASS = JSON.stringify({ verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: ["s1"], reasoning: "solved cases hold; failure case addressed" });

describe("judgeProposal", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedGoalAndRun(db);
    // st1: two solved cases + two diagnosed failure cases -> both buckets satisfy the 2+2 MIN.
    seedStepCase(db, { srId: "sr-solved", stepTemplateId: "st1", ordinal: 0, status: "passed", body: "{\"ok\":1}", at: "2026-07-01T00:10:00.000Z", refute: null, evidence: passedEvidence });
    seedStepCase(db, { srId: "sr-solved2", stepTemplateId: "st1", ordinal: 1, status: "passed", body: "{\"ok\":2}", at: "2026-07-01T00:11:00.000Z", refute: null, evidence: passedEvidence });
    seedStepCase(db, { srId: "sr-fail", stepTemplateId: "st1", ordinal: 2, status: "failed", body: "{\"bad\":1}", at: "2026-07-01T00:20:00.000Z", refute: refutedRefute, evidence: null });
    seedStepCase(db, { srId: "sr-fail2", stepTemplateId: "st1", ordinal: 3, status: "failed", body: "{\"bad\":2}", at: "2026-07-01T00:21:00.000Z", refute: refutedRefute, evidence: null });
    insertProposal(db, proposalFixture({
      id: "p1", stepTemplateId: "st1",
      evidence: { sampleTransitionIds: ["ht-sr-fail", "ht-sr-fail2"], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    }));
  });

  afterEach(() => {
    closeDatabase();
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("persists a CounterfactualJudgment with engine-recorded case ids and returns the hydrated proposal", async () => {
    const terminated: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS), terminateShadow: (k) => { terminated.push(k); } };
    const p = await judgeProposal(deps, db, "p1");
    expect(p.judgment?.verdict).toBe("pass");
    expect(p.judgment?.solvedCaseIds.length).toBeGreaterThanOrEqual(1);
    expect(p.judgment?.failureCaseIds.length).toBeGreaterThanOrEqual(1);
    expect(p.judgment?.judgedAgainstVersion).toBe(p.templateVersionAtProposal);
    expect(p.judgment?.reasoning).toBe("solved cases hold; failure case addressed");
    expect(terminated).toEqual(["tpl::judge"]); // teardown per call
  });

  it("is idempotent — a second call makes no second shadow ask and returns the same judgment", async () => {
    const seen: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    await judgeProposal(deps, db, "p1");
    const before = getProposal(db, "p1")?.judgment;
    await judgeProposal(deps, db, "p1");
    expect(seen.length).toBe(1); // no second ask
    expect(getProposal(db, "p1")?.judgment).toEqual(before);
  });

  it("throws ProposalNotPendingError for a decided proposal (no shadow ask)", async () => {
    updateProposalDecision(db, "p1", { status: "applied", decidedAt: "2026-07-02T00:00:00.000Z", decidedBy: "owner", appliedAsVersion: 2 });
    const seen: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    await expect(judgeProposal(deps, db, "p1")).rejects.toThrow();
    expect(seen.length).toBe(0);
  });

  it("short-circuits to insufficient_evidence when a bucket is empty (no shadow ask)", async () => {
    // st2 has no seeded step runs at all -> both buckets are empty.
    insertProposal(db, proposalFixture({
      id: "p2", stepTemplateId: "st2",
      evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    }));
    const seen: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    const p = await judgeProposal(deps, db, "p2");
    expect(p.judgment?.verdict).toBe("insufficient_evidence");
    expect(p.judgment?.reasoning ?? null).toBeNull();
    expect(seen.length).toBe(0);
  });

  it("short-circuits to insufficient_evidence with only 1 solved + 1 failure case (below the 2+2 minimum)", async () => {
    // st4: exactly one solved case and one diagnosed failure case -> below FAILURE_MIN/SOLVED_MIN of 2.
    seedStepCase(db, { srId: "sr4-solved", stepTemplateId: "st4", ordinal: 0, status: "passed", body: "{\"ok\":1}", at: "2026-07-01T00:10:00.000Z", refute: null, evidence: passedEvidence });
    seedStepCase(db, { srId: "sr4-fail", stepTemplateId: "st4", ordinal: 1, status: "failed", body: "{\"bad\":1}", at: "2026-07-01T00:20:00.000Z", refute: refutedRefute, evidence: null });
    insertProposal(db, proposalFixture({
      id: "p4", stepTemplateId: "st4",
      evidence: { sampleTransitionIds: ["ht-sr4-fail"], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    }));
    const seen: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    const p = await judgeProposal(deps, db, "p4");
    expect(p.judgment?.verdict).toBe("insufficient_evidence");
    expect(p.judgment?.reasoning ?? null).toBeNull();
    expect(seen.length).toBe(0);
  });

  it("records unavailable when the shadow ask fails", async () => {
    const deps: JudgeDeps = { shadowAsk: { async ask() { throw new Error("down"); } }, terminateShadow: () => {} };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await judgeProposal(deps, db, "p1");
    expect(p.judgment?.verdict).toBe("unavailable");
    expect(p.judgment?.reasoning ?? null).toBeNull();
  });

  // Controller decision (aligned with commit 04d1b09 "degrade instead of throw when a request
  // payload is oversized"): the brief calls JudgeInstructionEditRequest.parse, which throws on
  // an oversized payload. Per repo convention, judgeProposal must degrade instead — this proves it.
  it("degrades to unavailable (no throw, no ask) when the judge request payload is oversized", async () => {
    // Each case body is 2000 chars of a 3-byte-UTF8 character (not valid JSON, so `compact()`
    // keeps it raw and clamps at OUTPUT_BUDGET=2000 chars = 6000 bytes). 5 solved + 2 failure
    // cases, plus two 8192-char instruction fields (24576 bytes each), blow well past the
    // 65536-byte ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES cap.
    const bigBody = "€".repeat(2000);
    const bigInstructions = "€".repeat(8192);
    for (let i = 0; i < 5; i++) {
      seedStepCase(db, {
        srId: `sr-big-${i}`, stepTemplateId: "st3", ordinal: i, status: "passed",
        body: bigBody, at: `2026-07-02T00:0${i}:00.000Z`, refute: null, evidence: passedEvidence,
      });
    }
    seedStepCase(db, {
      srId: "sr-big-fail", stepTemplateId: "st3", ordinal: 9, status: "failed",
      body: bigBody, at: "2026-07-02T00:09:00.000Z", refute: refutedRefute, evidence: null,
    });
    seedStepCase(db, {
      srId: "sr-big-fail2", stepTemplateId: "st3", ordinal: 10, status: "failed",
      body: bigBody, at: "2026-07-02T00:10:00.000Z", refute: refutedRefute, evidence: null,
    });
    insertProposal(db, proposalFixture({
      id: "p3", stepTemplateId: "st3", beforeInstructions: bigInstructions, afterInstructions: bigInstructions,
      evidence: { sampleTransitionIds: ["ht-sr-big-fail", "ht-sr-big-fail2"], revisionSignalIds: [], metricSnapshot: { score: 50, verdictPassRate: 0.5, oracleSufficientRate: 0.5, versionDelta: null } },
    }));
    const seen: string[] = [];
    const deps: JudgeDeps = { shadowAsk: fakeAsk(PASS, seen), terminateShadow: () => {} };
    const p = await judgeProposal(deps, db, "p3");
    expect(p.judgment?.verdict).toBe("unavailable");
    expect(seen.length).toBe(0); // no shadow ask — the request never got built
  });
});
