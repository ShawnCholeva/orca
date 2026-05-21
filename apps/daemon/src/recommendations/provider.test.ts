import { describe, expect, it } from 'vitest';
import type { RecommendationInput } from './input.js';
import {
  DeterministicRecommendationProvider,
  FakeRecommendationProvider,
  RecommendationProviderOutputSchema,
} from './provider.js';

// ── Minimal input ──────────────────────────────────────────────────────────────

function baseInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    goalId: 'goal-1',
    objective: 'Build auth system',
    refinement: null,
    workspaces: [],
    tasks: [],
    sessions: [],
    sessionSummaries: [],
    decisions: [],
    memoryItems: [],
    latestContextPackageId: null,
    activeRecommendations: [],
    activeConflicts: [],
    recentFeedback: [],
    inputFingerprint: 'fp-1',
    ...overrides,
  };
}

// ── DeterministicRecommendationProvider ───────────────────────────────────────

describe('DeterministicRecommendationProvider', () => {
  it('has correct id and version', () => {
    const p = new DeterministicRecommendationProvider();
    expect(p.id).toBe('orca/deterministic-recommendation-provider');
    expect(p.version).toBe('0.1.0');
  });

  it('returns sparse=true and empty candidates for a fully empty goal with refinement', async () => {
    const p = new DeterministicRecommendationProvider();
    const output = await p.generate(
      baseInput({
        refinement: {
          goalId: 'goal-1',
          successCriteria: ['Users can log in'],
          constraints: [],
          assumptions: [],
          refinedAt: '2025-01-01T00:00:00.000Z',
        },
      })
    );
    // No triggering conditions: no tasks, no sessions, no decisions with confirmRequired, no open questions
    expect(output.sparse).toBe(true);
    expect(output.candidates).toHaveLength(0);
  });

  it('returns refine_goal recommendation for goal with no refinement (sparse=false)', async () => {
    const p = new DeterministicRecommendationProvider();
    const output = await p.generate(baseInput());
    expect(output.sparse).toBe(false);
    expect(output.candidates).toHaveLength(1);
    expect(output.candidates[0].type).toBe('refine_goal');
  });

  it('validates output schema — discriminator mismatch is rejected', async () => {
    // Provide malformed candidate via fake provider
    const result = RecommendationProviderOutputSchema.safeParse({
      candidates: [
        {
          type: 'ask_user',
          title: 'Test',
          rationale: 'Rationale',
          proposedAction: { kind: 'refine_goal', missingFields: ['objective'] }, // mismatch
          confidence: 0.9,
          sources: [],
        },
      ],
      warnings: [],
      sparse: false,
    });
    expect(result.success).toBe(false);
  });

  it('caps output to 10 candidates, appends a warning', async () => {
    const p = new DeterministicRecommendationProvider();

    // Create 12 open tasks with no sessions → 12 create_session candidates
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      id: `t-${i}`,
      title: `Task ${i}`,
      role: 'engineer' as const,
      status: 'open' as const,
      workspaceId: null,
      parentTaskId: null,
      description: '',
      acceptanceCriteria: [],
      sources: [],
      fingerprint: `fp-${i}`,
      updatedAt: '2025-01-01T00:00:00.000Z',
    }));

    const output = await p.generate(baseInput({ tasks, refinement: { goalId: 'goal-1', successCriteria: ['x'], constraints: [], assumptions: [], refinedAt: '2025-01-01T00:00:00.000Z' } }));
    expect(output.candidates.length).toBeLessThanOrEqual(10);
    expect(output.warnings.length).toBeGreaterThan(0);
    expect(output.warnings[0]).toContain('Dropped');
  });

  it('deduplicates candidates with same fingerprint within generation', async () => {
    const p = new DeterministicRecommendationProvider();

    // Same open task → create_session rule fires once
    const task = {
      id: 't-1', title: 'Task', role: 'engineer' as const, status: 'open' as const,
      workspaceId: null, parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
    };

    const output = await p.generate(baseInput({
      tasks: [task],
      refinement: { goalId: 'goal-1', successCriteria: ['x'], constraints: [], assumptions: [], refinedAt: '2025-01-01T00:00:00.000Z' },
    }));

    const createSessionCandidates = output.candidates.filter((c) => c.type === 'create_session');
    expect(createSessionCandidates.length).toBe(1);
  });

  it('returns deterministic output for same input', async () => {
    const p = new DeterministicRecommendationProvider();
    const input = baseInput();
    const a = await p.generate(input);
    const b = await p.generate(input);
    expect(a).toEqual(b);
  });
});

// ── Output schema validation ───────────────────────────────────────────────────

