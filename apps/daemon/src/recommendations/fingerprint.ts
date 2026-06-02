import { createHash } from 'node:crypto';
import { computeGenerationRequestFingerprint } from '../generation/fingerprint.js';

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
 * Delegates to the shared orchestrator helper so task and recommendation
 * generations use the same canonical formula.
 */
export function recommendationGenerationRequestFingerprint(
  goalId: string,
  triggerKind: string,
  triggerSourceId: string | null,
  providerId: string,
  providerVersion: string,
  inputFingerprint: string
): string {
  return computeGenerationRequestFingerprint(
    goalId, triggerKind, triggerSourceId, providerId, providerVersion, inputFingerprint
  );
}
