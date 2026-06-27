import type Database from "better-sqlite3";
import type { StateDepsFacet, StateDepWriteEntry } from "@orca/contracts";
import { listTransitionsByGoal } from "../harness-transitions/projection.js";
import { conflictPolicyForGoal } from "./conflict-policy.js";

// StateDepsFacet.write_set is capped at 256; bound the roll-up to match.
const MAX_WRITE_SET = 256;

/**
 * Cumulative write-set for a completed workflow run: the union of every
 * step_complete transition's write_set, deduped by (kind, ref). This is the
 * harness ledger's "what did this Goal actually do" roll-up, carried on the
 * mark_done terminal boundary (and fuel for the future learning loop).
 *
 * Transitions are listed newest-first, so the FIRST occurrence of a ref is its
 * latest change — change_kind reflects the most recent step that touched it
 * (best-effort; the ref SET is the primary signal). read_set/version_deps/
 * conflicts are empty (a roll-up declares no live dependencies); conflict_policy
 * carries the goal's policy for consistency, not a live detection.
 */
export function buildGoalWriteSetRollup(
  db: Database.Database,
  goalId: string,
  workflowRunId: string
): StateDepsFacet {
  const seen = new Set<string>();
  const write_set: StateDepWriteEntry[] = [];
  for (const t of listTransitionsByGoal(db, goalId, 10_000)) {
    if (t.boundary !== "step_complete" || t.workflowRunId !== workflowRunId || t.stateDeps === null) {
      continue;
    }
    for (const w of t.stateDeps.write_set) {
      const key = `${w.kind}:${w.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      write_set.push(w);
      if (write_set.length >= MAX_WRITE_SET) break;
    }
    if (write_set.length >= MAX_WRITE_SET) break;
  }
  return {
    read_set: [],
    write_set,
    assumptions: [],
    version_deps: [],
    conflict_policy: conflictPolicyForGoal(db, goalId),
    conflicts: [],
  };
}
