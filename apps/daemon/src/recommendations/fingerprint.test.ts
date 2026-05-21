import { describe, expect, it } from 'vitest';
import {
  canonicalizeProposedActionJson,
  recommendationFingerprint,
  recommendationGenerationRequestFingerprint,
} from './fingerprint.js';

describe('canonicalizeProposedActionJson', () => {
  it('sorts keys deterministically', () => {
    const a = JSON.stringify({ kind: 'ask_user', question: 'Why?' });
    const b = JSON.stringify({ question: 'Why?', kind: 'ask_user' });
    expect(canonicalizeProposedActionJson(a)).toBe(canonicalizeProposedActionJson(b));
  });

  it('sorts nested keys', () => {
    const a = JSON.stringify({ kind: 'ask_user', meta: { z: 1, a: 2 } });
    const b = JSON.stringify({ kind: 'ask_user', meta: { a: 2, z: 1 } });
    expect(canonicalizeProposedActionJson(a)).toBe(canonicalizeProposedActionJson(b));
  });

  it('preserves array order', () => {
    const a = JSON.stringify({ kind: 'refine_goal', missingFields: ['b', 'a'] });
    const b = JSON.stringify({ kind: 'refine_goal', missingFields: ['a', 'b'] });
    expect(canonicalizeProposedActionJson(a)).not.toBe(canonicalizeProposedActionJson(b));
  });

  it('produces compact JSON (no extra whitespace)', () => {
    const canon = canonicalizeProposedActionJson(JSON.stringify({ kind: 'ask_user', question: 'Q?' }));
    expect(canon).not.toContain('\n');
    expect(canon).not.toContain('  ');
  });
});

describe('recommendationFingerprint', () => {
  it('is deterministic for same inputs', () => {
    const fp1 = recommendationFingerprint('g1', 'ask_user', '{"kind":"ask_user","question":"Q?"}');
    const fp2 = recommendationFingerprint('g1', 'ask_user', '{"kind":"ask_user","question":"Q?"}');
    expect(fp1).toBe(fp2);
  });

  it('differs for different goalId', () => {
    const fp1 = recommendationFingerprint('g1', 'ask_user', '{"kind":"ask_user","question":"Q?"}');
    const fp2 = recommendationFingerprint('g2', 'ask_user', '{"kind":"ask_user","question":"Q?"}');
    expect(fp1).not.toBe(fp2);
  });

  it('differs for different type', () => {
    const fp1 = recommendationFingerprint('g1', 'ask_user', '{"kind":"ask_user","question":"Q?"}');
    const fp2 = recommendationFingerprint('g1', 'refine_goal', '{"kind":"ask_user","question":"Q?"}');
    expect(fp1).not.toBe(fp2);
  });

  it('differs for different canonicalProposedActionJson', () => {
    const fp1 = recommendationFingerprint('g1', 'ask_user', '{"kind":"ask_user","question":"A?"}');
    const fp2 = recommendationFingerprint('g1', 'ask_user', '{"kind":"ask_user","question":"B?"}');
    expect(fp1).not.toBe(fp2);
  });

  it('returns a 64-char hex string', () => {
    expect(recommendationFingerprint('g1', 'ask_user', '{}')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('recommendationGenerationRequestFingerprint', () => {
  it('is deterministic for same inputs', () => {
    const fp1 = recommendationGenerationRequestFingerprint('g1', 'manual', null, 'p1', '0.1.0', 'inputfp');
    const fp2 = recommendationGenerationRequestFingerprint('g1', 'manual', null, 'p1', '0.1.0', 'inputfp');
    expect(fp1).toBe(fp2);
  });

  it('null triggerSourceId treated same as empty string', () => {
    expect(
      recommendationGenerationRequestFingerprint('g1', 'manual', null, 'p', '1', 'fp')
    ).toBe(
      recommendationGenerationRequestFingerprint('g1', 'manual', '', 'p', '1', 'fp')
    );
  });

  it('differs for different triggerSourceId', () => {
    expect(
      recommendationGenerationRequestFingerprint('g1', 'manual', 'src-1', 'p', '1', 'fp')
    ).not.toBe(
      recommendationGenerationRequestFingerprint('g1', 'manual', 'src-2', 'p', '1', 'fp')
    );
  });

  it('differs for different providerVersion', () => {
    expect(
      recommendationGenerationRequestFingerprint('g1', 'manual', null, 'p', '0.1.0', 'fp')
    ).not.toBe(
      recommendationGenerationRequestFingerprint('g1', 'manual', null, 'p', '0.2.0', 'fp')
    );
  });

  it('returns a 64-char hex string', () => {
    expect(
      recommendationGenerationRequestFingerprint('g1', 'manual', null, 'p', '1', 'fp')
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
