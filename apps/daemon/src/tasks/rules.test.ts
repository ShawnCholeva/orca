import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskFingerprint } from './fingerprint.js';
import { generateTasks } from './rules.js';
import type { TaskGenerationInput } from './input.js';

interface FixtureFile {
  name: string;
  goalDescription: string;
  successCriteria: string[];
}

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

function fixtureToInput(fixture: FixtureFile): TaskGenerationInput {
  return {
    goalId: `goal-${fixture.name}`,
    objective: fixture.goalDescription,
    refinement: {
      id: `goal-${fixture.name}`,
      refinedAt: '2026-01-01T00:00:00.000Z',
      successCriteria: fixture.successCriteria,
      constraints: [],
      assumptions: [],
    },
    workspaces: [],
    existingGeneratorTasks: [],
    inputFingerprint: `fp-${fixture.name}`,
  };
}

describe('generateTasks', () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();

  for (const fileName of fixtureFiles) {
    it(`snapshot fixture: ${fileName}`, () => {
      const raw = readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8');
      const fixture = JSON.parse(raw) as FixtureFile;
      const output = generateTasks(fixtureToInput(fixture));
      expect(output).toMatchSnapshot();
    });
  }

  it('drops candidates whose fingerprints match existing generator tasks', () => {
    const input = fixtureToInput({
      name: 'dedupe',
      goalDescription: '',
      successCriteria: ['Build deterministic generation endpoint'],
    });

    const first = generateTasks(input);
    const firstCandidate = first.candidates[0];
    const existingFingerprint = taskFingerprint(
      input.goalId,
      firstCandidate.title,
      firstCandidate.role
    );

    const deduped = generateTasks({
      ...input,
      existingGeneratorTasks: [
        {
          id: 'task-existing',
          title: firstCandidate.title,
          role: firstCandidate.role,
          status: 'open',
          fingerprint: existingFingerprint,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(deduped.candidates).toHaveLength(0);
    expect(deduped.sparse).toBe(true);
  });

  it('infers workspace when exactly one workspace is attached', () => {
    const input = fixtureToInput({
      name: 'workspace-default',
      goalDescription: '',
      successCriteria: ['Implement migration'],
    });
    input.workspaces = [{ id: 'ws-1', isDirty: false }];

    const output = generateTasks(input);
    expect(output.candidates).toHaveLength(1);
    expect(output.candidates[0].workspaceId).toBe('ws-1');
  });
});

