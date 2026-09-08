import type Database from "better-sqlite3";

import type { EventBus } from "../../events.js";
import { appendWorkflowEvent } from "../events.js";
import { publishStaged } from "./queries.js";
import { pauseWorkflowRun } from "../runs/usecases.js";

/**
 * Who asked for the stop. Both are the operator; they differ in how the ask
 * arrived, and the distinction is what tells a prompt-understanding problem
 * ("stop" typed in chat that the mediator read as something else) apart from a
 * mechanism problem.
 */
export type StopSource = "user_command" | "orchestrator_action";

export interface StopRunDeps {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory?: () => string;
  /** Kills the worker's tmux session. Absent in tests that don't run workers. */
  workerTerminate?: (sessionId: string) => Promise<void>;
}

export interface StopRunOutcome {
  stopped: boolean;
  workflowRunId: string | null;
}

/** The goal's live run, if it has one that can still be stopped. */
function activeRunForGoal(db: Database.Database, goalId: string): { id: string } | null {
  const row = db
    .prepare("SELECT id FROM workflow_runs WHERE goal_id = ? AND status = 'active' LIMIT 1")
    .get(goalId) as { id: string } | undefined;
  return row ?? null;
}

/** Every running worker session on a run — the step's agent, and any gate worker. */
function runningSessions(db: Database.Database, workflowRunId: string): string[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id
         FROM sessions s
         JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id
        WHERE wsr.workflow_run_id = ? AND s.status IN ('created','starting','running')`
    )
    .all(workflowRunId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Stops a goal's run because the operator asked it to.
 *
 * The ordering here is load-bearing:
 *
 *  1. `workflow.run.stop_requested` is emitted FIRST, and unconditionally — even
 *     when there is no run to stop. It records the ask, not the outcome, so a
 *     stop that went unhonoured is distinguishable from one never made.
 *  2. The run is paused BEFORE the workers are killed. A worker session that ends
 *     while its run is still `active` is routed through onWorkflowSessionCompleted,
 *     whose `sess.status === "stopped"` branch calls blockRun — so killing first
 *     would turn a clean, resumable stop into a blocked run. With the run already
 *     paused, that handler returns at its `run.status !== "active"` guard and the
 *     termination stays bookkeeping.
 *  3. Only then are the workers terminated, so no agent keeps burning tokens on
 *     work the operator has called off.
 *
 * A paused run is resumable: `resumeWorkflowRun` re-activates it and the resume
 * route respawns the step's agent.
 */
export async function stopRunForGoal(
  deps: StopRunDeps,
  goalId: string,
  source: StopSource
): Promise<StopRunOutcome> {
  const run = activeRunForGoal(deps.db, goalId);

  const event = appendWorkflowEvent(
    deps.db,
    "workflow.run.stop_requested",
    { goalId, workflowRunId: run?.id ?? null, source },
    deps.now(),
    deps.idFactory
  );
  publishStaged(deps.bus, [event]);

  if (!run) return { stopped: false, workflowRunId: null };

  const sessions = runningSessions(deps.db, run.id);
  pauseWorkflowRun({ db: deps.db, bus: deps.bus, now: deps.now, idFactory: deps.idFactory }, run.id);
  for (const sessionId of sessions) {
    await deps.workerTerminate?.(sessionId).catch(() => {});
  }
  return { stopped: true, workflowRunId: run.id };
}
