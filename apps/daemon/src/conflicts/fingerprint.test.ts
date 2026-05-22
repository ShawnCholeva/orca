import { describe, expect, it } from 'vitest';
import { conflictFingerprint } from './fingerprint.js';

describe('conflictFingerprint', () => {
  it('produces a hex string', () => {
    const fp = conflictFingerprint('g1', 'workspace_overlap', ['s1', 's2']);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const a = conflictFingerprint('g1', 'blocker_reported', ['source-a', 'source-b', 'source-c']);
    const b = conflictFingerprint('g1', 'blocker_reported', ['source-a', 'source-b', 'source-c']);
    expect(a).toBe(b);
  });

  it('sorts source ids for determinism', () => {
    const a = conflictFingerprint('g1', 'workspace_overlap', ['s2', 's1']);
    const b = conflictFingerprint('g1', 'workspace_overlap', ['s1', 's2']);
    expect(a).toBe(b);
  });

  it('differs across conflict types', () => {
    const a = conflictFingerprint('g1', 'workspace_overlap', ['s1']);
    const b = conflictFingerprint('g1', 'blocker_reported', ['s1']);
    expect(a).not.toBe(b);
  });

  it('differs across goals', () => {
    const a = conflictFingerprint('g1', 'workspace_overlap', ['s1']);
    const b = conflictFingerprint('g2', 'workspace_overlap', ['s1']);
    expect(a).not.toBe(b);
  });

  it('differs across source sets', () => {
    const a = conflictFingerprint('g1', 'workspace_overlap', ['s1']);
    const b = conflictFingerprint('g1', 'workspace_overlap', ['s1', 's2']);
    expect(a).not.toBe(b);
  });
});
