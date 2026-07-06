import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerLearningRoutes } from "./routes.js";
import type { BrokerLike } from "./propose.js";
import type { TemplateInstructionProposal } from "@orca/contracts";
import { insertProposal } from "./store.js";
import { recordEvent } from "./events.js";

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-routes-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}
// Seed a locked built-in with >= SAMPLE_MIN passing+failing step_complete transitions on step s1.
function seed(db: Database.Database) {
  // Anchor 7 days ago so harness_transitions are always inside the 30d analysis window.
  const anchorDay = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  // B resolves provider/model from the anchor run's goal — set them.
  db.prepare(`UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-opus-4-8' WHERE id = 'g'`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,1,'[{"id":"s1","name":"Generate","instructions":"Generate a proposal."}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'${anchorDay}T00:00:00.000Z','${anchorDay}T01:00:00.000Z')`).run();
  for (let i = 0; i < 6; i++) {
    const verdict = i < 2 ? "passed" : "failed";
    const status = verdict === "passed" ? "succeeded" : "failed";
    const fc = verdict === "passed" ? "null" : '"invalid_output"';
    db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
                VALUES (?, 'g','run1','s1',0,?,?,'[]','[]',NULL,'${anchorDay}T00:00:00.000Z','${anchorDay}T00:10:00.000Z',?)`)
      .run(`sr${i}`, i + 1, verdict === "passed" ? "passed" : "failed", `fp${i}`);
    db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
                VALUES (?, 'g','run1',?, 'step_complete',NULL,
                  ?, NULL,
                  ?, '${anchorDay}T00:10:00.000Z')`)
      .run(`ht${i}`, `sr${i}`,
        `{"sensorsRun":[],"verdict":"${verdict}","untestedRegions":[],"residualRisk":[],"oracleAdequacy":{"sufficient":true,"gaps":[]}}`,
        `{"cost":null,"latency_ms":100,"model":null,"provider_id":null,"provider_version":null,"prompt_ref":null,"raw_output_ref":null,"rejected_alternatives":[],"human_interventions":[],"outcome":{"status":"${status}","failure_code":${fc}}}`);
  }
}

function deps() {
  const parsed = { proposedInstructions: "Generate a proposal, then validate it against the output schema.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" };
  const broker: BrokerLike = { propose: vi.fn(async () => ({ status: "proposed" as const, parsed })) };
  return {
    broker, actor: () => "owner",
    shadowAsk: { ask: vi.fn(async () => ({ text: "" })) },
    terminateShadow: vi.fn(() => {}),
  };
}

