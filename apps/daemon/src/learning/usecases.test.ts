import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import type { DiagnosisBundle } from "./diagnose.js";
import type { BrokerLike } from "./propose.js";
import { listProposalsByTemplate } from "./store.js";

// diagnoseTemplate is mocked below so the test can force the exact bad state the structural
// net guards against: an R4 bundle whose currentOutputSchemaJson is "[]" (unparseable). The
// diagnose-level guard (diagnose.ts) already prevents this bundle from being produced by the
// real diagnose path, so forcing it here is how the independent net in analyzeTemplate gets
// exercised on its own, regardless of which future diagnose path might one day produce it.
vi.mock("./diagnose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diagnose.js")>();
  return { ...actual, diagnoseTemplate: vi.fn() };
});

const { diagnoseTemplate } = await import("./diagnose.js");
const { analyzeTemplate } = await import("./usecases.js");

const tempDirs: string[] = [];
function createConfig(dataDir: string): Config {
  return { dataDir, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"], getAuthToken: () => "test-token" };
}
function openTestDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-learning-usecases-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

// Minimal seed: one goal (with an orchestrator model so analyzeTemplate can resolve one),
// one template with step "s1", one run, one step run + transition anchoring "s1" so
// anchorForStep resolves. The metrics themselves don't matter — diagnoseTemplate is mocked.
function seed(db: Database.Database) {
  const day = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO goals (id,title,description,status,autonomy_level,created_at,updated_at,archived_at)
              VALUES ('g','G','','active',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)`).run();
  db.prepare(`UPDATE goals SET orchestrator_provider = 'orca/anthropic', orchestrator_model = 'claude-opus-4-8' WHERE id = 'g'`).run();
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,is_locked,steps_json,guardrails_json,created_at,updated_at)
              VALUES ('tpl','Brainstorm','',1,1,1,'[{"id":"s1","name":"Generate","instructions":"Generate a proposal."}]','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,current_step_run_id,blocked_reason,started_at,finished_at)
              VALUES ('run1','g','tpl',1,'completed',NULL,NULL,'${day}T00:00:00.000Z','${day}T01:00:00.000Z')`).run();
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,attempt,status,satisfied_exit_criteria_json,outstanding_exit_criteria_json,blocked_reason,started_at,finished_at,fingerprint)
              VALUES ('sr0','g','run1','s1',0,1,'passed','[]','[]',NULL,'${day}T00:00:00.000Z','${day}T00:10:00.000Z','fp0')`).run();
  db.prepare(`INSERT INTO harness_transitions (id,goal_id,workflow_run_id,workflow_step_run_id,boundary,risk_json,evidence_json,state_deps_json,telemetry_json,created_at)
              VALUES ('ht0','g','run1','sr0','step_complete',NULL,
                '{"sensorsRun":[],"verdict":"passed","untestedRegions":[],"residualRisk":[],"oracleAdequacy":{"sufficient":true,"gaps":[]}}',NULL,
                '{"cost":null,"latency_ms":100,"model":null,"provider_id":null,"provider_version":null,"prompt_ref":null,"raw_output_ref":null,"rejected_alternatives":[],"human_interventions":[],"outcome":{"status":"succeeded","failure_code":null}}',
                '${day}T00:10:00.000Z')`).run();
}

const badBundle: DiagnosisBundle = {
  stepTemplateId: "s1", currentInstructions: "Generate a proposal.",
  component: "step_output_schema", currentOutputSchemaJson: "[]", // the exact unparseable fallback the diagnose guard now prevents
  targetedFailureMode: { rule: "R4", failureCode: null, clusterCount: null, signalCount: null },
  evidence: {
    sampleTransitionIds: [], revisionSignalIds: [], revisionFeedbackTexts: [], refuteReasons: [], supersededReasons: [],
    metricSnapshot: { score: 70, verdictPassRate: 0.9, oracleSufficientRate: null, versionDelta: null },
  },
};

function brokerReturningSchemaFill(): BrokerLike {
  const parsed = {
    proposedOutputSchema: [{ key: "summary", type: "string", required: true }],
    predictedImprovement: "verifies its own claim", invariantsPreserved: ["safetyCompliance"], rationale: "r",
  };
  return { propose: vi.fn(async () => ({ status: "proposed" as const, parsed })) };
}

let db: Database.Database;
beforeEach(() => { db = openTestDb(); seed(db); vi.mocked(diagnoseTemplate).mockReturnValue([badBundle]); });
afterEach(() => { closeDatabase(); vi.mocked(diagnoseTemplate).mockReset(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("analyzeTemplate structural net", () => {
  it("skips a bundle that would produce a contract-invalid proposal (empty beforeInstructions), warns, does not throw, and writes no row", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = await analyzeTemplate({ broker: brokerReturningSchemaFill() }, db, "tpl", "30d");
    expect(created).toEqual([]);
    expect(listProposalsByTemplate(db, "tpl")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("s1");
    warn.mockRestore();
  });
});
