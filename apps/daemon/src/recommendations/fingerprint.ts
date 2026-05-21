import { createHash } from 'node:crypto';

function sortKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val !== null && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj).sort().map((k) => [k, sortKeysDeep(obj[k])])
    );
  }
  return val;
}

/**
 * Canonicalize proposedAction JSON before hashing: sort keys recursively,
 * strip insignificant whitespace. Persist the user-visible JSON verbatim;
 * call this only for fingerprint computation.
 */
export function canonicalizeProposedActionJson(json: string): string {
  return JSON.stringify(sortKeysDeep(JSON.parse(json) as unknown));
}

/**
 * Dedup fingerprint for proposed recommendations.
 * Partial unique index `idx_recs_goal_fingerprint_active` enforces uniqueness
 * while status = 'proposed'.
 */
export function recommendationFingerprint(
  goalId: string,
  type: string,
  canonicalProposedActionJson: string
): string {
  const raw = `${goalId}:${type}:${canonicalProposedActionJson}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Request fingerprint for idempotent generation runs.
 * sha256(goalId:triggerKind:triggerSourceId:providerId:providerVersion:inputFingerprint)
 * Partial unique index `idx_rec_generations_active_fp` enforces one active row
 * per fingerprint (pending|running|succeeded). Failed rows excluded so retry creates
 * a new row.
 */
export function recommendationGenerationRequestFingerprint(
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
