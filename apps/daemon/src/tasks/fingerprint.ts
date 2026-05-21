import { createHash } from 'node:crypto';

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
 * sha256(goalId:triggerKind:triggerSourceId:generatorId:generatorVersion:inputFingerprint)
 * Partial unique index `idx_task_generations_active_fp` enforces one active row
 * per fingerprint (pending|running|succeeded). Failed rows excluded so retry works.
 */
export function taskGenerationRequestFingerprint(
  goalId: string,
  triggerKind: string,
  triggerSourceId: string | null,
  generatorId: string,
  generatorVersion: string,
  inputFingerprint: string
): string {
  const raw = [goalId, triggerKind, triggerSourceId ?? '', generatorId, generatorVersion, inputFingerprint].join(':');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
