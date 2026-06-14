import type Database from "better-sqlite3";
import type { LedgerRecord } from "@orca/contracts";

export interface CommittedLedger {
  version: number;
  records: LedgerRecord[];
}

interface RecordRow {
  id: string;
  record_type: string;
  status: string;
  note: string;
  evidence_refs_json: string;
  related_ids_json: string;
  first_version: number;
  last_version: number;
  updated_at: string;
}

export function latestCommittedLedger(db: Database.Database, runId: string): CommittedLedger {
  const v = db.prepare("SELECT ledger_version FROM workflow_runs WHERE id = ?").get(runId) as { ledger_version: number } | undefined;
  const rows = db.prepare(
    "SELECT id, record_type, status, note, evidence_refs_json, related_ids_json, first_version, last_version, updated_at FROM workflow_ledger_records WHERE workflow_run_id = ? ORDER BY first_version ASC"
  ).all(runId) as RecordRow[];
  return {
    version: v?.ledger_version ?? 0,
    records: rows.map((r) => ({
      id: r.id,
      recordType: r.record_type as LedgerRecord["recordType"],
      status: r.status,
      note: r.note,
      evidenceRefs: JSON.parse(r.evidence_refs_json),
      relatedRecordIds: JSON.parse(r.related_ids_json),
      firstVersion: r.first_version,
      lastVersion: r.last_version,
      updatedAt: r.updated_at,
    })),
  };
}

export function listLedgerVersionsForRun(
  db: Database.Database,
  runId: string
): Array<{ version: number; sourceStepRunId: string | null; traversalSeq: number; createdAt: string }> {
  const rows = db
    .prepare(
      "SELECT version, source_step_run_id, traversal_seq, created_at FROM workflow_ledger_versions WHERE workflow_run_id = ? ORDER BY version ASC"
    )
    .all(runId) as Array<{ version: number; source_step_run_id: string | null; traversal_seq: number; created_at: string }>;
  return rows.map((r) => ({
    version: r.version,
    sourceStepRunId: r.source_step_run_id,
    traversalSeq: r.traversal_seq,
    createdAt: r.created_at,
  }));
}
