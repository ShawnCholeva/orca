/**
 * Orchestrator review/normalize for agent-proposed ledger updates.
 *
 * Design decision: The orchestrator may accept, correct, or reject proposals
 * against the goal, prior ledger, and step instructions.
 *
 * A deterministic normalization core is ALWAYS applied:
 *   - Deduplicate by operation:record_id (first occurrence wins).
 *   - Reject update/link operations that reference unknown canonical ids
 *     (ids not present in the committed ledger).
 *   - Default empty arrays for evidence_refs and note where absent.
 *
 * An optional broker-backed correction pass may be injected via `deps.correct`.
 * When provided, it runs BEFORE the deterministic core, allowing a brokered
 * model pass to rewrite proposals (e.g. fix malformed ids, split ambiguous
 * updates). For this phase (Phase 2) that correction pass is descoped — the
 * hook exists as the extension point but is omitted in tests and not wired to
 * any broker. All substantive normalization is deterministic.
 */

import type { LedgerUpdate } from "@orca/contracts";
import type { CommittedLedger } from "./projection.js";

export interface ReviewDeps {
  // Optional broker correction pass; omitted in tests / when descoped.
  correct?: (proposals: LedgerUpdate[]) => Promise<LedgerUpdate[]>;
}

export interface ReviewInput {
  committed: CommittedLedger;
  proposals: LedgerUpdate[];
}

export interface ReviewResult {
  accepted: LedgerUpdate[];
  rejected: Array<{ update: LedgerUpdate; reason: string }>;
}

export async function reviewAndNormalizeLedgerUpdates(
  deps: ReviewDeps,
  input: ReviewInput,
): Promise<ReviewResult> {
  const known = new Set(input.committed.records.map((r) => r.id));
  const proposals = deps.correct ? await deps.correct(input.proposals) : input.proposals;

  const accepted: LedgerUpdate[] = [];
  const rejected: ReviewResult["rejected"] = [];
  const seen = new Set<string>();

  for (const u of proposals) {
    const key = `${u.operation}:${u.record_id}`;
    if (seen.has(key)) continue; // dedupe
    seen.add(key);

    if ((u.operation === "update" || u.operation === "link") && !known.has(u.record_id)) {
      rejected.push({ update: u, reason: `unknown canonical record: ${u.record_id}` });
      continue;
    }

    accepted.push({ ...u, evidence_refs: u.evidence_refs ?? [], note: u.note ?? "" });
  }

  return { accepted, rejected };
}
