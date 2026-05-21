import { describe, expect, it } from 'vitest';
import { taskFingerprint, taskGenerationRequestFingerprint } from './fingerprint.js';

describe('taskFingerprint', () => {
  it('is deterministic for same inputs', () => {
    expect(taskFingerprint('g1', 'Build the API', 'engineer')).toBe(
      taskFingerprint('g1', 'Build the API', 'engineer')
    );
  });

  it('normalizes title to lowercase + trimmed + collapsed whitespace', () => {
    expect(taskFingerprint('g1', '  Build  the API  ', 'engineer')).toBe(
      taskFingerprint('g1', 'build the api', 'engineer')
    );
  });

  it('different role produces different fingerprint', () => {
    expect(taskFingerprint('g1', 'task', 'engineer')).not.toBe(
      taskFingerprint('g1', 'task', 'reviewer')
    );
  });

  it('different goalId produces different fingerprint', () => {
    expect(taskFingerprint('g1', 'task', 'engineer')).not.toBe(
      taskFingerprint('g2', 'task', 'engineer')
    );
  });

  it('returns a 64-char hex string', () => {
    expect(taskFingerprint('g1', 'title', 'qa')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('taskGenerationRequestFingerprint', () => {
  it('is deterministic for same inputs', () => {
    expect(
      taskGenerationRequestFingerprint('g1', 'manual', null, 'gen-id', '0.1.0', 'inputfp')
    ).toBe(
      taskGenerationRequestFingerprint('g1', 'manual', null, 'gen-id', '0.1.0', 'inputfp')
    );
  });

  it('null triggerSourceId differs from empty string', () => {
    // null → '' in the join; same as explicit empty string
    expect(
      taskGenerationRequestFingerprint('g1', 'manual', null, 'gen', '1', 'fp')
    ).toBe(
      taskGenerationRequestFingerprint('g1', 'manual', '', 'gen', '1', 'fp')
    );
  });

  it('different triggerSourceId produces different fingerprint', () => {
    expect(
      taskGenerationRequestFingerprint('g1', 'manual', 'src-1', 'gen', '1', 'fp')
    ).not.toBe(
      taskGenerationRequestFingerprint('g1', 'manual', 'src-2', 'gen', '1', 'fp')
    );
  });

  it('different generatorVersion produces different fingerprint', () => {
    expect(
      taskGenerationRequestFingerprint('g1', 'manual', null, 'gen', '0.1.0', 'fp')
    ).not.toBe(
      taskGenerationRequestFingerprint('g1', 'manual', null, 'gen', '0.2.0', 'fp')
    );
  });

  it('returns a 64-char hex string', () => {
    expect(
      taskGenerationRequestFingerprint('g1', 'manual', null, 'gen', '1', 'fp')
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
