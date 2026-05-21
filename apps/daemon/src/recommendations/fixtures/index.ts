import type { RecommendationInput } from '../input.js';
import type {
  SessionInput,
  SessionSummaryInput,
  TaskInput,
  DecisionInput,
  MemoryItemInput,
  ActiveRecommendationInput,
} from '../input.js';

// ── Base factories ─────────────────────────────────────────────────────────────

export function baseInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    goalId: 'goal-1',
    objective: 'Build an auth system',
    refinement: {
      goalId: 'goal-1',
      successCriteria: ['Users can log in'],
      constraints: [],
      assumptions: [],
      refinedAt: '2025-01-01T00:00:00.000Z',
    },
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
    inputFingerprint: 'fp-test',
    ...overrides,
  };
}

export function engineerSession(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    id: 's-eng-1',
    workspaceId: 'ws-1',
    taskId: 't-1',
    status: 'exited',
    role: 'engineer',
    adapterId: 'claude-code',
    exitedAt: '2025-01-02T10:00:00.000Z',
    ...overrides,
  };
}

export function reviewerSession(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    id: 's-rev-1',
    workspaceId: 'ws-1',
    taskId: 't-1',
    status: 'failed',
    role: 'reviewer',
    adapterId: 'claude-code',
    exitedAt: '2025-01-02T11:00:00.000Z',
    ...overrides,
  };
}

export function sessionSummary(
  sessionId: string,
  summaryText: string,
  overrides: Partial<SessionSummaryInput> = {}
): SessionSummaryInput {
  return {
    id: `sum-${sessionId}`,
    sessionId,
    summaryText,
    headline: 'Session summary',
    createdAt: '2025-01-02T10:00:00.000Z',
    ...overrides,
  };
}

export function taskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 't-1',
    title: 'Implement login',
    role: 'engineer',
    status: 'in_progress',
    workspaceId: 'ws-1',
    parentTaskId: null,
    description: 'Implement the login flow',
    acceptanceCriteria: [],
    sources: [],
    fingerprint: 'task-fp-1',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function decisionInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    id: 'd-1',
    title: 'Use JWT tokens',
    status: 'proposed',
    confirmationRequired: true,
    decisionText: 'Should we use JWT tokens for session management?',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function memoryItem(
  type: string,
  overrides: Partial<MemoryItemInput> = {}
): MemoryItemInput {
  return {
    id: `m-${type}-1`,
    type,
    status: 'promoted',
    content: `${type} content`,
    sourceSessionId: null,
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function activeRecommendation(
  type: string,
  fingerprint: string,
  status: 'proposed' | 'modified' = 'proposed',
  overrides: Partial<ActiveRecommendationInput> = {}
): ActiveRecommendationInput {
  return {
    id: `rec-${type}-1`,
    type,
    status,
    relatedTaskId: null,
    relatedConflictId: null,
    fingerprint,
    ...overrides,
  };
}
