import type Database from "better-sqlite3";
import type { SessionInterval } from "@orca/contracts";

/**
 * Every session that was alive at some point inside [from, to]: it began before
 * the window closed and either has not ended or ended after the window opened.
 * `started_at` is the moment the process ran; `created_at` stands in for a
 * session that never got that far.
 */
export function listSessionIntervals(db: Database.Database, fromIso: string, toIso: string): SessionInterval[] {
  const rows = db.prepare(
    `SELECT id, goal_id, adapter_id, status, created_at, started_at, exited_at
     FROM sessions
     WHERE COALESCE(started_at, created_at) < ?
       AND (exited_at IS NULL OR exited_at >= ?)
     ORDER BY COALESCE(started_at, created_at) ASC, id ASC`
  ).all(toIso, fromIso) as Array<{
    id: string; goal_id: string; adapter_id: string; status: string;
    created_at: string; started_at: string | null; exited_at: string | null;
  }>;
  return rows.map((r) => ({
    sessionId: r.id, goalId: r.goal_id, adapterId: r.adapter_id, status: r.status,
    startedAt: r.started_at ?? r.created_at,
    endedAt: r.exited_at,
  }));
}
