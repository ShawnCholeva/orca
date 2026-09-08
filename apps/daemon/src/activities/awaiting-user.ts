import type Database from "better-sqlite3";

/**
 * Is a step run parked on the HUMAN?
 *
 * THREE SOURCES, EACH HOLDING PART OF THE FACT. This was originally read as "the
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
 *   `orchestrator_messages`          covers OPEN QUESTIONS — an unanswered,
 *     `.pending_question`            non-withdrawn question sitting on a chat
 *                                    message, from EITHER source. An
 *                                    orchestrator-source question raises no
 *                                    activity, and its `awaiting_user` flag is
 *                                    cleared by the next action that posts no
 *                                    chat reply — the prompt gate suppressing a
 *                                    duplicate ask does it, with no user
 *                                    involvement — so both other channels can
 *                                    read false while the question is still on
 *                                    screen, unanswered.
 *
 * None is a cache of another and none is complete. Reading only the column
 * missed a park and reported "working" on a run that had been waiting on its
 * user for 39 hours. Reading only the activity — the fix that looked obvious —
 * would have missed a chat reply and reported "working" on a run whose next move
 * is the user's. Reading only those two let the liveness watchdog restart a
 * worker three times, and then block the run, while the header and the goals rail
 * both correctly read WAITING ON YOU. Every one is a false negative; only the
 * union is correct.
 *
 * SO THE UNION IS THE ONLY THING THIS MODULE EXPORTS. Each half is deliberately
 * module-private: three separate readers each composed their own subset, they
 * drifted, and every drift cost a run. A reader deciding whether Orca may ACT
 * calls `isParkedOnHuman` and nothing else.
 *
 * The real single-source fix is to give the chat-reply and orchestrator-question
 * cases activities too, so `activities` becomes complete and both other sources
 * can be dropped. That is a change to the activity model rather than to its
 * readers, and it belongs to whoever owns that model. Until then, read all three
 * — through here.
 */

/**
 * The PARK half, from the live activity row.
 *
 * `permission_pending` is the exception that makes this two conditions rather
 * than one: `openActivity` inserts EVERY activity as `active` and only the park
 * paths flip the status, so a worker waiting on tool approval reads as active
 * while genuinely being parked on the user.
 */
function isParkedOnActivity(
  activityStatus: string | null | undefined,
  activitySourceKind: string | null | undefined
): boolean {
  return activityStatus === "paused_for_input" || activitySourceKind === "permission_pending";
}

/**
 * The union. `chatReplyPending` is `workflow_step_runs.awaiting_user` — set when
 * the last orchestrator action posted a chat reply rather than driving the agent.
 */
function isAwaitingUser(
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

/** The columns the activity half consumes, for the SELECT list. */
export const LIVE_ACTIVITY_COLUMNS =
  "a.status AS activity_status, a.source_kind AS activity_source_kind";

/**
 * The OPEN-QUESTION half, as a SQL predicate over a step-run id expression.
 *
 * A fragment rather than a function call so a reader answers all three channels
 * in the query it was already running: `rowToStepRun` has no database handle, and
 * the watchdog would otherwise issue one extra round trip per running worker.
 * Mirrors `liveActivityJoin` / `LIVE_ACTIVITY_COLUMNS` above.
 *
 * `stepRunIdExpr` is interpolated, so pass a column reference or a bound `?` —
 * never user input.
 */
export function openQuestionSql(stepRunIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM orchestrator_messages om
     WHERE om.pending_question IS NOT NULL
       AND json_extract(om.pending_question, '$.stepRunId') = ${stepRunIdExpr}
       AND json_extract(om.pending_question, '$.answer') IS NULL
       AND json_extract(om.pending_question, '$.withdrawn') IS NULL
  )`;
}

/** The open-question half as a SELECT column, for `alias`'s step run. */
export function openQuestionColumn(alias: string): string {
  return `${openQuestionSql(`${alias}.id`)} AS open_question`;
}

/**
 * Is the worker's turn still OPEN on this step run?
 *
 * An activity row is opened when the worker starts a turn and settled by its
 * `turn_completed` signal (`completeLive` / `expireLive` in activities/updater.ts),
 * so a live row at `active` means the agent is mid-turn. `paused_for_input` is
 * excluded: that row is a park, and a park is the human's turn, not the worker's.
 *
 * This exists because "the orchestrator posted a chat reply" and "the human owes
 * the next move" are NOT the same fact. They coincide after a worker's turn ends,
 * which is the path the chat-reply flag was designed for. They come apart when a
 * user types mid-turn: the orchestrator answers, the agent keeps working, and
 * marking that a park claims the human is the bottleneck over an agent that is
 * demonstrably not waiting for them. That inflates parked time in the metrics and
 * makes the UI say "waiting on you" over live work.
 */
export function isWorkerTurnOpen(db: Database.Database, stepRunId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM activities WHERE step_run_id = ? AND status = 'active' LIMIT 1")
    .get(stepRunId);
  return row !== undefined;
}

/**
 * THE answer: is this step run parked on the human, by any channel?
 *
 * Every caller feeds it all three inputs, because a caller that could supply
 * only two is a caller that will one day ship with only two.
 */
export function isParkedOnHuman(input: {
  activityStatus: string | null | undefined;
  activitySourceKind: string | null | undefined;
  /** `workflow_step_runs.awaiting_user` — the orchestrator replied and stopped. */
  chatReplyPending: boolean;
  /** `openQuestionColumn` — an unanswered question on a chat message. */
  openQuestion: boolean;
}): boolean {
  return (
    isAwaitingUser(input.activityStatus, input.activitySourceKind, input.chatReplyPending) ||
    input.openQuestion
  );
}
