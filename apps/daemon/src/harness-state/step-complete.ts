import type Database from "better-sqlite3";
import type { ConflictPolicy, StateAssumption, StateDepsFacet } from "@orca/contracts";
import { listMemoryByGoal } from "../memory/projection.js";
import { listDecisionsByGoal } from "../decisions/projection.js";
import { getGoalRefinement } from "../goal-refinements.js";
import { listWorkspacesByGoal } from "../workspaces/projection.js";
import { listTransitionsByGoal } from "../harness-transitions/projection.js";
import { deriveReadSet } from "./read-set.js";
import { deriveWriteSet, type GitDiffer } from "./write-set.js";
import { detectStateConflicts, noopConflictJudge } from "./detect.js";

export interface StepCompleteStateInput {
  goalId: string;
  /** The completing step's session id (write_set created-rows are scoped to it). */
  sessionId: string;
  /** The completing step's run id — excluded from the concurrent-set (it's self). */
  thisStepRunId: string;
  /** Free-text assumptions carried by the step's completion block, if any. */
  assumptions: string[];
  /** Constant default this plan. */
  conflictPolicy: ConflictPolicy;
}

/**
 * Derive the step_complete StateDepsFacet and run deterministic conflict
 * detection against concurrent priors on the same goal.
 *
 * read_set/version_deps are re-derived via the SAME readers Task 3's launch
 * hook used (first-attached workspace convention). write_set is the bounded git
 * diff over that workspace plus the rows this session created. The
 * concurrent-set is the goal's prior transitions whose owning session is still
 * active, excluding self. currentVersions is built densely from self's observed
 * versions (same null-encoding as launch) so belief_divergence does not
 * spuriously fire — see the limitation note in the task report.
 */
export function buildStepCompleteStateFacet(
  db: Database.Database,
  input: StepCompleteStateInput,
  differ?: GitDiffer
): StateDepsFacet {
  const memory = listMemoryByGoal(db, input.goalId, { includeArchived: false }).map((m) => ({
    id: m.id,
    updatedAt: m.updatedAt,
  }));
  const decisions = listDecisionsByGoal(db, input.goalId, { includeArchived: false }).map((d) => ({
    id: d.id,
    updatedAt: d.updatedAt,
  }));
  const ref = getGoalRefinement(db, input.goalId);
  const refinement = ref ? { goalId: ref.goalId, refinedAt: ref.refinedAt } : null;
  const ws = listWorkspacesByGoal(db, input.goalId)[0];
  const workspace = ws ? { id: ws.id, branch: null, dirty: null } : null;

  const { read_set, version_deps } = deriveReadSet({
    memory,
    decisions,
    summaries: [],
    refinement,
    workspace,
  });

  const write_set = ws
    ? deriveWriteSet(db, { workspacePath: ws.path, sessionId: input.sessionId }, differ)
    : [];

  const assumptions: StateAssumption[] = input.assumptions.map((statement) => ({
    statement,
    source_ref: null,
    verified: false,
  }));

  const priors = gatherConcurrentPriors(db, input.goalId, input.thisStepRunId);

  // Dense + same encoding as the observed versions: an absent ref counts as
  // divergence, so we copy every observed version. Because both sides are
  // null-encoded today this is always-consistent (divergence inert) by design.
  const currentVersions = new Map<string, string>();
  for (const dep of version_deps) currentVersions.set(dep.ref, dep.observed_version);

  const conflicts = detectStateConflicts({
    self: { read_set, write_set, version_deps },
    priors,
    currentVersions,
    judge: noopConflictJudge,
  });

  return {
    read_set,
    write_set,
    assumptions,
    version_deps,
    conflict_policy: input.conflictPolicy,
    conflicts,
  };
}

/**
 * The concurrent-set: prior transitions on the same goal that carry a stateDeps
 * facet, belong to a DIFFERENT step run, and whose owning session is still
 * active (created/starting/running). Goal-scoping is the minimum scope.
 */
function gatherConcurrentPriors(
  db: Database.Database,
  goalId: string,
  thisStepRunId: string
): Array<{
  transitionId: string;
  read_set: StateDepsFacet["read_set"];
  write_set: StateDepsFacet["write_set"];
}> {
  const active = db.prepare(
    "SELECT id FROM sessions WHERE workflow_step_run_id = ? AND status IN ('created','starting','running') LIMIT 1"
  );
  return listTransitionsByGoal(db, goalId, 10_000)
    .filter(
      (t) =>
        t.stateDeps !== null &&
        t.workflowStepRunId !== null &&
        t.workflowStepRunId !== thisStepRunId
    )
    .filter((t) => !!active.get(t.workflowStepRunId))
    .map((t) => ({
      transitionId: t.id,
      read_set: t.stateDeps!.read_set,
      write_set: t.stateDeps!.write_set,
    }));
}

/**
 * Pure policy -> response decision. `escalate` pauses on any conflict; `auto`
 * warns (records, never pauses). No conflicts -> never pause.
 */
export function decideConflictResponse(
  policy: ConflictPolicy,
  conflictCount: number
): { pause: boolean } {
  return { pause: policy === "escalate" && conflictCount > 0 };
}
