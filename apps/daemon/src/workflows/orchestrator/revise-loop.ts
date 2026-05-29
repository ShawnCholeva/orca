export const REVISE_CAP = 3;

export function incrementReviseAttempt(currentAttempts: number): { nextAttempt: number; capReached: boolean } {
  const nextAttempt = currentAttempts + 1;
  return { nextAttempt, capReached: nextAttempt >= REVISE_CAP };
}
