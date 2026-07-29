import type Database from "better-sqlite3";

import type { EventBus } from "../../events.js";
import { failSession } from "../../sessions/runtime.js";

/** One running worker session sitting on an active step-kind node. */
export interface WatchdogStepRow {
  sessionId: string;
  goalId: string;
  stepRunId: string;
  /** When the session flipped to `running`, in epoch ms; null if never set. */
  startedAtMs: number | null;
  /** Monotonic PTY output counter for the worker session. */
  outputSeq: number;
  /** Latest hook-driven activity update for this step run, epoch ms; null if none. */
  activityAtMs: number | null;
  /** True when Orca owes the next move (nothing is waiting on the user). */
  systemTurn: boolean;
}

/** Last observed progress for a step run, carried across ticks. */
export interface ProgressMark {
  outputSeq: number;
  activityAtMs: number | null;
  /** When this mark was taken, epoch ms — the start of the current idle stretch. */
  sinceMs: number;
}

export interface LivenessWatchdogDeps {
  /** Active step-node runs whose worker session is still marked `running`. */
  listRunningWorkerSteps(): WatchdogStepRow[];
  /** True iff the worker's tmux session actually exists. */
  isTmuxAlive(sessionId: string): Promise<boolean>;
  /** True iff a `step_output` artifact already exists for this step run. */
  hasStepOutput(stepRunId: string): boolean;
  /** Emit the terminal failure signal (session.failed) for a dead worker. */
  reap(row: WatchdogStepRow): void;
  /** Current wall-clock, epoch ms. */
  nowMs(): number;
  /** Grace window (ms) after a session starts before it may be reaped. */
  graceMs: number;
  /** System-turn idle time (ms) tolerated before a live worker is reaped. */
  stallMs: number;
  /** Progress marks by step run; owned by the caller so state survives ticks. */
  progress: Map<string, ProgressMark>;
  /** Emit the terminal failure signal for a live-but-idle worker. */
  reapStalled(row: WatchdogStepRow): void;
}

/**
 * Performs ONE watchdog tick.
 *
 * A tmux worker can die mid-turn (crash / kill / tmux death) WITHOUT firing its
 * Stop hook, so no session terminal event is ever emitted: the run stays
 * `active` on its current step node forever behind a UI spinner. This tick is
 * the deterministic control-plane backstop: for every active step-node run whose
 * worker session is still marked `running` in the DB but whose tmux session is
 * actually gone — and which has produced no `step_output` yet — it emits the same
 * `session.failed` signal the boot-resume path uses, so the existing terminal-
 * event subscriber drives onWorkflowSessionCompleted → crash-retry (respawn under
 * the cap, escalate to a human at the cap). Zero LLM involvement.
 *
 * A second sensor catches a worker that is alive but stuck: no PTY output and no
 * activity progress for `stallMs`, while it is Orca's turn to move (not waiting
 * on the user). That worker is reaped the same way, with reason `worker_stalled`.
 *
 * Grace window: a worker between spawn and tmux-session creation is not yet
 * observable as alive; a session still inside its grace window (or with no
 * recorded start time) is never reaped, so a just-spawned worker is a no-op.
 */
export async function livenessWatchdogTick(deps: LivenessWatchdogDeps): Promise<void> {
  const now = deps.nowMs();
  for (const row of deps.listRunningWorkerSteps()) {
    try {
      // Grace: never reap a session that has not been observable long enough
      // (or whose start time is unknown) — its tmux session may not exist yet.
      if (row.startedAtMs === null || now - row.startedAtMs < deps.graceMs) continue;
      // The worker already produced output; its Stop-hook / synthesis path owns
      // advancement. Reaping here would double-drive the step run.
      if (deps.hasStepOutput(row.stepRunId)) continue;
      // Dead worker: the original backstop, reaped immediately.
      if (!(await deps.isTmuxAlive(row.sessionId))) {
        deps.progress.delete(row.stepRunId);
        deps.reap(row);
        continue;
      }
      // Alive. Only time where ORCA owes the next move counts as a stall — a worker
      // waiting on the user is behaving correctly, however long that takes, so any
      // accumulated idle time is forgotten rather than banked.
      if (!row.systemTurn) {
        deps.progress.delete(row.stepRunId);
        continue;
      }
      const mark = deps.progress.get(row.stepRunId);
      if (
        mark === undefined ||
        mark.outputSeq !== row.outputSeq ||
        mark.activityAtMs !== row.activityAtMs
      ) {
        // First sighting, or real progress since the last tick: re-baseline.
        deps.progress.set(row.stepRunId, {
          outputSeq: row.outputSeq,
          activityAtMs: row.activityAtMs,
          sinceMs: now,
        });
        continue;
      }
      if (now - mark.sinceMs < deps.stallMs) continue;
      deps.progress.delete(row.stepRunId);
      deps.reapStalled(row);
    } catch (err) {
      console.error("[liveness-watchdog] tick failed for session", row.sessionId, err);
    }
  }
}

