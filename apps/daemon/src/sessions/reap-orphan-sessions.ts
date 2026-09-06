import type Database from "better-sqlite3";
import { killSession, listSessions, sessionOwner, type TmuxRunner } from "../tmux/runner.js";
import { liveSessionSql } from "./live-session.js";
import { tmuxSessionName } from "../orchestrator-llm/shadow-session.js";

const WORKER_PREFIX = "orca-worker-";
const SHADOW_PREFIX = "orca-shadow-";

// The still-live worker sessions of a run. Used to tear down leaked workers
// when a run reaches a terminal state WITHOUT completing (cancel/fail/block
// mid-step): the run-terminal cleanup otherwise only kills the shadow.
//
// Same terminal-denylist as the keep-set below, and for the same reason — the
// old `IN ('running','starting')` could not see a worker still at `created`.
// One dead status value produced both halves of the defect: the boot sweep
// killed live workers it should have kept, and this teardown missed leaked
// workers it should have killed.
export function workerSessionIdsForRun(db: Database.Database, runId: string): string[] {
  return (
    db
      .prepare(
        `SELECT s.id AS id FROM sessions s
         JOIN workflow_step_runs wsr ON wsr.id = s.workflow_step_run_id
         WHERE wsr.workflow_run_id = ?
           AND ${liveSessionSql("s.status")}`
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
//
// The worker keep-set excludes TERMINAL statuses rather than listing live ones.
// It used to allow-list `('running','starting')`, which silently omitted
// `created` — the status every session is INSERTed with (sessions/usecases.ts)
// and holds for the whole of spawn(), since markRunning fires only after the
// config-dir writes, newSession, pipePaneToFile and startTail. A boot reap
// landing in that window killed a live, just-spawned worker mid-turn, leaving
// no exit code or signal; the liveness watchdog then reported it as
// `worker_exited_no_signal` and three of those blocked the run.
// `starting` compounded it by reading like a deliberate guard for exactly that
// window while never being written by any code path. A denylist is correct by
// construction: a new pre-running status can leak a pane, but can never again
// get a live agent killed — the asymmetry this sweep should have had from the
// start, given that being wrong in one direction only wastes a tmux session and
// being wrong in the other destroys work.
//
// `owner` is this daemon's data dir. Only sessions tagged with it are eligible:
// a session tagged for another data dir belongs to another daemon (a test
// booting against a temp dir, a second install), and an untagged one predates
// the tag. Both are left alone — a leaked pane costs a tmux session; a killed
// live agent costs the work — and counted in the log so the leak is visible.
export async function reapOrphanTmuxSessions(r: TmuxRunner, db: Database.Database, owner: string): Promise<string[]> {
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
           WHERE wr.status = 'active'
             AND ${liveSessionSql("s.status")}`
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
  let foreign = 0;
  for (const name of ours) {
    const keep = name.startsWith(WORKER_PREFIX) ? keepWorkers.has(name) : keepShadows.has(name);
    if (keep) continue;
    if ((await sessionOwner(r, name)) !== owner) { foreign += 1; continue; }
    await killSession(r, name, "boot reap: not kept for any active run");
    reaped.push(name);
  }
  if (foreign > 0) console.log(`[reap] left ${foreign} orca tmux session(s) owned by another daemon or untagged`);
  return reaped;
}
