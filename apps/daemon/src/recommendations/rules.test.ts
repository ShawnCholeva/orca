import { describe, expect, it } from 'vitest';
import type { RecommendationInput } from './input.js';
import {
  refineGoalRule,
  createSessionRule,
  continueSessionRule,
  splitTaskRule,
  updatePlanRule,
  askUserRule,
  markCompleteRule,
  pauseWorkRule,
  runValidationRule,
  reviewOutputRule,
  resolveConflictCandidate,
} from './rules.js';
import {
  engineerSession,
  reviewerSession,
  sessionSummary,
  taskInput,
  decisionInput,
  memoryItem,
  activeRecommendation,
} from './fixtures/index.js';
import { recommendationFingerprint, canonicalizeProposedActionJson } from './fingerprint.js';

// ── Minimal input factory ──────────────────────────────────────────────────────

function baseInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    goalId: 'goal-1',
    objective: 'Build an auth system',
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

function refinement(overrides: Partial<RecommendationInput['refinement']> = {}) {
  return {
    goalId: 'goal-1',
    successCriteria: ['Users can log in'],
    constraints: [],
    assumptions: [],
    refinedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── refine_goal ────────────────────────────────────────────────────────────────

describe('refineGoalRule', () => {
  it('fires with confidence 0.9 when no refinement', () => {
    const candidates = refineGoalRule(baseInput());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('refine_goal');
    expect(candidates[0].confidence).toBe(0.9);
    const action = candidates[0].proposedAction as { kind: string; missingFields: string[] };
    expect(action.kind).toBe('refine_goal');
    expect(action.missingFields).toContain('objective');
    expect(action.missingFields).toContain('success_criteria');
  });

  it('fires when success criteria empty', () => {
    const input = baseInput({ refinement: refinement({ successCriteria: [] }) });
    const candidates = refineGoalRule(input);
    expect(candidates).toHaveLength(1);
    const action = candidates[0].proposedAction as { missingFields: string[] };
    expect(action.missingFields).toContain('success_criteria');
    expect(action.missingFields).not.toContain('objective');
  });

  it('fires with confidence 0.6 when open questions exist', () => {
    const input = baseInput({
      refinement: refinement(),
      memoryItems: [
        { id: 'm-1', type: 'open_question', status: 'observed', content: 'Is OAuth needed?', sourceSessionId: null, updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    const candidates = refineGoalRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe(0.6);
    const action = candidates[0].proposedAction as { missingFields: string[] };
    expect(action.missingFields).toContain('scope_notes');
  });

  it('does NOT fire when refinement has criteria and no open questions', () => {
    const input = baseInput({ refinement: refinement() });
    const candidates = refineGoalRule(input);
    expect(candidates).toHaveLength(0);
  });

  it('does NOT fire for archived open questions', () => {
    const input = baseInput({
      refinement: refinement(),
      memoryItems: [
        { id: 'm-1', type: 'open_question', status: 'archived', content: 'Resolved', sourceSessionId: null, updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    const candidates = refineGoalRule(input);
    expect(candidates).toHaveLength(0);
  });
});

// ── create_session ─────────────────────────────────────────────────────────────

describe('createSessionRule', () => {
  it('fires for each open task with no associated session', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Implement login', role: 'engineer', status: 'open',
          workspaceId: 'ws-1', parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    const candidates = createSessionRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('create_session');
    expect(candidates[0].relatedTaskId).toBe('t-1');
    const action = candidates[0].proposedAction as { kind: string; workspaceId: string; adapterId: string };
    expect(action.kind).toBe('create_session');
    expect(action.workspaceId).toBe('ws-1');
  });

  it('does NOT fire when task already has a session', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Implement login', role: 'engineer', status: 'open',
          workspaceId: 'ws-1', parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-1', workspaceId: 'ws-1', taskId: 't-1', status: 'running', role: 'engineer', adapterId: 'claude-code', exitedAt: null },
      ],
    });
    const candidates = createSessionRule(input);
    expect(candidates).toHaveLength(0);
  });

  it('does NOT fire for non-open tasks', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Done task', role: 'engineer', status: 'done',
          workspaceId: null, parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(createSessionRule(input)).toHaveLength(0);
  });

  it('upgrades to claude-code when previous workspace session used it', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'More work', role: 'engineer', status: 'open',
          workspaceId: 'ws-1', parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-0', workspaceId: 'ws-1', taskId: null, status: 'exited', role: 'engineer', adapterId: 'claude-code', exitedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    const candidates = createSessionRule(input);
    expect(candidates).toHaveLength(1);
    const action = candidates[0].proposedAction as { adapterId: string };
    expect(action.adapterId).toBe('claude-code');
  });

  it('uses higher confidence when task has acceptance criteria', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Implement login', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: '',
          acceptanceCriteria: [{ id: 'c-1', text: 'User can log in' }],
          sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    const candidates = createSessionRule(input);
    expect(candidates[0].confidence).toBe(0.85);
  });
});

// ── continue_session ───────────────────────────────────────────────────────────

describe('continueSessionRule', () => {
  it('fires for running session associated with in_progress task', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Implement login', role: 'engineer', status: 'in_progress',
          workspaceId: 'ws-1', parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-1', workspaceId: 'ws-1', taskId: 't-1', status: 'running', role: 'engineer', adapterId: 'claude-code', exitedAt: null },
      ],
    });
    const candidates = continueSessionRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('continue_session');
    expect(candidates[0].confidence).toBe(0.75);
    expect(candidates[0].relatedSessionId).toBe('s-1');
  });

  it('does NOT fire when summary indicates completion', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Task', role: 'engineer', status: 'in_progress',
          workspaceId: 'ws-1', parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-1', workspaceId: 'ws-1', taskId: 't-1', status: 'running', role: 'engineer', adapterId: 'claude-code', exitedAt: null },
      ],
      sessionSummaries: [
        { id: 'sum-1', sessionId: 's-1', summaryText: 'Work is completed and all tests pass', headline: 'Done', createdAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    expect(continueSessionRule(input)).toHaveLength(0);
  });

  it('does NOT fire when session has no task or task is not in_progress', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Task', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-1', workspaceId: 'ws-1', taskId: null, status: 'running', role: null, adapterId: 'claude-code', exitedAt: null },
      ],
    });
    expect(continueSessionRule(input)).toHaveLength(0);
  });
});

