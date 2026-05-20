import { describe, expect, it } from 'vitest';

import type {
  ContextRole,
  SelectableDecision,
  SelectableMemory,
  SelectableSummary,
} from '@orca/contracts';
import {
  DECISION_SELECTION_HARD_CAP,
  MEMORY_SELECTION_HARD_CAP,
  SUMMARY_SELECTION_HARD_CAP,
  selectDecisions,
  selectMemory,
  selectSiblingSummaries,
} from '../src/context/selection.js';

function iso(day: number): string {
  return `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
}

function makeMemory(
  id: string,
  overrides: Partial<SelectableMemory> = {}
): SelectableMemory {
  return {
    id,
    type: 'constraint',
    status: 'promoted',
    content: `memory ${id}`,
    contentHash: `hash-${id}`,
    confidence: 0.9,
    sourceSessionId: null,
    createdAt: iso(1),
    updatedAt: iso(1),
    ...overrides,
  };
}

function makeDecision(
  id: string,
  overrides: Partial<SelectableDecision> = {}
): SelectableDecision {
  return {
    id,
    title: `Decision ${id}`,
    decisionText: `Decision text ${id}`,
    rationale: null,
    status: 'proposed',
    confirmationRequired: false,
    confidence: 0.9,
    sourceSessionId: null,
    createdAt: iso(1),
    confirmedAt: null,
    updatedAt: iso(1),
    ...overrides,
  };
}

function makeSummary(
  id: string,
  overrides: Partial<SelectableSummary> = {}
): SelectableSummary {
  return {
    id,
    sessionId: `session-${id}`,
    headline: `Summary ${id}`,
    summaryText: `Summary text ${id}`,
    truncated: false,
    createdAt: iso(1),
    ...overrides,
  };
}

describe('selectMemory', () => {
  it('returns an empty selection for empty input', () => {
    expect(selectMemory([], 'engineer')).toEqual([]);
  });

  it('caps many promoted memory items at 30 with stable ordering', () => {
    const items: SelectableMemory[] = [];

    for (let index = 0; index < 12; index += 1) {
      items.push(
        makeMemory(`constraint-${index}`, {
          type: 'constraint',
          createdAt: iso(20 - index),
        }),
        makeMemory(`success-${index}`, {
          type: 'success_criterion',
          createdAt: iso(20 - index),
        }),
        makeMemory(`arch-${index}`, {
          type: 'architecture_note',
          createdAt: iso(20 - index),
        })
      );
    }

    const selected = selectMemory(items, 'architect');
    const rerun = selectMemory(items, 'architect');

    expect(selected).toEqual(rerun);
    expect(selected).toHaveLength(MEMORY_SELECTION_HARD_CAP);
    expect(selected.map((item) => item.id)).toEqual([
      'constraint-0',
      'constraint-1',
      'constraint-2',
      'constraint-3',
      'constraint-4',
      'constraint-5',
      'constraint-6',
      'constraint-7',
      'constraint-8',
      'constraint-9',
      'constraint-10',
      'constraint-11',
      'success-0',
      'success-1',
      'success-2',
      'success-3',
      'success-4',
      'success-5',
      'success-6',
      'success-7',
      'success-8',
      'success-9',
      'success-10',
      'success-11',
      'arch-0',
      'arch-1',
      'arch-2',
      'arch-3',
      'arch-4',
      'arch-5',
    ]);
  });

  it('excludes archived memory, keeps only eligible candidates, and labels candidates', () => {
    const selected = selectMemory(
      [
        makeMemory('archived', { status: 'archived', type: 'constraint' }),
        makeMemory('always', { type: 'constraint' }),
        makeMemory('candidate-low', {
          status: 'candidate',
          type: 'assumption',
          confidence: 0.69,
        }),
        makeMemory('candidate-high', {
          status: 'candidate',
          type: 'assumption',
          confidence: 0.7,
          createdAt: iso(2),
        }),
      ],
      'engineer'
    );

    expect(selected.map((item) => item.id)).toEqual(['always', 'candidate-high']);
    expect(selected[0]?.labelAsCandidate).toBe(false);
    expect(selected[1]?.labelAsCandidate).toBe(true);
  });

  it('excludes open_question memory for generalist role', () => {
    const generalist = selectMemory(
      [
        makeMemory('question', { type: 'open_question' }),
        makeMemory('constraint', { type: 'constraint' }),
      ],
      'generalist'
    );
    const reviewer = selectMemory(
      [
        makeMemory('question', { type: 'open_question' }),
        makeMemory('constraint', { type: 'constraint' }),
      ],
      'reviewer'
    );

    expect(generalist.map((item) => item.id)).toEqual(['constraint']);
    expect(reviewer.map((item) => item.id)).toEqual(['constraint', 'question']);
  });

  it('keeps only the most recent promoted notes when budget allows', () => {
    const selected = selectMemory(
      [
        makeMemory('note-4', { type: 'note', createdAt: iso(4) }),
        makeMemory('note-3', { type: 'note', createdAt: iso(3) }),
        makeMemory('note-2', { type: 'note', createdAt: iso(2) }),
        makeMemory('note-1', { type: 'note', createdAt: iso(1) }),
      ],
      'engineer'
    );

    expect(selected.map((item) => item.id)).toEqual(['note-4', 'note-3', 'note-2']);
  });
});

describe('selectDecisions', () => {
  it('returns empty groups for empty input', () => {
    expect(selectDecisions([], 'engineer')).toEqual({
      needsConfirmation: [],
      confirmed: [],
      proposed: [],
    });
  });

  it('always includes confirmation-required proposed decisions when budget is tight', () => {
    const selected = selectDecisions(
      [
        makeDecision('needs-older', {
          confirmationRequired: true,
          createdAt: iso(1),
        }),
        makeDecision('needs-newer', {
          confirmationRequired: true,
          createdAt: iso(3),
        }),
        makeDecision('confirmed', {
          status: 'confirmed',
          confirmedAt: iso(4),
        }),
        makeDecision('proposed', {
          status: 'proposed',
          confirmationRequired: false,
          createdAt: iso(5),
        }),
      ],
      'engineer',
      { maxItems: 1 }
    );

    expect(selected.needsConfirmation.map((decision) => decision.id)).toEqual([
      'needs-newer',
      'needs-older',
    ]);
    expect(selected.confirmed).toEqual([]);
    expect(selected.proposed).toEqual([]);
  });

  it('orders confirmed and proposed decisions deterministically within the hard cap', () => {
    const decisions: SelectableDecision[] = [];

    for (let index = 0; index < 8; index += 1) {
      decisions.push(
        makeDecision(`confirmed-${index}`, {
          status: 'confirmed',
          confirmedAt: iso(20 - index),
        })
      );
      decisions.push(
        makeDecision(`proposed-${index}`, {
          status: 'proposed',
          confirmationRequired: false,
          createdAt: iso(10 - index),
        })
      );
    }

    const selected = selectDecisions(decisions, 'reviewer');
    const total =
      selected.needsConfirmation.length +
      selected.confirmed.length +
      selected.proposed.length;

    expect(total).toBeLessThanOrEqual(DECISION_SELECTION_HARD_CAP);
    expect(selected.confirmed.map((decision) => decision.id)).toEqual([
      'confirmed-0',
      'confirmed-1',
      'confirmed-2',
      'confirmed-3',
      'confirmed-4',
      'confirmed-5',
      'confirmed-6',
      'confirmed-7',
    ]);
    expect(selected.proposed.map((decision) => decision.id)).toEqual([
      'proposed-0',
      'proposed-1',
      'proposed-2',
      'proposed-3',
      'proposed-4',
      'proposed-5',
      'proposed-6',
      'proposed-7',
    ]);
  });
});

describe('selectSiblingSummaries', () => {
  it('returns empty selection for empty input', () => {
    expect(selectSiblingSummaries([], 'engineer')).toEqual([]);
  });

  it('caps sibling summaries at five and orders by recency then id', () => {
    const summaries = [
      makeSummary('c', { createdAt: iso(5) }),
      makeSummary('a', { createdAt: iso(5) }),
      makeSummary('f', { createdAt: iso(4) }),
      makeSummary('e', { createdAt: iso(3) }),
      makeSummary('d', { createdAt: iso(2) }),
      makeSummary('b', { createdAt: iso(1) }),
    ];

    const selected = selectSiblingSummaries(summaries, 'generalist');

    expect(selected).toHaveLength(SUMMARY_SELECTION_HARD_CAP);
    expect(selected.map((summary) => summary.id)).toEqual(['a', 'c', 'f', 'e', 'd']);
  });
});

describe('selection stability', () => {
  it('re-running with identical input produces identical output', () => {
    const role: ContextRole = 'engineer';
    const memory = [
      makeMemory('constraint', { type: 'constraint', createdAt: iso(2) }),
      makeMemory('candidate', {
        type: 'assumption',
        status: 'candidate',
        confidence: 0.8,
        createdAt: iso(1),
      }),
    ];
    const decisions = [
      makeDecision('confirmed', {
        status: 'confirmed',
        confirmedAt: iso(3),
      }),
      makeDecision('needs', {
        confirmationRequired: true,
        createdAt: iso(2),
      }),
    ];
    const summaries = [
      makeSummary('one', { createdAt: iso(2) }),
      makeSummary('two', { createdAt: iso(1) }),
    ];

    expect(selectMemory(memory, role)).toEqual(selectMemory(memory, role));
    expect(selectDecisions(decisions, role)).toEqual(selectDecisions(decisions, role));
    expect(selectSiblingSummaries(summaries, role)).toEqual(
      selectSiblingSummaries(summaries, role)
    );
  });
});
