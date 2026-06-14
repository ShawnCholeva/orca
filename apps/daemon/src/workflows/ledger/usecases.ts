import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { LedgerUpdate, LedgerRecordType } from "@orca/contracts";

const ID_PREFIX: Record<LedgerRecordType, string> = {
  requirement: "REQ",
  deliverable: "DEL",
  finding: "FND",
  decision: "DEC",
  evidence: "EVD",
  artifact: "ART",
};

export interface CommitLedgerInput {
  goalId: string;
  workflowRunId: string;
  sourceStepRunId: string | null;
  traversalSeq: number;
  updates: LedgerUpdate[]; // normalized; create ops may carry local refs
}

export interface CommitLedgerResult {
  version: number;
  idMap: Record<string, string>; // local ref -> canonical id (creates only)
}

/** Atomically increments and returns the per-run ledger version. */
export function nextLedgerVersion(db: Database.Database, runId: string): number {
  db.prepare("UPDATE workflow_runs SET ledger_version = ledger_version + 1 WHERE id = ?").run(runId);
  const row = db.prepare("SELECT ledger_version FROM workflow_runs WHERE id = ?").get(runId) as { ledger_version: number } | undefined;
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return row.ledger_version;
}

/** Allocates a stable canonical id for a new record of the given type. */
export function allocateCanonicalId(recordType: LedgerRecordType): string {
  return `${ID_PREFIX[recordType]}-${randomUUID().slice(0, 8)}`;
}

/**
 * Commits one immutable ledger version for a step: allocates canonical ids for
 * creates, materializes/updates the canonical records, and writes the version
 * row with the resolved (canonical-id'd) updates. Returns the version + the
 * local->canonical id map so the caller can persist the mapping in the step's
 * evidence if desired. All in one transaction.
 */
export function commitLedgerVersion(
  db: Database.Database,
  now: () => string,
  input: CommitLedgerInput
): CommitLedgerResult {
  return db.transaction((): CommitLedgerResult => {
    const version = nextLedgerVersion(db, input.workflowRunId);
    const ts = now();
    const idMap: Record<string, string> = {};

    // First pass: allocate canonical ids for creates.
    for (const u of input.updates) {
      if (u.operation === "create") {
        const canonical = allocateCanonicalId(u.record_type);
        idMap[u.record_id] = canonical;
      }
    }
    const resolve = (id: string): string => idMap[id] ?? id;

    const resolved = input.updates.map((u) => ({
      ...u,
      record_id: resolve(u.record_id),
      related_record_ids: (u.related_record_ids ?? []).map(resolve),
    }));

    // Apply to canonical records.
    for (const u of resolved) {
      if (u.operation === "create") {
        db.prepare(
          `INSERT INTO workflow_ledger_records
             (id, goal_id, workflow_run_id, record_type, status, note,
              evidence_refs_json, related_ids_json, first_version, last_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          u.record_id, input.goalId, input.workflowRunId, u.record_type, u.status, u.note,
          JSON.stringify(u.evidence_refs), JSON.stringify(u.related_record_ids), version, version, ts, ts
        );
      } else {
        // update / link: mutate the existing canonical row, bump last_version.
        const existing = db.prepare(
          "SELECT evidence_refs_json, related_ids_json FROM workflow_ledger_records WHERE workflow_run_id = ? AND id = ?"
        ).get(input.workflowRunId, u.record_id) as { evidence_refs_json: string; related_ids_json: string } | undefined;
        if (!existing) {
          throw new LedgerCommitError(`update/link references unknown canonical record: ${u.record_id}`);
        }
        const evidence = mergeUnique(JSON.parse(existing.evidence_refs_json), u.evidence_refs);
        const related = mergeUnique(JSON.parse(existing.related_ids_json), u.related_record_ids ?? []);
        db.prepare(
          "UPDATE workflow_ledger_records SET status = ?, note = ?, evidence_refs_json = ?, related_ids_json = ?, last_version = ?, updated_at = ? WHERE workflow_run_id = ? AND id = ?"
        ).run(u.status, u.note, JSON.stringify(evidence), JSON.stringify(related), version, ts, input.workflowRunId, u.record_id);
      }
    }

    db.prepare(
      `INSERT INTO workflow_ledger_versions
         (id, goal_id, workflow_run_id, version, source_step_run_id, traversal_seq, updates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), input.goalId, input.workflowRunId, version, input.sourceStepRunId, input.traversalSeq, JSON.stringify(resolved), ts);

    return { version, idMap };
  })();
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

export class LedgerCommitError extends Error {
  readonly code = "ledger_commit_error" as const;
  constructor(message: string) {
    super(message);
    this.name = "LedgerCommitError";
  }
}
