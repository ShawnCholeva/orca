import { createHash } from 'node:crypto';

/**
 * Dedup fingerprint for open conflicts.
 * Partial unique index `idx_conflicts_goal_fp_open` enforces uniqueness
 * while status = 'open'. Source ids are sorted for determinism.
 */
export function conflictFingerprint(
  goalId: string,
  conflictType: string,
  sortedSourceIds: string[]
): string {
  const sorted = [...sortedSourceIds].sort().join(',');
  const raw = `${goalId}:${conflictType}:${sorted}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
