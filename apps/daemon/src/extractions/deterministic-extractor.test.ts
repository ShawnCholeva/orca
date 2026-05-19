import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SessionExtractionInput,
  SessionExtractionOutput,
  type SessionExtractionInput as SessionExtractionInputType,
} from '@orca/contracts';
import {
  DETERMINISTIC_EXTRACTOR_VERSION,
  DeterministicExtractor,
} from './deterministic-extractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.resolve(__dirname, '../../test/fixtures/extractor');

function loadFixture(name: string): SessionExtractionInputType {
  const raw = JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8')) as {
    input: unknown;
  };
  return SessionExtractionInput.parse(raw.input);
}

describe('DeterministicExtractor', () => {
  it('exports the expected extractor version', () => {
    expect(DETERMINISTIC_EXTRACTOR_VERSION).toBe('deterministic-1.0.0');
    expect(new DeterministicExtractor().version).toBe(DETERMINISTIC_EXTRACTOR_VERSION);
  });

  it('clean-exit fixture yields one validation_result candidate', async () => {
    const extractor = new DeterministicExtractor();
    const output = await extractor.extract(loadFixture('clean-exit'));

    SessionExtractionOutput.parse(output);
    expect(output.memoryCandidates.filter((c) => c.type === 'validation_result')).toHaveLength(1);
    expect(output.memoryCandidates.filter((c) => c.type === 'blocker')).toHaveLength(0);
    expect(output.decisionCandidates).toHaveLength(0);
  });

  it('non-zero-exit fixture yields an exit blocker and allows fatal blockers', async () => {
    const extractor = new DeterministicExtractor();
    const output = await extractor.extract(loadFixture('non-zero-exit'));

    SessionExtractionOutput.parse(output);
    const blockers = output.memoryCandidates.filter((c) => c.type === 'blocker');
    expect(blockers.some((b) => b.content.includes('Session exited with code 2'))).toBe(true);
    expect(blockers.length).toBeGreaterThanOrEqual(1);
  });

  it('decision-marker fixture yields one decision candidate', async () => {
    const extractor = new DeterministicExtractor();
    const output = await extractor.extract(loadFixture('decision-marker'));

    SessionExtractionOutput.parse(output);
    expect(output.decisionCandidates).toHaveLength(1);
    expect(output.decisionCandidates[0]?.decisionText).toContain('DECISION: Use SQLite WAL');
  });

  it('vague-prose fixture yields no decision candidates', async () => {
    const extractor = new DeterministicExtractor();
    const output = await extractor.extract(loadFixture('vague-prose'));

    SessionExtractionOutput.parse(output);
    expect(output.decisionCandidates).toHaveLength(0);
  });

  it('todo-and-question fixture yields open_question candidates from both sources', async () => {
    const extractor = new DeterministicExtractor();
    const output = await extractor.extract(loadFixture('todo-and-question'));

    SessionExtractionOutput.parse(output);
    const openQuestions = output.memoryCandidates.filter((c) => c.type === 'open_question');
    expect(openQuestions.length).toBeGreaterThanOrEqual(2);
    expect(openQuestions.some((c) => c.content.includes('tighten retry policy'))).toBe(true);
    expect(openQuestions.some((c) => c.content.includes('Should we keep this adapter?'))).toBe(true);
  });

  it('truncated-input fixture carries truncated=true into summary', async () => {
    const extractor = new DeterministicExtractor();
    const output = await extractor.extract(loadFixture('truncated-input'));

    SessionExtractionOutput.parse(output);
    expect(output.summary?.truncated).toBe(true);
    expect(output.memoryCandidates.length).toBeGreaterThan(0);
  });

  it('empty-output fixture still returns a summary and no candidates', async () => {
    const extractor = new DeterministicExtractor();
    const output = await extractor.extract(loadFixture('empty-output'));

    SessionExtractionOutput.parse(output);
    expect(output.summary).toBeDefined();
    expect(output.summary?.headline.length).toBeGreaterThan(0);
    expect(output.memoryCandidates).toHaveLength(0);
    expect(output.decisionCandidates).toHaveLength(0);
  });
});
