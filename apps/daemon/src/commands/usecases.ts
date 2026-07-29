import type Database from "better-sqlite3";
import type { RunGoalCommandRequest, RunGoalCommandResponse } from "@orca/contracts";

import type { EventBus } from "../events.js";
import { failSession } from "../sessions/runtime.js";
import { postOrchestratorMessage } from "../workflows/orchestrator/orchestrator-message.js";

export class UnknownCommandError extends Error {
  readonly code = "unknown_command";
  constructor(name: string) {
    super(`Unknown command: /${name}`);
  }
}

export class GoalCommandGoalNotFoundError extends Error {
  readonly code = "goal_not_found";
  constructor(readonly goalId: string) {
    super(`Goal not found: ${goalId}`);
  }
}

export interface GoalCommandCtx {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory?: () => string;
}

function goalExists(db: Database.Database, goalId: string): boolean {
  const row = db
    .prepare("SELECT id FROM goals WHERE id = ? AND archived_at IS NULL")
    .get(goalId) as { id: string } | undefined;
  return row !== undefined;
}

/** The live worker session for a goal's current step, if there is one. */
function liveWorkerSession(
  db: Database.Database,
  goalId: string
): { id: string; stepRunId: string } | null {
  const row = db
    .prepare(
      `SELECT s.id AS id, wsr.id AS step_run_id
       FROM sessions s
       JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id AND wsr.goal_id = s.goal_id
       JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
       WHERE s.goal_id = ? AND s.status = 'running' AND wr.status = 'active' AND wsr.status = 'active'
       LIMIT 1`
    )
    .get(goalId) as { id: string; step_run_id: string } | undefined;
  return row ? { id: row.id, stepRunId: row.step_run_id } : null;
}

/**
 * Runs a deterministic, non-LLM goal command. This never reaches the
 * orchestrator LLM: an unknown command is a plain error, not a reinterpretation.
 *
 * `/stuck` is the last-resort human signal for the one case no sensor can
 * catch — an agent producing output while going in circles. It records the
 * user's judgment in the chat thread, then hands the live worker to the same
 * recovery ladder the stall sensor uses (failSession → crash-retry rescue in
 * apps/daemon/src/workflows/orchestrator/service.ts).
 */
export async function runGoalCommand(
  ctx: GoalCommandCtx,
  goalId: string,
  input: RunGoalCommandRequest
): Promise<RunGoalCommandResponse> {
  if (input.command !== "stuck") throw new UnknownCommandError(input.command);
  if (!goalExists(ctx.db, goalId)) throw new GoalCommandGoalNotFoundError(goalId);

  const now = ctx.now();
  const reason = input.args?.trim() ?? "";
  // Record what the user said before acting on it: the thread is the audit trail.
  postOrchestratorMessage(
    ctx.db,
    ctx.now,
    goalId,
    reason ? `I'm stuck: ${reason}` : "I'm stuck.",
    { bus: ctx.bus, idFactory: ctx.idFactory },
    "user"
  );

  const session = liveWorkerSession(ctx.db, goalId);
  if (!session) {
    return { ok: true, message: "There's no agent running on this goal right now." };
  }

  // Set failure_detail before failSession writes failure_reason, so the
  // reason is on the row before the terminal-event subscriber reads it.
  if (reason) {
    ctx.db.prepare("UPDATE sessions SET failure_detail = ? WHERE id = ?").run(reason, session.id);
  }
  // Same path the stall sensor uses: restart under the cap, stop the run at it.
  failSession(ctx.db, ctx.bus, session.id, goalId, "user_declared_stuck", now);
  return { ok: true, message: "Thanks — restarting the agent on this step." };
}
