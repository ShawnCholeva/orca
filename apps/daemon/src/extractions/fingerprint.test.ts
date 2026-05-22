import { describe, expect, it } from 'vitest';
import { computeSourceFingerprint } from './fingerprint.js';

describe('computeSourceFingerprint', () => {
  it('returns a 64-char hex string', () => {
    const fp = computeSourceFingerprint({
      sessionId: 'sess-1',
      sourceOffsetFirst: 0,
      sourceOffsetLast: 1024,
      extractorVersion: 'memory-deterministic-v1',
    });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash for the same inputs', () => {
    const input = {
      sessionId: 'sess-abc',
      sourceOffsetFirst: 100,
      sourceOffsetLast: 5000,
      extractorVersion: 'v2',
    };
    expect(computeSourceFingerprint(input)).toBe(computeSourceFingerprint(input));
  });

  it('produces different hashes for different offsets', () => {
    const base = { sessionId: 's', sourceOffsetFirst: 0, sourceOffsetLast: 100, extractorVersion: 'v1' };
    const a = computeSourceFingerprint(base);
    const b = computeSourceFingerprint({ ...base, sourceOffsetLast: 200 });
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different extractor versions', () => {
    const base = { sessionId: 's', sourceOffsetFirst: 0, sourceOffsetLast: 100, extractorVersion: 'v1' };
    const a = computeSourceFingerprint(base);
    const b = computeSourceFingerprint({ ...base, extractorVersion: 'v2' });
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different session ids', () => {
    const base = { sessionId: 'sess-1', sourceOffsetFirst: 0, sourceOffsetLast: 100, extractorVersion: 'v1' };
    const a = computeSourceFingerprint(base);
    const b = computeSourceFingerprint({ ...base, sessionId: 'sess-2' });
    expect(a).not.toBe(b);
  });
});
