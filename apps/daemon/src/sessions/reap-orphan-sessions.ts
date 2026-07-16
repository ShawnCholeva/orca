import type Database from "better-sqlite3";
import { killSession, listSessions, type TmuxRunner } from "../tmux/runner.js";
import { tmuxSessionName } from "../orchestrator-llm/shadow-session.js";

const WORKER_PREFIX = "orca-worker-";
const SHADOW_PREFIX = "orca-shadow-";

// The still-running worker sessions of a run. Used to tear down leaked workers
// when a run reaches a terminal state WITHOUT completing (cancel/fail/block
// mid-step): the run-terminal cleanup otherwise only kills the shadow.
export function workerSessionIdsForRun(db: Database.Database, runId: string): string[] {
  return (
    db
      .prepare(
        `SELECT s.id AS id FROM sessions s
         JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id
         WHERE wsr.workflow_run_id = ? AND s.status IN ('running', 'starting')`
      )
      .all(runId) as Array<{ id: string }>
  ).map((r) => r.id);
}

// Boot-time sweep of orphaned `orca-worker-*` / `orca-shadow-*` tmux sessions
// left by a prior daemon generation (tmux sessions outlive the daemon, and
// neither shutdown nor boot reconciliation reaps them). Keep only:
//   - worker sessions whose DB session belongs to a still-active run, and
//   - shadow (+ __refute) sessions of a goal that still has an active run.
// Everything else is unreachable — workers are never reattached once their run
// is terminal, and orphaned shadows self-heal on the next spawn (same-named
// kill-and-recreate) — so it only leaks. MUST run AFTER resumeActiveRuns has
// reattached, so a wanted worker is never killed out from under a reattach.
export async function reapOrphanTmuxSessions(r: TmuxRunner, db: Database.Database): Promise<string[]> {
  const ours = (await listSessions(r)).filter(
    (n) => n.startsWith(WORKER_PREFIX) || n.startsWith(SHADOW_PREFIX)
  );
  if (ours.length === 0) return [];

  const keepWorkers = new Set(
    (
      db
        .prepare(
          `SELECT s.id AS id FROM sessions s
           JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id
           JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
           WHERE wr.status = 'active' AND s.status IN ('running', 'starting')`
        )
        .all() as Array<{ id: string }>
    ).map((row) => `${WORKER_PREFIX}${row.id}`)
  );

  const keepShadows = new Set<string>();
  for (const row of db
    .prepare("SELECT DISTINCT goal_id AS gid FROM workflow_runs WHERE status = 'active'")
    .all() as Array<{ gid: string }>) {
    keepShadows.add(tmuxSessionName(row.gid));
    keepShadows.add(tmuxSessionName(`${row.gid}::refute`));
  }

  const reaped: string[] = [];
  for (const name of ours) {
    const keep = name.startsWith(WORKER_PREFIX) ? keepWorkers.has(name) : keepShadows.has(name);
    if (keep) continue;
    await killSession(r, name);
    reaped.push(name);
  }
  return reaped;
}
