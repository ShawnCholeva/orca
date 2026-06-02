import { createHash } from 'node:crypto';

/**
 * Canonical request fingerprint for generation idempotency.
 * sha256(goalId:triggerKind:triggerSourceId:providerId:providerVersion:inputFingerprint)
 *
 * Used by both task and recommendation generation. Partial unique index on
 * (goal_id, request_fingerprint) WHERE status IN ('pending','running','succeeded')
 * prevents duplicate active generations. Failed rows are excluded so retry works.
 */
export function computeGenerationRequestFingerprint(
  goalId: string,
  triggerKind: string,
  triggerSourceId: string | null,
  providerId: string,
  providerVersion: string,
  inputFingerprint: string
): string {
  const raw = [goalId, triggerKind, triggerSourceId ?? '', providerId, providerVersion, inputFingerprint].join(':');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
