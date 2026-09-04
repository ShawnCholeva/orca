export const CRASH_RETRY_CAP = 3;

/**
 * When this daemon process started. Module-load time is process-start time, and
 * every session's `started_at` is written with the same `new Date().toISOString()`
 * format, so the two compare lexicographically.
 */
export const DAEMON_STARTED_AT = new Date().toISOString();

/**
 * True when the failed session belonged to a PREVIOUS daemon process.
 *
 * The rescue budget exists to stop an agent that cannot do the work. A daemon
 * restart is not evidence about the agent: the run is otherwise healthy, the
 * work on disk is intact, and the worker died because the substrate went away
 * underneath it. Spending a retry on that conflates infrastructure failure with
 * workflow failure in the CONTROL path — the same conflation `terminationCause`
 * and `infrastructureFailures` were added to remove from the reporting path.
 *
 * This is not a dev-only concern. Orca is a local-first desktop app, so the
 * daemon restarts for upgrades, crashes, OOM, machine sleep and a closing laptop
 * lid. One restart consuming a retry from a healthy run is a production bug;
 * three across a long run block it outright.
 *
 * Deliberately structural rather than heuristic: it does not guess from the
 * failure reason, it asks whether the session predates this process. A session
 * that both started and died under one daemon generation is a real crash and
 * still spends the budget.
 */
export function isSubstrateRelaunch(
  sessionStartedAt: string | null | undefined,
  daemonStartedAt: string | undefined = DAEMON_STARTED_AT
): boolean {
  if (!sessionStartedAt) return false;
  return sessionStartedAt < (daemonStartedAt ?? DAEMON_STARTED_AT);
}

export function incrementCrashRetry(current: number): {
  nextAttempt: number;
  capReached: boolean;
} {
  const next = current + 1;
  return { nextAttempt: next, capReached: next >= CRASH_RETRY_CAP };
}