// ── split_task ─────────────────────────────────────────────────────────────────

describe('splitTaskRule', () => {
  it('fires when task has 4+ acceptance criteria and no children', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Large task', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: 'short',
          acceptanceCriteria: [
            { id: 'c-1', text: 'Criterion 1' },
            { id: 'c-2', text: 'Criterion 2' },
            { id: 'c-3', text: 'Criterion 3' },
            { id: 'c-4', text: 'Criterion 4' },
          ],
          sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    const candidates = splitTaskRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('split_task');
    expect(candidates[0].confidence).toBe(0.55);
    const action = candidates[0].proposedAction as { kind: string; taskId: string; suggestedChildren: unknown[] };
    expect(action.kind).toBe('split_task');
    expect(action.taskId).toBe('t-1');
    expect(action.suggestedChildren.length).toBeGreaterThan(0);
  });

  it('fires when description exceeds 4 KiB', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Long task', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: 'a'.repeat(5000),
          acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(splitTaskRule(input)).toHaveLength(1);
  });

  it('does NOT fire when task has children', () => {
    const input = baseInput({
      tasks: [
        {
          id: 'parent', title: 'Parent task', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: 'a'.repeat(5000),
          acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'child', title: 'Child task', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: 'parent', description: '',
          acceptanceCriteria: [], sources: [], fingerprint: 'fp2', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(splitTaskRule(input)).toHaveLength(0);
  });

  it('does NOT fire for done/cancelled tasks', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Done task', role: 'engineer', status: 'done',
          workspaceId: null, parentTaskId: null, description: 'a'.repeat(5000),
          acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(splitTaskRule(input)).toHaveLength(0);
  });
});

// ── update_plan ────────────────────────────────────────────────────────────────

describe('updatePlanRule', () => {
  it('fires when a task has a confirmed decision source', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Implement auth', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: '',
          acceptanceCriteria: [],
          sources: [{ type: 'decision', id: 'd-1' }],
          fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      decisions: [
        { id: 'd-1', title: 'Use JWT', status: 'confirmed', confirmationRequired: false, decisionText: 'We will use JWT tokens.', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    const candidates = updatePlanRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('update_plan');
    expect(candidates[0].relatedTaskId).toBe('t-1');
  });

  it('fires when a blocker memory item is linked to a task via session', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Implement auth', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-1', workspaceId: 'ws-1', taskId: 't-1', status: 'exited', role: 'engineer', adapterId: 'claude-code', exitedAt: '2025-01-01T00:00:00.000Z' },
      ],
      memoryItems: [
        { id: 'm-1', type: 'blocker', status: 'observed', content: 'OAuth server down', sourceSessionId: 's-1', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    const candidates = updatePlanRule(input);
    const blockerRec = candidates.find((c) => {
      const action = c.proposedAction as { suggestedStatus?: string };
      return action.suggestedStatus === 'blocked';
    });
    expect(blockerRec).toBeDefined();
    expect(blockerRec?.relatedTaskId).toBe('t-1');
  });

  it('does NOT fire for proposed decisions', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Task', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: '',
          acceptanceCriteria: [], sources: [{ type: 'decision', id: 'd-1' }], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      decisions: [
        { id: 'd-1', title: 'Decision', status: 'proposed', confirmationRequired: false, decisionText: 'TBD', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    expect(updatePlanRule(input)).toHaveLength(0);
  });
});

// ── ask_user ───────────────────────────────────────────────────────────────────

describe('askUserRule', () => {
  it('fires for each pending confirmation-required decision', () => {
    const input = baseInput({
      decisions: [
        { id: 'd-1', title: 'Use OAuth?', status: 'proposed', confirmationRequired: true, decisionText: 'Should we use OAuth 2.0 for authentication?', updatedAt: '2025-01-01T00:00:00.000Z' },
        { id: 'd-2', title: 'Use JWT?', status: 'proposed', confirmationRequired: true, decisionText: 'Should we use JWT tokens?', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    const candidates = askUserRule(input);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].confidence).toBe(0.95);
    for (const c of candidates) {
      expect(c.type).toBe('ask_user');
    }
  });

  it('does NOT fire for confirmed or archived decisions', () => {
    const input = baseInput({
      decisions: [
        { id: 'd-1', title: 'Confirmed', status: 'confirmed', confirmationRequired: true, decisionText: 'Yes', updatedAt: '2025-01-01T00:00:00.000Z' },
        { id: 'd-2', title: 'Archived', status: 'archived', confirmationRequired: true, decisionText: 'No', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    expect(askUserRule(input)).toHaveLength(0);
  });

  it('does NOT fire for decisions that do not require confirmation', () => {
    const input = baseInput({
      decisions: [
        { id: 'd-1', title: 'Informal', status: 'proposed', confirmationRequired: false, decisionText: 'Informal decision', updatedAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    expect(askUserRule(input)).toHaveLength(0);
  });
});

// ── mark_complete ──────────────────────────────────────────────────────────────

describe('markCompleteRule', () => {
  it('fires when all criteria mentioned in summary and reviewer completed', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Auth task', role: 'engineer', status: 'in_progress',
          workspaceId: null, parentTaskId: null, description: '',
          acceptanceCriteria: [{ id: 'c-1', text: 'login form works' }],
          sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-impl', workspaceId: 'ws-1', taskId: 't-1', status: 'exited', role: 'engineer', adapterId: 'claude-code', exitedAt: '2025-01-01T00:00:00.000Z' },
        { id: 's-rev', workspaceId: 'ws-1', taskId: 't-1', status: 'exited', role: 'reviewer', adapterId: 'claude-code', exitedAt: '2025-01-01T01:00:00.000Z' },
      ],
      sessionSummaries: [
        { id: 'sum-1', sessionId: 's-impl', summaryText: 'Implemented the login form and it works correctly', headline: 'Done', createdAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    const candidates = markCompleteRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('mark_complete');
    expect(candidates[0].confidence).toBe(0.6);
  });

  it('does NOT fire when no reviewer session completed', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Task', role: 'engineer', status: 'in_progress',
          workspaceId: null, parentTaskId: null, description: '',
          acceptanceCriteria: [{ id: 'c-1', text: 'login works' }],
          sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      sessions: [
        { id: 's-1', workspaceId: 'ws-1', taskId: 't-1', status: 'exited', role: 'engineer', adapterId: 'claude-code', exitedAt: '2025-01-01T00:00:00.000Z' },
      ],
      sessionSummaries: [
        { id: 'sum-1', sessionId: 's-1', summaryText: 'login works now', headline: 'Done', createdAt: '2025-01-01T00:00:00.000Z' },
      ],
    });
    expect(markCompleteRule(input)).toHaveLength(0);
  });

  it('does NOT fire when no acceptance criteria', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Task', role: 'engineer', status: 'open',
          workspaceId: null, parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(markCompleteRule(input)).toHaveLength(0);
  });
});

// ── pause_work ─────────────────────────────────────────────────────────────────

describe('pauseWorkRule', () => {
  it('fires when 2+ open conflicts target the same task', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Blocked task', role: 'engineer', status: 'in_progress',
          workspaceId: null, parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      activeConflicts: [
        { id: 'c-1', conflictType: 'workspace_overlap', status: 'open', sources: [{ type: 'task', id: 't-1' }] },
        { id: 'c-2', conflictType: 'blocker_reported', status: 'open', sources: [{ type: 'task', id: 't-1' }] },
      ],
    });
    const candidates = pauseWorkRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('pause_work');
    expect(candidates[0].confidence).toBe(0.7);
    expect(candidates[0].relatedTaskId).toBe('t-1');
  });

  it('does NOT fire when only 1 conflict targets a task', () => {
    const input = baseInput({
      tasks: [
        {
          id: 't-1', title: 'Task', role: 'engineer', status: 'in_progress',
          workspaceId: null, parentTaskId: null, description: '', acceptanceCriteria: [], sources: [], fingerprint: 'fp', updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      activeConflicts: [
        { id: 'c-1', conflictType: 'workspace_overlap', status: 'open', sources: [{ type: 'task', id: 't-1' }] },
      ],
    });
    expect(pauseWorkRule(input)).toHaveLength(0);
  });
});

// ── resolve_conflict ───────────────────────────────────────────────────────────

describe('resolveConflictCandidate', () => {
  it('returns a resolve_conflict candidate with confidence 1.0', () => {
    const candidate = resolveConflictCandidate({
      conflictId: 'conflict-1',
      conflictTitle: 'Workspace overlap detected',
      goalId: 'goal-1',
    });
    expect(candidate.type).toBe('resolve_conflict');
    expect(candidate.confidence).toBe(1.0);
    const action = candidate.proposedAction as { kind: string; conflictId: string };
    expect(action.kind).toBe('resolve_conflict');
    expect(action.conflictId).toBe('conflict-1');
    expect(candidate.relatedConflictId).toBe('conflict-1');
    expect(candidate.sources[0]).toMatchObject({ type: 'conflict', id: 'conflict-1' });
  });
});

// ── run_validation (snapshot tests) ───────────────────────────────────────────

describe('runValidationRule', () => {
  it('engineer-completed-with-evidence: fires run_validation with confidence 0.85', () => {
    const eng = engineerSession({ id: 's-eng-1', taskId: 't-1', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const task = taskInput({ id: 't-1', title: 'Implement login', role: 'engineer' });
    const sum = sessionSummary('s-eng-1', 'All tests pass and build succeeded');
    const input = baseInput({
      tasks: [task],
      sessions: [eng],
      sessionSummaries: [sum],
    });
    const candidates = runValidationRule(input);
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.type).toBe('run_validation');
    expect(c.confidence).toBe(0.85);
    expect(c.relatedSessionId).toBe('s-eng-1');
    expect(c.relatedTaskId).toBe('t-1');
    const action = c.proposedAction as {
      kind: string; sessionId: string; taskId: string; suggestedRole: string; objective: string;
    };
    expect(action.kind).toBe('run_validation');
    expect(action.sessionId).toBe('s-eng-1');
    expect(action.taskId).toBe('t-1');
    expect(action.suggestedRole).toBe('reviewer');
    expect(action.objective).toContain('Implement login');
    expect(c.sources.some((s) => s.type === 'session' && s.id === 's-eng-1')).toBe(true);
    expect(c.sources.some((s) => s.type === 'session_summary' && s.id === 'sum-s-eng-1')).toBe(true);
  });

  it('engineer-completed-without-evidence: does NOT fire when summary has no impl tokens', () => {
    const eng = engineerSession({ id: 's-eng-1', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const sum = sessionSummary('s-eng-1', 'Session completed');
    const input = baseInput({ sessions: [eng], sessionSummaries: [sum] });
    expect(runValidationRule(input)).toHaveLength(0);
  });

  it('does NOT fire when session status is running (not exited)', () => {
    const eng = engineerSession({ status: 'running', exitedAt: null });
    const sum = sessionSummary('s-eng-1', 'Running tests and build');
    const input = baseInput({ sessions: [eng], sessionSummaries: [sum] });
    expect(runValidationRule(input)).toHaveLength(0);
  });

  it('does NOT fire when positive reviewer session exists after engineer session', () => {
    const eng = engineerSession({
      id: 's-eng-1', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z',
    });
    const rev = reviewerSession({
      id: 's-rev-1', status: 'exited', exitedAt: '2025-01-02T11:00:00.000Z',
    });
    const sum = sessionSummary('s-eng-1', 'All tests pass');
    const input = baseInput({ sessions: [eng, rev], sessionSummaries: [sum] });
    expect(runValidationRule(input)).toHaveLength(0);
  });

  it('fires when validation_result memory item exists for session (even without text tokens)', () => {
    const eng = engineerSession({ id: 's-eng-1', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z', taskId: null });
    const sum = sessionSummary('s-eng-1', 'Session completed');
    const valResult = memoryItem('validation_result', { sourceSessionId: 's-eng-1' });
    const input = baseInput({ sessions: [eng], sessionSummaries: [sum], memoryItems: [valResult] });
    const candidates = runValidationRule(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe('run_validation');
  });

  it('double-review-suppressed: does NOT emit when proposed run_validation has same fingerprint', () => {
    const eng = engineerSession({ id: 's-eng-1', taskId: 't-1', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const task = taskInput({ id: 't-1' });
    const sum = sessionSummary('s-eng-1', 'All tests pass');
    // Compute the fingerprint the rule would produce
    const proposedAction = {
      kind: 'run_validation',
      sessionId: 's-eng-1',
      taskId: 't-1',
      suggestedRole: 'reviewer',
      objective: 'Implement login (engineer)',
    };
    const fp = recommendationFingerprint(
      'goal-1',
      'run_validation',
      canonicalizeProposedActionJson(JSON.stringify(proposedAction))
    );
    const existingRec = activeRecommendation('run_validation', fp, 'proposed');
    const input = baseInput({
      tasks: [task],
      sessions: [eng],
      sessionSummaries: [sum],
      activeRecommendations: [existingRec],
    });
    expect(runValidationRule(input)).toHaveLength(0);
  });

  it('double-review-suppressed: does NOT emit when modified run_validation has same fingerprint', () => {
    const eng = engineerSession({ id: 's-eng-1', taskId: 't-1', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const task = taskInput({ id: 't-1' });
    const sum = sessionSummary('s-eng-1', 'All tests pass');
    const proposedAction = {
      kind: 'run_validation',
      sessionId: 's-eng-1',
      taskId: 't-1',
      suggestedRole: 'reviewer',
      objective: 'Implement login (engineer)',
    };
    const fp = recommendationFingerprint(
      'goal-1',
      'run_validation',
      canonicalizeProposedActionJson(JSON.stringify(proposedAction))
    );
    const existingRec = activeRecommendation('run_validation', fp, 'modified');
    const input = baseInput({
      tasks: [task],
      sessions: [eng],
      sessionSummaries: [sum],
      activeRecommendations: [existingRec],
    });
    expect(runValidationRule(input)).toHaveLength(0);
  });

  it('does NOT fire when session role is not engineer', () => {
    const qa = engineerSession({ role: 'qa', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const sum = sessionSummary('s-eng-1', 'All tests pass');
    const input = baseInput({ sessions: [qa], sessionSummaries: [sum] });
    expect(runValidationRule(input)).toHaveLength(0);
  });
});

// ── review_output (snapshot tests) ────────────────────────────────────────────

describe('reviewOutputRule', () => {
  it('reviewer-rejected: fires review_output with confidence 0.8', () => {
    const rev = reviewerSession({ id: 's-rev-1', status: 'failed', exitedAt: '2025-01-02T11:00:00.000Z' });
    const sum = sessionSummary('s-rev-1', 'Reviewer found critical issues');
    const input = baseInput({ sessions: [rev], sessionSummaries: [sum] });
    const candidates = reviewOutputRule(input);
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.type).toBe('review_output');
    expect(c.confidence).toBe(0.8);
    expect(c.relatedSessionId).toBe('s-rev-1');
    const action = c.proposedAction as { kind: string; sessionId: string; reviewerRole: string };
    expect(action.kind).toBe('review_output');
    expect(action.sessionId).toBe('s-rev-1');
    expect(action.reviewerRole).toBe('reviewer');
    expect(c.sources.some((s) => s.type === 'session' && s.id === 's-rev-1')).toBe(true);
    expect(c.sources.some((s) => s.type === 'session_summary')).toBe(true);
  });

  it('fires when decision requires confirmation and a completed session exists', () => {
    const eng = engineerSession({ id: 's-eng-1', status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const decision = decisionInput({ confirmationRequired: true, status: 'proposed' });
    const input = baseInput({ sessions: [eng], decisions: [decision] });
    const candidates = reviewOutputRule(input);
    const confirmRec = candidates.find((c) => {
      const a = c.proposedAction as { kind: string };
      return a.kind === 'review_output';
    });
    expect(confirmRec).toBeDefined();
    expect(confirmRec?.confidence).toBe(0.8);
  });

  it('does NOT fire for decision trigger when no completed session exists', () => {
    const decision = decisionInput({ confirmationRequired: true, status: 'proposed' });
    const input = baseInput({ decisions: [decision] });
    expect(reviewOutputRule(input)).toHaveLength(0);
  });

  it('fires when >= 3 architecture notes accumulated and completed session exists', () => {
    const eng = engineerSession({ status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const notes = [
      memoryItem('architecture_note', { id: 'm-1', status: 'promoted' }),
      memoryItem('architecture_note', { id: 'm-2', status: 'promoted' }),
      memoryItem('architecture_note', { id: 'm-3', status: 'promoted' }),
    ];
    const input = baseInput({ sessions: [eng], memoryItems: notes });
    const candidates = reviewOutputRule(input);
    expect(candidates.some((c) => c.type === 'review_output')).toBe(true);
  });

  it('does NOT fire for arch notes when count < 3', () => {
    const eng = engineerSession({ status: 'exited', exitedAt: '2025-01-02T10:00:00.000Z' });
    const notes = [
      memoryItem('architecture_note', { id: 'm-1' }),
      memoryItem('architecture_note', { id: 'm-2' }),
    ];
    const input = baseInput({ sessions: [eng], memoryItems: notes });
    // check no review_output for arch-note trigger (may still fire for other triggers)
    const archNoteCandidates = reviewOutputRule(input).filter((c) => {
      const a = c.proposedAction as { kind: string };
      return a.kind === 'review_output';
    });
    // Only 2 notes so arch-note trigger does not fire; no other triggers active
    expect(archNoteCandidates).toHaveLength(0);
  });

  it('does NOT fire for reviewer rejection when reviewer session exited (not failed)', () => {
    const rev = reviewerSession({ status: 'exited', exitedAt: '2025-01-02T11:00:00.000Z' });
    const sum = sessionSummary('s-rev-1', 'Review passed');
    const input = baseInput({ sessions: [rev], sessionSummaries: [sum] });
    expect(reviewOutputRule(input)).toHaveLength(0);
  });

  it('double-review-suppressed: does NOT emit when proposed review_output has same fingerprint', () => {
    const rev = reviewerSession({ id: 's-rev-1', status: 'failed', exitedAt: '2025-01-02T11:00:00.000Z' });
    const sum = sessionSummary('s-rev-1', 'Issues found');
    const proposedAction = {
      kind: 'review_output',
      sessionId: 's-rev-1',
      reviewerRole: 'reviewer',
    };
    const fp = recommendationFingerprint(
      'goal-1',
      'review_output',
      canonicalizeProposedActionJson(JSON.stringify(proposedAction))
    );
    const existingRec = activeRecommendation('review_output', fp, 'proposed');
    const input = baseInput({
      sessions: [rev],
      sessionSummaries: [sum],
      activeRecommendations: [existingRec],
    });
    expect(reviewOutputRule(input)).toHaveLength(0);
  });

  it('double-review-suppressed: does NOT emit when modified review_output has same fingerprint', () => {
    const rev = reviewerSession({ id: 's-rev-1', status: 'failed', exitedAt: '2025-01-02T11:00:00.000Z' });
    const sum = sessionSummary('s-rev-1', 'Issues found');
    const proposedAction = {
      kind: 'review_output',
      sessionId: 's-rev-1',
      reviewerRole: 'reviewer',
    };
    const fp = recommendationFingerprint(
      'goal-1',
      'review_output',
      canonicalizeProposedActionJson(JSON.stringify(proposedAction))
    );
    const existingRec = activeRecommendation('review_output', fp, 'modified');
    const input = baseInput({
      sessions: [rev],
      sessionSummaries: [sum],
      activeRecommendations: [existingRec],
    });
    expect(reviewOutputRule(input)).toHaveLength(0);
  });
});
