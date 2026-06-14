import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { commitLedgerVersion } from "./usecases.js";
import { latestCommittedLedger, listLedgerVersionsForRun } from "./projection.js";

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

describe("latestCommittedLedger", () => {
  it("returns version 0 and empty records for a fresh run", () => {
    const ledger = latestCommittedLedger(db, "r");
    expect(ledger.version).toBe(0);
    expect(ledger.records).toHaveLength(0);
  });

  it("reflects the latest committed state after two commits", () => {
    // Commit version 1: create two records
    const c1 = commitLedgerVersion(db, () => "2026-06-12T00:00:01.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-1",
      traversalSeq: 1,
      updates: [
        { operation: "create", record_id: "local:req1", record_type: "requirement", status: "open", evidence_refs: [], note: "first req" },
        { operation: "create", record_id: "local:del1", record_type: "deliverable", status: "pending", evidence_refs: [], note: "first del" },
      ],
    });
    expect(c1.version).toBe(1);

    // Commit version 2: update the first record
    const canonicalReq = c1.idMap["local:req1"];
    const c2 = commitLedgerVersion(db, () => "2026-06-12T00:00:02.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-2",
      traversalSeq: 2,
      updates: [
        { operation: "update", record_id: canonicalReq, record_type: "requirement", status: "satisfied", evidence_refs: ["ev-1", "ev-2"], note: "done" },
      ],
    });
    expect(c2.version).toBe(2);

    const ledger = latestCommittedLedger(db, "r");
    expect(ledger.version).toBe(2);
    expect(ledger.records).toHaveLength(2);

    const req = ledger.records.find((r) => r.id === canonicalReq);
    expect(req).toBeDefined();
    expect(req!.status).toBe("satisfied");
    expect(req!.evidenceRefs).toEqual(["ev-1", "ev-2"]);
    expect(req!.note).toBe("done");
    expect(req!.firstVersion).toBe(1);
    expect(req!.lastVersion).toBe(2);
    expect(req!.recordType).toBe("requirement");

    const del = ledger.records.find((r) => r.id === c1.idMap["local:del1"]);
    expect(del).toBeDefined();
    expect(del!.status).toBe("pending");
    expect(del!.lastVersion).toBe(1);
  });

  it("resolves related_record_ids from local refs to canonical ids", () => {
    // Create two records in one commit; the second references the first by local ref.
    const c1 = commitLedgerVersion(db, () => "2026-06-12T00:00:01.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-1",
      traversalSeq: 1,
      updates: [
        { operation: "create", record_id: "local:a", record_type: "requirement", status: "open", evidence_refs: [], note: "req a" },
        { operation: "create", record_id: "local:b", record_type: "finding", status: "open", evidence_refs: [], related_record_ids: ["local:a"], note: "finding b links to req a" },
      ],
    });

    const canonicalA = c1.idMap["local:a"];
    const canonicalB = c1.idMap["local:b"];

    const ledger = latestCommittedLedger(db, "r");
    expect(ledger.records).toHaveLength(2);

    const recB = ledger.records.find((r) => r.id === canonicalB);
    expect(recB).toBeDefined();
    // The local ref "local:a" must have been resolved to its canonical id.
    expect(recB!.relatedRecordIds).toEqual([canonicalA]);
  });

  it("merges evidence_refs across updates without duplicates", () => {
    const c1 = commitLedgerVersion(db, () => "2026-06-12T00:00:01.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-1",
      traversalSeq: 1,
      updates: [
        { operation: "create", record_id: "local:x", record_type: "finding", status: "open", evidence_refs: ["ev-a"], note: "" },
      ],
    });
    const canonical = c1.idMap["local:x"];
    commitLedgerVersion(db, () => "2026-06-12T00:00:02.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-2",
      traversalSeq: 2,
      updates: [
        { operation: "update", record_id: canonical, record_type: "finding", status: "confirmed", evidence_refs: ["ev-a", "ev-b"], note: "" },
      ],
    });
    const ledger = latestCommittedLedger(db, "r");
    const rec = ledger.records[0];
    expect(rec.evidenceRefs).toEqual(["ev-a", "ev-b"]); // no duplicate ev-a
  });
});

describe("listLedgerVersionsForRun", () => {
  it("returns empty list for a run with no committed versions", () => {
    expect(listLedgerVersionsForRun(db, "r")).toHaveLength(0);
  });

  it("lists all committed versions in order after two commits", () => {
    commitLedgerVersion(db, () => "2026-06-12T00:00:01.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-1",
      traversalSeq: 1,
      updates: [
        { operation: "create", record_id: "local:a", record_type: "requirement", status: "open", evidence_refs: [], note: "" },
      ],
    });
    commitLedgerVersion(db, () => "2026-06-12T00:00:02.000Z", {
      goalId: "g",
      workflowRunId: "r",
      sourceStepRunId: "sr-2",
      traversalSeq: 2,
      updates: [
        { operation: "create", record_id: "local:b", record_type: "deliverable", status: "pending", evidence_refs: [], note: "" },
      ],
    });

    const versions = listLedgerVersionsForRun(db, "r");
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: 1, sourceStepRunId: "sr-1", traversalSeq: 1, createdAt: "2026-06-12T00:00:01.000Z" });
    expect(versions[1]).toMatchObject({ version: 2, sourceStepRunId: "sr-2", traversalSeq: 2, createdAt: "2026-06-12T00:00:02.000Z" });
  });
});
