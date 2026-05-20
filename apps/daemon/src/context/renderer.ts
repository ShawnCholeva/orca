import type { ContextSection } from '@orca/contracts';
import { redactSecrets } from '../memory/normalize.js';

export interface RenderResult {
  rendered: string;
  renderedBytes: number;
  estimatedTokens: number;
}

/**
 * Joins assembled sections into canonical newline-terminated plaintext.
 * Applies redaction to each section body as defense in depth —
 * input builder already redacts; this catches any remainder.
 */
export function renderToCanonical(sections: ContextSection[]): RenderResult {
  const parts: string[] = [];
  for (const section of sections) {
    const body = redactSecrets(section.body);
    parts.push(`# ${section.title}\n${body}`);
  }
  const rendered = (parts.length > 0 ? parts.join('\n') : '') + '\n';
  const renderedBytes = Buffer.byteLength(rendered, 'utf8');
  const estimatedTokens = Math.ceil(renderedBytes / 4);
  return { rendered, renderedBytes, estimatedTokens };
}
