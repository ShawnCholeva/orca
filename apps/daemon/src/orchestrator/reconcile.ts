import type Database from 'better-sqlite3';

/**
 * Stub for boot reconciliation of in-flight generation rows.
 * Full implementation in M7-012: marks stale pending/running task and
 * recommendation generation rows as failed with daemon_restart before HTTP listen.
 */
export async function reconcileInFlightGenerations(_db: Database.Database): Promise<void> {
  // M7-012 implements this.
}
