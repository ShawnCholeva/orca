/**
 * Is a step run parked on the HUMAN? One definition, for every reader.
 *
 * It used to be two, and they disagreed. `workflow_step_runs.awaiting_user` is a
 * cached column with a SINGLE writer — `setAwaitingUser`, called after an
 * orchestrator action and discriminating on whether that action posted a chat
 * reply. But at least four paths park a step without an orchestrator action:
 * `pauseForStepConfirmation`, `pauseForGateDecision`, `pauseForMarkDone`, and
 * `permission_pending`. A park created by any of them leaves the column at
 * whatever the last orchestrator action set.
 *
 * Live consequence: a run sat with `awaiting_user = 0` while its activity had
 * been `paused_for_input` for 39 hours — so the ledger would say "parked 39h"
 * while the chat said "working", and whichever the reader saw second, they would
 * stop trusting both. Two surfaces contradicting each other about one fact is a
 * defect regardless of which is right.
 *
 * A test asserting the two agree could only cover paths someone enumerated, and
 * the bug is a missing write on a path nobody enumerated. So this derives the
 * fact from the `activities` row, where it already lives, and the column becomes
 * removable. Deriving does not add coupling — the two were already coupled by an
 * invariant maintained by hand across five paths; this replaces that with one
 * enforced by construction.
 */

/**
 * `permission_pending` is the exception that makes this two conditions rather
 * than one: `openActivity` inserts EVERY activity as `active` and only the park
 * paths flip the status, so a worker waiting on tool approval reads as active
 * while genuinely being parked on the user.
 */
export function isAwaitingUser(
  activityStatus: string | null | undefined,
  activitySourceKind: string | null | undefined
): boolean {
  return activityStatus === "paused_for_input" || activitySourceKind === "permission_pending";
}

/**
 * The join that exposes a step run's live activity. The unique partial index
 * `idx_activities_one_live_per_step` guarantees at most one row, so this cannot
 * fan out. `alias` is the step-run table's alias in the calling query.
 */
export function liveActivityJoin(alias: string): string {
  return `LEFT JOIN activities a
            ON a.step_run_id = ${alias}.id
           AND a.status IN ('active', 'paused_for_input')`;
}

/** The columns `isAwaitingUser` consumes, for the SELECT list. */
export const LIVE_ACTIVITY_COLUMNS =
  "a.status AS activity_status, a.source_kind AS activity_source_kind";
