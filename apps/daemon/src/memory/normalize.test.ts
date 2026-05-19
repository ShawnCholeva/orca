import { describe, expect, it } from 'vitest';
import { normalizeText, redactSecrets, computeContentHash } from './normalize.js';

describe('normalizeText', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('collapses internal whitespace to single spaces', () => {
    expect(normalizeText('foo   bar\t\nbaz')).toBe('foo bar baz');
  });

  it('caps at default 4000 chars', () => {
    const long = 'a'.repeat(5000);
    expect(normalizeText(long)).toHaveLength(4000);
  });

  it('respects custom maxChars', () => {
    expect(normalizeText('hello world', 5)).toBe('hello');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeText('   \t\n  ')).toBe('');
  });
});

describe('redactSecrets', () => {
  it('redacts password= assignments', () => {
    const result = redactSecrets('password=supersecret123');
    expect(result).toBe('password=[redacted]');
    expect(result).not.toContain('supersecret123');
  });

  it('redacts token= assignments', () => {
    const result = redactSecrets('token=abc123xyz');
    expect(result).not.toContain('abc123xyz');
    expect(result).toContain('token=[redacted]');
  });

  it('redacts api_key= assignments', () => {
    const result = redactSecrets('api_key=my-secret-key');
    expect(result).not.toContain('my-secret-key');
    expect(result).toContain('api_key=[redacted]');
  });

  it('redacts authorization bearer tokens', () => {
    const result = redactSecrets('Authorization: Bearer eyJhbGci');
    expect(result).not.toContain('eyJhbGci');
    expect(result.toLowerCase()).toContain('authorization: bearer [redacted]');
  });

  it('is case-insensitive', () => {
    expect(redactSecrets('PASSWORD=secret')).toContain('PASSWORD=[redacted]');
    expect(redactSecrets('TOKEN=secret')).toContain('TOKEN=[redacted]');
  });

  it('preserves non-secret content', () => {
    const input = 'The deployment completed successfully.';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles multiple secrets in one string', () => {
    const result = redactSecrets('token=abc api_key=xyz');
    expect(result).not.toContain('abc');
    expect(result).not.toContain('xyz');
  });
});

describe('computeContentHash', () => {
  it('returns a hex sha256 string', () => {
    const hash = computeContentHash({ type: 'constraint', content: 'must use TypeScript' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same type and content yields same hash', () => {
    const a = computeContentHash({ type: 'blocker', content: 'DB is down' });
    const b = computeContentHash({ type: 'blocker', content: 'DB is down' });
    expect(a).toBe(b);
  });

  it('different type yields different hash', () => {
    const a = computeContentHash({ type: 'constraint', content: 'same content' });
    const b = computeContentHash({ type: 'blocker', content: 'same content' });
    expect(a).not.toBe(b);
  });

  it('different content yields different hash', () => {
    const a = computeContentHash({ type: 'note', content: 'content A' });
    const b = computeContentHash({ type: 'note', content: 'content B' });
    expect(a).not.toBe(b);
  });
});