/**
 * Builds the concrete daemon-wired deps: the DB query that finds running worker
 * sessions on active step nodes, the step_output existence check, and the reap
 * that emits `session.failed` via the shared session-runtime failure path.
 */
export function buildLivenessWatchdogDeps(
  db: Database.Database,
  bus: EventBus,
  opts: {
    isTmuxAlive: (sessionId: string) => Promise<boolean>;
    now: () => string;
    graceMs: number;
    stallMs: number;
    progress: Map<string, ProgressMark>;
  }
): LivenessWatchdogDeps {
  return {
    graceMs: opts.graceMs,
    stallMs: opts.stallMs,
    progress: opts.progress,
    nowMs: () => Date.parse(opts.now()),
    isTmuxAlive: opts.isTmuxAlive,
    listRunningWorkerSteps: () => {
      const rows = db
        .prepare(
          // Two worker-bearing shapes: an active STEP node (session on the run's
          // current step) OR a worker GATE parked mid-eval (session on the gate
          // SURROGATE, `__gate__:*`; the run's current_step_run_id is NULL there,
          // so match the surrogate directly). A dead gate worker is otherwise
          // invisible — reaping it emits session.failed, which onWorkflowSession-
          // Completed routes to completeGateWorker → human escalation. The LEFT
          // JOIN picks up the step run's live activity (if any); the unique partial
          // index idx_activities_one_live_per_step guarantees at most one row.
          `SELECT s.id AS session_id, wsr.goal_id AS goal_id, wsr.id AS step_run_id,
                  s.started_at AS started_at, s.output_seq AS output_seq,
                  a.status AS activity_status, a.source_kind AS activity_source_kind,
                  a.updated_at AS activity_updated_at
           FROM sessions s
           JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id AND wsr.goal_id = s.goal_id
           JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
           LEFT JOIN activities a
             ON a.step_run_id = wsr.id AND a.status IN ('active','paused_for_input')
           WHERE wr.status = 'active'
             AND wsr.status = 'active'
             AND s.status = 'running'
             AND (
                   (wr.current_node_kind = 'step' AND wr.current_step_run_id = wsr.id)
                OR (wr.current_node_kind = 'gate' AND wsr.step_template_id GLOB '__gate__:*')
                 )`
        )
        .all() as Array<{
          session_id: string;
          goal_id: string;
          step_run_id: string;
          started_at: string | null;
          output_seq: number;
          activity_status: string | null;
          activity_source_kind: string | null;
          activity_updated_at: string | null;
        }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        goalId: r.goal_id,
        stepRunId: r.step_run_id,
        startedAtMs: r.started_at ? Date.parse(r.started_at) : null,
        outputSeq: r.output_seq,
        activityAtMs: r.activity_updated_at ? Date.parse(r.activity_updated_at) : null,
        // `permission_pending` is the exception that makes this two conditions rather
        // than one: openActivity inserts EVERY activity as 'active', and only the park
        // paths flip the status, so a worker awaiting tool approval reads as active.
        systemTurn:
          r.activity_status !== "paused_for_input" && r.activity_source_kind !== "permission_pending",
      }));
    },
    hasStepOutput: (stepRunId) =>
      db
        .prepare(
          "SELECT 1 FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' LIMIT 1"
        )
        .get(stepRunId) !== undefined,
    reap: (row) =>
      failSession(db, bus, row.sessionId, row.goalId, "worker_exited_no_signal", opts.now()),
    reapStalled: (row) =>
      failSession(db, bus, row.sessionId, row.goalId, "worker_stalled", opts.now()),
  };
}
