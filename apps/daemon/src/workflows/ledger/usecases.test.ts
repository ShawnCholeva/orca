import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { nextLedgerVersion, commitLedgerVersion, allocateCanonicalId } from "./usecases.js";
import { latestCommittedLedger } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../../migrations");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES ('g','G','','active',1,'2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('t','T','',1,0,0,'[]','[]','2026-06-12T00:00:00.000Z','2026-06-12T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r','g','t',1,'active','2026-06-12T00:00:00.000Z')"
  ).run();
});

describe("nextLedgerVersion", () => {
  it("increments and persists the per-run counter", () => {
    expect(nextLedgerVersion(db, "r")).toBe(1);
    expect(nextLedgerVersion(db, "r")).toBe(2);
  });
});

describe("allocateCanonicalId", () => {
  it("produces prefixed ids for each record type", () => {
    expect(allocateCanonicalId("requirement")).toMatch(/^REQ-/);
    expect(allocateCanonicalId("deliverable")).toMatch(/^DEL-/);
    expect(allocateCanonicalId("finding")).toMatch(/^FND-/);
    expect(allocateCanonicalId("decision")).toMatch(/^DEC-/);
    expect(allocateCanonicalId("evidence")).toMatch(/^EVD-/);
    expect(allocateCanonicalId("artifact")).toMatch(/^ART-/);
  });
});

describe("commitLedgerVersion", () => {
  it("allocates canonical ids for creates and materializes records", () => {
    const seq = 1;
    const result = commitLedgerVersion(db, () => "2026-06-12T00:00:01.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-1",
      traversalSeq: seq,
      updates: [
        { operation: "create", record_id: "local:a", record_type: "requirement", status: "open", evidence_refs: [], note: "n", related_record_ids: undefined },
      ],
    });
    expect(result.version).toBe(1);
    expect(result.idMap["local:a"]).toMatch(/^REQ-/); // canonical id allocated
    const ledger = latestCommittedLedger(db, "r");
    expect(ledger.version).toBe(1);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0].id).toBe(result.idMap["local:a"]);
  });

  it("applies update to the existing canonical record without re-creating", () => {
    const c = commitLedgerVersion(db, () => "2026-06-12T00:00:01.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-1",
      traversalSeq: 1,
      updates: [{ operation: "create", record_id: "local:a", record_type: "requirement", status: "open", evidence_refs: [], note: "" }],
    });
    const canonical = c.idMap["local:a"];
    const c2 = commitLedgerVersion(db, () => "2026-06-12T00:00:02.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-2",
      traversalSeq: 2,
      updates: [{ operation: "update", record_id: canonical, record_type: "requirement", status: "satisfied", evidence_refs: ["ev-1"], note: "met" }],
    });
    expect(c2.version).toBe(2);
    const ledger = latestCommittedLedger(db, "r");
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0].status).toBe("satisfied");
    expect(ledger.records[0].lastVersion).toBe(2);
  });

  it("throws LedgerCommitError when updating an unknown record", () => {
    expect(() =>
      commitLedgerVersion(db, () => "2026-06-12T00:00:01.000Z", {
        goalId: "g",
        workflowRunId: "r",
        sourceStepRunId: null,
        traversalSeq: 1,
        updates: [{ operation: "update", record_id: "REQ-nonexistent", record_type: "requirement", status: "open", evidence_refs: [], note: "" }],
      })
    ).toThrow("unknown canonical record");
  });
});
