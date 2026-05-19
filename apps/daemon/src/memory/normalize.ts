import { createHash } from 'node:crypto';

const DEFAULT_MAX_CHARS = 4000;

export function normalizeText(s: string, maxChars = DEFAULT_MAX_CHARS): string {
  return s.trim().replace(/\s+/g, ' ').slice(0, maxChars);
}

export function redactSecrets(s: string): string {
  return s
    .replace(/\b(password|token|api_key)\s*=\s*\S+/gi, (match) => {
      const eqIdx = match.indexOf('=');
      return match.slice(0, eqIdx + 1) + '[redacted]';
    })
    .replace(/authorization\s*:\s*bearer\s+\S+/gi, 'authorization: bearer [redacted]');
}

export function computeContentHash({ type, content }: { type: string; content: string }): string {
  return createHash('sha256').update(type + '' + content).digest('hex');
}
