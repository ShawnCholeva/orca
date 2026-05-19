import { createHash } from 'node:crypto';

export interface FingerprintInput {
  sessionId: string;
  sourceOffsetFirst: number;
  sourceOffsetLast: number;
  extractorVersion: string;
}

export function computeSourceFingerprint(input: FingerprintInput): string {
  const { sessionId, sourceOffsetFirst, sourceOffsetLast, extractorVersion } = input;
  const canonical = `${sessionId}:${sourceOffsetFirst}:${sourceOffsetLast}:${extractorVersion}`;
  return createHash('sha256').update(canonical).digest('hex');
}