function proposalFixture(over: Partial<TemplateInstructionProposal> = {}): TemplateInstructionProposal {
  return {
    id: "p-fixture", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1",
    component: "step_instructions", beforeInstructions: "Generate a proposal.", afterInstructions: "Generate a proposal, then validate.",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 4, signalCount: 4 },
    predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"],
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 0.33, verdictPassRate: 0.33, oracleSufficientRate: 1, versionDelta: null } },
    rationale: "test", humanEdited: false, status: "pending",
    createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null, appliedAsVersion: null, ...over,
  };
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); });
afterEach(() => { closeDatabase(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("learning routes", () => {
  it("analyze -> apply -> list lifecycle", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });

    const analyze = await f.inject({ method: "POST", url: "/v1/learning/templates/tpl/analyze?period=30d" });
    expect(analyze.statusCode).toBe(200);
    const proposals = (analyze.json() as { proposals: Array<{ id: string; stepTemplateId: string }> }).proposals;
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const id = proposals[0].id;

    const apply = await f.inject({ method: "POST", url: `/v1/learning/proposals/${id}/apply`, payload: {} });
    expect(apply.statusCode).toBe(200);
    expect((apply.json() as { proposal: { status: string } }).proposal.status).toBe("applied");

    const list = await f.inject({ method: "GET", url: "/v1/learning/templates/tpl/proposals" });
    expect((list.json() as { proposals: Array<{ status: string }> }).proposals.some((p) => p.status === "applied")).toBe(true);
  });

  it("400 on bad period, 404 on unknown template", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    expect((await f.inject({ method: "POST", url: "/v1/learning/templates/tpl/analyze?period=1y" })).statusCode).toBe(400);
    expect((await f.inject({ method: "POST", url: "/v1/learning/templates/nope/analyze?period=7d" })).statusCode).toBe(404);
  });

  it("404 applying an unknown proposal", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    expect((await f.inject({ method: "POST", url: "/v1/learning/proposals/missing/apply", payload: {} })).statusCode).toBe(404);
  });

  it("422 applying a schema proposal with an edit that isn't valid JSON", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    const before = JSON.stringify([{ key: "summary", type: "string", required: true }], null, 2);
    const after = JSON.stringify([{ key: "summary", type: "string", required: true }, { key: "notes", type: "string", required: false }], null, 2);
    insertProposal(db, proposalFixture({
      id: "p-schema", component: "step_output_schema", beforeInstructions: before, afterInstructions: after, status: "pending",
    }));
    const res = await f.inject({ method: "POST", url: "/v1/learning/proposals/p-schema/apply", payload: { editedInstructions: "not json" } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("invalid_schema_edit");
  });

  it("409 dismissing a non-pending proposal", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    insertProposal(db, proposalFixture({ id: "p-applied", status: "applied", appliedAsVersion: 2 }));
    const res = await f.inject({ method: "POST", url: "/v1/learning/proposals/p-applied/dismiss" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("not_pending");
  });

  it("409 rolling back a non-applied proposal", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    insertProposal(db, proposalFixture({ id: "p-pending", status: "pending" }));
    const res = await f.inject({ method: "POST", url: "/v1/learning/proposals/p-pending/rollback" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("not_applied");
  });

  it("409 restore-default when no baseline exists", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    // tpl is a built-in template; baseline is only captured on first apply, so none exists yet.
    const res = await f.inject({ method: "POST", url: "/v1/learning/templates/tpl/restore-default" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("no_baseline");
  });

  it("GET events returns newest-first events; 404 on unknown template", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    const now = new Date().toISOString();
    recordEvent(db, { templateId: "tpl", proposalId: null, stepTemplateId: "s1", eventType: "created", templateVersion: 1, payload: { kind: "created", component: "step_instructions", rule: "R2", failureCode: "invalid_output" } }, now);
    recordEvent(db, { templateId: "tpl", proposalId: null, stepTemplateId: "s1", eventType: "created", templateVersion: 1, payload: { kind: "created", component: "step_instructions", rule: "R2", failureCode: "invalid_output" } }, now);

    const res = await f.inject({ method: "GET", url: "/v1/learning/templates/tpl/events?limit=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: unknown[] };
    expect(body.events).toHaveLength(1);

    const missing = await f.inject({ method: "GET", url: "/v1/learning/templates/nope/events" });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("template_not_found");
  });

  it("GET events with non-numeric limit falls back to default", async () => {
    const f = Fastify(); registerLearningRoutes(f, { db, ...deps() });
    const now = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      recordEvent(db, { templateId: "tpl", proposalId: null, stepTemplateId: "s1", eventType: "created", templateVersion: 1, payload: { kind: "created", component: "step_instructions", rule: "R2", failureCode: "invalid_output" } }, now);
    }

    const res = await f.inject({ method: "GET", url: "/v1/learning/templates/tpl/events?limit=abc" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: unknown[] };
    expect(body.events).toHaveLength(6);

    // Non-integral limit must floor, not crash (non-integral SQL LIMIT bindings throw).
    const float = await f.inject({ method: "GET", url: "/v1/learning/templates/tpl/events?limit=2.5" });
    expect(float.statusCode).toBe(200);
    expect((float.json() as { events: unknown[] }).events).toHaveLength(2);
  });
});
