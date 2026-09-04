/**
 * Is a step run parked on the HUMAN?
 *
 * TWO SOURCES, EACH HOLDING HALF THE FACT. This was originally read as "the
 * column is a stale cache of what `activities` already knows", and that is wrong
 * in a way worth recording, because the wrong reading produces a plausible fix
 * that trades one false answer for another.
 *
 *   `activities`                     covers PARKS — a confirmation card, a gate
 *                                    decision, a worker question, mark-done, a
 *                                    pending tool permission.
 *   `workflow_step_runs.awaiting_user` covers CHAT REPLIES — the orchestrator
 *                                    answered, paraphrased or escalated to the
 *                                    user and stopped. `paraphrase_agent_message`,
 *                                    `answer_user_directly` and `escalate_to_user`
 *                                    only `postOrchestratorMessage`; they raise no
 *                                    activity at all, so nothing in `activities`
 *                                    represents this state.
 *
 * Neither is a cache of the other and neither is complete. Reading only the
 * column missed a park and reported "working" on a run that had been waiting on
 * its user for 39 hours. Reading only the activity — the fix that looked obvious
 * — would have missed a chat reply and reported "working" on a run whose next
 * move is the user's. Both are false negatives; only the union is correct.
 *
 * The real single-source fix is to give the chat-reply case an activity too, so
 * `activities` becomes complete and the column can be dropped. That is a change
 * to the activity model rather than to its readers, and it belongs to whoever
 * owns that model. Until then, read both.
 */

/**
 * The PARK half, from the live activity row.
 *
 * `permission_pending` is the exception that makes this two conditions rather
 * than one: `openActivity` inserts EVERY activity as `active` and only the park
 * paths flip the status, so a worker waiting on tool approval reads as active
 * while genuinely being parked on the user.
 */
export function isParkedOnActivity(
  activityStatus: string | null | undefined,
  activitySourceKind: string | null | undefined
): boolean {
  return activityStatus === "paused_for_input" || activitySourceKind === "permission_pending";
}

/**
 * The union. `chatReplyPending` is `workflow_step_runs.awaiting_user` — set when
 * the last orchestrator action posted a chat reply rather than driving the agent.
 */
export function isAwaitingUser(
  activityStatus: string | null | undefined,
  activitySourceKind: string | null | undefined,
  chatReplyPending: boolean
): boolean {
  return isParkedOnActivity(activityStatus, activitySourceKind) || chatReplyPending;
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

/** The columns `isParkedOnActivity` consumes, for the SELECT list. */
export const LIVE_ACTIVITY_COLUMNS =
  "a.status AS activity_status, a.source_kind AS activity_source_kind";
