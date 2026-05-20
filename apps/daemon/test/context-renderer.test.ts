import { describe, expect, it } from 'vitest';
import { renderToCanonical } from '../src/context/renderer.js';
import type { ContextSection } from '@orca/contracts';

function makeSection(overrides: Partial<ContextSection> & Pick<ContextSection, 'kind' | 'title' | 'body'>): ContextSection {
  return { markers: [], ...overrides };
}

describe('renderToCanonical', () => {
  it('produces final-newline-terminated plaintext', () => {
    const { rendered } = renderToCanonical([makeSection({ kind: 'objective', title: 'Objective', body: 'Do the thing\n' })]);
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('formats each section as # Title\\nbody', () => {
    const { rendered } = renderToCanonical([
      makeSection({ kind: 'objective', title: 'Objective', body: 'Objective body\n' }),
      makeSection({ kind: 'memory', title: 'Memory', body: 'Memory body\n' }),
    ]);
    expect(rendered).toBe('# Objective\nObjective body\n\n# Memory\nMemory body\n\n');
  });

  it('returns empty-section rendered text for zero sections', () => {
    const { rendered } = renderToCanonical([]);
    expect(rendered).toBe('\n');
  });

  it('byte counting matches Buffer.byteLength', () => {
    const sections = [makeSection({ kind: 'objective', title: 'Objective', body: 'hello ☃\n' })];
    const { rendered, renderedBytes } = renderToCanonical(sections);
    expect(renderedBytes).toBe(Buffer.byteLength(rendered, 'utf8'));
  });

  it('estimatedTokens = ceil(renderedBytes / 4)', () => {
    const { renderedBytes, estimatedTokens } = renderToCanonical([
      makeSection({ kind: 'objective', title: 'Objective', body: 'x'.repeat(100) + '\n' }),
    ]);
    expect(estimatedTokens).toBe(Math.ceil(renderedBytes / 4));
  });

  it('applies redaction to section bodies', () => {
    const { rendered } = renderToCanonical([
      makeSection({
        kind: 'memory',
        title: 'Memory',
        body: 'token=supersecret constraint here\n',
        markers: [],
      }),
    ]);
    expect(rendered).not.toContain('supersecret');
    expect(rendered).toContain('[redacted]');
  });

  it('no marker leakage between sections — each section content is isolated', () => {
    const { rendered } = renderToCanonical([
      makeSection({ kind: 'objective', title: 'Objective', body: '[goal:abc] body\n', markers: ['[goal:abc]'] }),
      makeSection({ kind: 'memory', title: 'Memory', body: '[mem:xyz] body\n', markers: ['[mem:xyz]'] }),
    ]);
    const objSection = rendered.split('\n# ')[0] ?? '';
    expect(objSection).not.toContain('[mem:xyz]');
  });
});