describe('RecommendationProviderOutputSchema', () => {
  it('accepts valid output', () => {
    const result = RecommendationProviderOutputSchema.safeParse({
      candidates: [
        {
          type: 'refine_goal',
          title: 'Add success criteria',
          rationale: 'Goal is missing required fields',
          proposedAction: { kind: 'refine_goal', missingFields: ['success_criteria'] },
          confidence: 0.9,
          sources: [],
        },
      ],
      warnings: [],
      sparse: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects confidence out of [0,1]', () => {
    const result = RecommendationProviderOutputSchema.safeParse({
      candidates: [
        {
          type: 'refine_goal',
          title: 'Test',
          rationale: '',
          proposedAction: { kind: 'refine_goal', missingFields: ['objective'] },
          confidence: 1.5,
          sources: [],
        },
      ],
      warnings: [],
      sparse: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 32 sources', () => {
    const sources = Array.from({ length: 33 }, (_, i) => ({ type: 'task', id: `t-${i}` }));
    const result = RecommendationProviderOutputSchema.safeParse({
      candidates: [
        {
          type: 'refine_goal',
          title: 'Test',
          rationale: '',
          proposedAction: { kind: 'refine_goal', missingFields: ['objective'] },
          confidence: 0.9,
          sources,
        },
      ],
      warnings: [],
      sparse: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects oversize title (> 256 chars)', () => {
    const result = RecommendationProviderOutputSchema.safeParse({
      candidates: [
        {
          type: 'refine_goal',
          title: 'x'.repeat(257),
          rationale: '',
          proposedAction: { kind: 'refine_goal', missingFields: ['objective'] },
          confidence: 0.9,
          sources: [],
        },
      ],
      warnings: [],
      sparse: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects oversize proposedAction JSON (> 4 KiB)', () => {
    const bigField = 'x'.repeat(5000);
    const result = RecommendationProviderOutputSchema.safeParse({
      candidates: [
        {
          type: 'ask_user',
          title: 'Test',
          rationale: '',
          proposedAction: { kind: 'ask_user', question: bigField },
          confidence: 0.5,
          sources: [],
        },
      ],
      warnings: [],
      sparse: false,
    });
    expect(result.success).toBe(false);
  });
});

// ── FakeRecommendationProvider ─────────────────────────────────────────────────

describe('FakeRecommendationProvider', () => {
  it('returns configured fixtures', async () => {
    const p = new FakeRecommendationProvider();
    p.setFixtures([
      {
        type: 'refine_goal',
        title: 'Fake refine',
        rationale: 'Fake rationale',
        proposedAction: { kind: 'refine_goal', missingFields: ['objective'] },
        confidence: 0.9,
        sources: [],
      },
    ]);
    const output = await p.generate(baseInput());
    expect(output.candidates).toHaveLength(1);
    expect(output.candidates[0].type).toBe('refine_goal');
  });

  it('throws configured error', async () => {
    const p = new FakeRecommendationProvider();
    p.setError(new Error('provider exploded'));
    await expect(p.generate(baseInput())).rejects.toThrow('provider exploded');
  });

  it('returns sparse=true when no fixtures', async () => {
    const p = new FakeRecommendationProvider();
    const output = await p.generate(baseInput());
    expect(output.sparse).toBe(true);
    expect(output.candidates).toHaveLength(0);
  });
});

// ── Privacy: no body text in logs ─────────────────────────────────────────────

describe('provider privacy', () => {
  it('provider.ts does not log or expose memory/decision/summary bodies', () => {
    // Static check: ensure provider.ts does not have console.log with body field references
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'provider.ts'), 'utf8');

    // Provider should not reference body text fields in logs
    expect(src).not.toContain('summaryText');
    expect(src).not.toContain('decisionText');
    expect(src).not.toContain('content:');
    expect(src).not.toContain('console.log');
  });

  it('decision body text (source content) does not appear in provider output proposedAction', async () => {
    const p = new DeterministicRecommendationProvider();

    const input = baseInput({
      decisions: [{
        id: 'd-1',
        title: 'API Key decision',
        status: 'proposed',
        confirmationRequired: true,
        // This body text must NOT leak into proposedAction output
        decisionText: 'token=supersecret123 and api_key=abcdef',
        updatedAt: '2025-01-01T00:00:00.000Z',
      }],
    });

    const output = await p.generate(input);
    const serialized = JSON.stringify(output);

    // Decision body text must not appear in output (privacy: typed fields only)
    expect(serialized).not.toContain('supersecret123');
    expect(serialized).not.toContain('abcdef');
    // But ask_user candidate should still fire using the title
    const askUser = output.candidates.find((c) => c.type === 'ask_user');
    expect(askUser).toBeDefined();
    const action = askUser?.proposedAction as { question: string };
    expect(action.question).toContain('API Key decision');
  });
});
