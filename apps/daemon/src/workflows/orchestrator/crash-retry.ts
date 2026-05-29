export const CRASH_RETRY_CAP = 3;

export function incrementCrashRetry(current: number): {
  nextAttempt: number;
  capReached: boolean;
} {
  const next = current + 1;
  return { nextAttempt: next, capReached: next >= CRASH_RETRY_CAP };
}
