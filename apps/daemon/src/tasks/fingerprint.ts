import { createHash } from 'node:crypto';
import { computeGenerationRequestFingerprint } from '../orchestrator/fingerprint.js';

/**
 * Fingerprint for deduplicating generator-origin tasks.
 * Partial unique index `idx_tasks_goal_fingerprint_active` enforces uniqueness
 * for origin='generator' AND non-terminal status.
 */
export function taskFingerprint(goalId: string, title: string, role: string): string {
  const normalized = title.toLowerCase().trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${goalId}:${normalized}:${role}`, 'utf8').digest('hex');
}

/**
 * Request fingerprint for idempotent generation runs.
 * Delegates to the shared orchestrator helper so task and recommendation
 * generations use the same canonical formula.
 */
export function taskGenerationRequestFingerprint(
  goalId: string,
  triggerKind: string,
  triggerSourceId: string | null,
  generatorId: string,
  generatorVersion: string,
  inputFingerprint: string
): string {
  return computeGenerationRequestFingerprint(
    goalId, triggerKind, triggerSourceId, generatorId, generatorVersion, inputFingerprint
  );
}
