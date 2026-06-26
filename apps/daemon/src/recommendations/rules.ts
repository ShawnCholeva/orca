import { z } from 'zod';
import {
  ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_SOURCES,
  ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES,
  type RecommendationType,
  type ProposedAction,
  type RecommendationSourceRef,
} from '@orca/contracts';
import type {
  RecommendationInput,
  TaskInput,
  SessionInput,
  SessionSummaryInput,
  ActiveRecommendationInput,
  ActiveConflictInput,
} from './input.js';
import {
  detectImplementationEvidence,
  detectReviewerRejection,
  type SessionSummaryEvidence,
} from './evidence.js';
import { recommendationFingerprint, canonicalizeProposedActionJson } from './fingerprint.js';

// ── Candidate type ─────────────────────────────────────────────────────────────

export const RecommendationCandidateSchema = z
  .object({
    type: z.enum([
      'create_session',
      'continue_session',
      'review_output',
      'refine_goal',
      'split_task',
      'run_validation',
      'resolve_conflict',
      'update_plan',
      'ask_user',
      'mark_complete',
      'pause_work',
    ]),
    title: z.string().trim().min(1).max(ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS),
    rationale: z.string().max(ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS),
    proposedAction: z.unknown(), // validated by ProposedAction schema in provider
    confidence: z.number().min(0).max(1),
    sources: z.array(z.unknown()).max(ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
    relatedTaskId: z.string().optional(),
    relatedSessionId: z.string().optional(),
    relatedContextPackageId: z.string().optional(),
    relatedConflictId: z.string().optional(),
  })
  .strict();

export type RecommendationCandidate = {
  type: RecommendationType;
  title: string;
  rationale: string;
  proposedAction: ProposedAction;
  confidence: number;
  sources: RecommendationSourceRef[];
  relatedTaskId?: string;
  relatedSessionId?: string;
  relatedContextPackageId?: string;
  relatedConflictId?: string;
};

// ── Helper: cap text ───────────────────────────────────────────────────────────

function capTitle(s: string): string {
  return s.trim().slice(0, ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS);
}

function capRationale(s: string): string {
  return s.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS);
}

function capProposedActionJson(json: string): boolean {
  return new TextEncoder().encode(json).length <= ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES;
}

// ── Completion keywords for continue_session / mark_complete ───────────────────

const COMPLETION_KEYWORDS = /\b(complete[d]?|done|finish[ed]?|implement[ed]?)\b/i;

function summaryIndicatesCompletion(summaryText: string): boolean {
  return COMPLETION_KEYWORDS.test(summaryText);
}

// ── refine_goal ────────────────────────────────────────────────────────────────

export function refineGoalRule(input: RecommendationInput): RecommendationCandidate[] {
  const missingFields: string[] = [];
  let confidence = 0.9;
  let rationale = '';

  if (!input.refinement) {
    missingFields.push('objective', 'success_criteria');
    rationale = 'Goal has no refinement. Add objective and success criteria to enable orchestration.';
    confidence = 0.9;
  } else if (input.refinement.successCriteria.length === 0) {
    missingFields.push('success_criteria');
    rationale = 'Goal refinement is missing success criteria, which are required for task generation.';
    confidence = 0.9;
  }

  const openQuestions = input.memoryItems.filter(
    (m) => m.type === 'open_question' && m.status !== 'archived'
  );

  if (openQuestions.length > 0) {
    if (!missingFields.includes('scope_notes')) missingFields.push('scope_notes');
    if (confidence > 0.6) confidence = 0.6;
    if (!rationale) {
      rationale = `Goal has ${openQuestions.length} unresolved open question(s) that should be addressed in the refinement.`;
    }
  }

  if (missingFields.length === 0) return [];

  const proposedAction = {
    kind: 'refine_goal' as const,
    missingFields: missingFields.slice(0, 20) as import('@orca/contracts').RefinementFieldKey[],
  };

  const actionJson = JSON.stringify(proposedAction);
  if (!capProposedActionJson(actionJson)) return [];

  const sources: RecommendationSourceRef[] = [];
  if (openQuestions.length > 0) {
    for (const q of openQuestions.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES - 1)) {
      sources.push({ type: 'memory_item', id: q.id, reason: 'open_question' });
    }
  }

  return [
    {
      type: 'refine_goal',
      title: capTitle('Refine goal: missing required fields'),
      rationale: capRationale(rationale),
      proposedAction,
      confidence,
      sources: sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
    },
  ];
}

// ── create_session ─────────────────────────────────────────────────────────────

function mapToContextRole(
  role: string
): 'architect' | 'engineer' | 'reviewer' | 'generalist' {
  if (role === 'qa') return 'generalist';
  if (['architect', 'engineer', 'reviewer', 'generalist'].includes(role)) {
    return role as 'architect' | 'engineer' | 'reviewer' | 'generalist';
  }
  return 'generalist';
}

function preferredAdapterForWorkspace(
  workspaceId: string,
  sessions: SessionInput[]
): 'claude-code' | 'codex' {
  const completedCodex = sessions.some(
    (s) => s.workspaceId === workspaceId && s.exitedAt !== null && s.adapterId === 'codex'
  );
  return completedCodex ? 'codex' : 'claude-code';
}

export function createSessionRule(input: RecommendationInput): RecommendationCandidate[] {
  const openTasks = input.tasks.filter((t) => t.status === 'open');
  if (openTasks.length === 0) return [];

  const candidates: RecommendationCandidate[] = [];
  const sessionsWithTask = new Set(input.sessions.map((s) => s.taskId).filter(Boolean));

  for (const task of openTasks) {
    if (sessionsWithTask.has(task.id)) continue;

    const workspaceId = task.workspaceId ?? undefined;
    const adapterId = workspaceId
      ? preferredAdapterForWorkspace(workspaceId, input.sessions)
      : 'claude-code';

    const role = mapToContextRole(task.role);
    const objective = task.title.slice(0, 4000);
    const confidence =
      task.acceptanceCriteria.length > 0 ? 0.85 : 0.7;

    const contextRequest = {
      adapterId: adapterId as 'claude-code' | 'codex',
      role,
      objective,
      ...(workspaceId ? { workspaceId } : {}),
    };

    const proposedAction = {
      kind: 'create_session' as const,
      adapterId: adapterId as 'claude-code' | 'codex',
      ...(workspaceId ? { workspaceId } : {}),
      role: task.role as 'architect' | 'engineer' | 'reviewer' | 'qa' | 'generalist',
      objective,
      contextRequest,
    };

    const actionJson = JSON.stringify(proposedAction);
    if (!capProposedActionJson(actionJson)) continue;

    const sources: RecommendationSourceRef[] = [
      { type: 'task', id: task.id, reason: 'subject' },
    ];
    if (workspaceId) sources.push({ type: 'workspace', id: workspaceId, reason: 'target' });

    candidates.push({
      type: 'create_session',
      title: capTitle(`Start session for: ${task.title}`),
      rationale: capRationale(
        `Task "${task.title}" is open but has no associated session. Starting a session will begin implementation.`
      ),
      proposedAction,
      confidence,
      sources: sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
      relatedTaskId: task.id,
    });
  }

  return candidates;
}

// ── continue_session ───────────────────────────────────────────────────────────

export function continueSessionRule(input: RecommendationInput): RecommendationCandidate[] {
  const inProgressTaskIds = new Set(
    input.tasks.filter((t) => t.status === 'in_progress').map((t) => t.id)
  );

  const activeSessions = input.sessions.filter(
    (s) => (s.status === 'running' || s.status === 'paused') && s.taskId && inProgressTaskIds.has(s.taskId)
  );

  const summaryBySession = new Map<string, string>();
  for (const s of input.sessionSummaries) {
    if (!summaryBySession.has(s.sessionId)) {
      summaryBySession.set(s.sessionId, s.summaryText);
    }
  }

  const candidates: RecommendationCandidate[] = [];
  for (const session of activeSessions) {
    const latestSummary = summaryBySession.get(session.id);
    if (latestSummary && summaryIndicatesCompletion(latestSummary)) continue;

    const proposedAction = {
      kind: 'continue_session' as const,
      sessionId: session.id,
    };

    const sources: RecommendationSourceRef[] = [{ type: 'session', id: session.id, reason: 'subject' }];
    if (session.taskId) sources.push({ type: 'task', id: session.taskId, reason: 'context' });

    candidates.push({
      type: 'continue_session',
      title: capTitle('Continue active session'),
      rationale: capRationale('An active session is associated with an in-progress task and has not completed.'),
      proposedAction,
      confidence: 0.75,
      sources: sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
      relatedSessionId: session.id,
      ...(session.taskId ? { relatedTaskId: session.taskId } : {}),
    });
  }

  return candidates;
}

// ── split_task ─────────────────────────────────────────────────────────────────

const SPLIT_DESCRIPTION_BYTES = 4096;

function taskHasChildren(taskId: string, tasks: TaskInput[]): boolean {
  return tasks.some((t) => t.parentTaskId === taskId);
}

export function splitTaskRule(input: RecommendationInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];

  for (const task of input.tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    if (taskHasChildren(task.id, input.tasks)) continue;

    const descriptionBytes = new TextEncoder().encode(task.description).length;
    const criteriaCount = task.acceptanceCriteria.length;

    if (descriptionBytes <= SPLIT_DESCRIPTION_BYTES && criteriaCount < 4) continue;

    const suggestedChildren = criteriaCount >= 4
      ? task.acceptanceCriteria.slice(0, 10).map((c) => ({
          title: c.text.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS),
          role: task.role as 'architect' | 'engineer' | 'reviewer' | 'qa' | 'generalist' | undefined,
        }))
      : [
          { title: `${task.title.slice(0, 120)} — Part 1` },
          { title: `${task.title.slice(0, 120)} — Part 2` },
        ];

    const proposedAction = {
      kind: 'split_task' as const,
      taskId: task.id,
      suggestedChildren: suggestedChildren.slice(0, 20),
    };

    const actionJson = JSON.stringify(proposedAction);
    if (!capProposedActionJson(actionJson)) continue;

    candidates.push({
      type: 'split_task',
      title: capTitle(`Split task: ${task.title}`),
      rationale: capRationale(
        criteriaCount >= 4
          ? `Task has ${criteriaCount} acceptance criteria, which suggests it can be decomposed into smaller units.`
          : `Task description exceeds ${SPLIT_DESCRIPTION_BYTES} bytes, suggesting it should be split.`
      ),
      proposedAction,
      confidence: 0.55,
      sources: [{ type: 'task', id: task.id, reason: 'subject' }],
      relatedTaskId: task.id,
    });
  }

  return candidates;
}

// ── update_plan ────────────────────────────────────────────────────────────────

export function updatePlanRule(input: RecommendationInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];

  // Confirmed decisions linked to tasks via task sources
  const confirmedDecisionIds = new Set(
    input.decisions.filter((d) => d.status === 'confirmed').map((d) => d.id)
  );

  for (const task of input.tasks) {
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') continue;

    const linkedDecisions = task.sources
      .filter((s) => s.type === 'decision' && confirmedDecisionIds.has(s.id))
      .map((s) => s.id);

    if (linkedDecisions.length > 0) {
      const proposedAction = {
        kind: 'update_plan' as const,
        taskId: task.id,
      };

      const sources: RecommendationSourceRef[] = [
        { type: 'task', id: task.id, reason: 'subject' },
        ...linkedDecisions.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES - 1).map((id) => ({
          type: 'decision' as const,
          id,
          reason: 'driver',
        })),
      ];

      candidates.push({
        type: 'update_plan',
        title: capTitle(`Update plan for: ${task.title}`),
        rationale: capRationale(
          'A confirmed decision is linked to this task and may require updating the task plan or acceptance criteria.'
        ),
        proposedAction,
        confidence: 0.6,
        sources: sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
        relatedTaskId: task.id,
      });
    }
  }

  // Blocker memory items linked to tasks via session→task association
  const sessionToTask = new Map<string, string>();
  for (const s of input.sessions) {
    if (s.taskId) sessionToTask.set(s.id, s.taskId);
  }

  const taskIds = new Set(input.tasks.map((t) => t.id));
  const processedBlockerTasks = new Set<string>();

  for (const item of input.memoryItems) {
    if (item.type !== 'blocker' || item.status === 'archived') continue;
    if (!item.sourceSessionId) continue;

    const linkedTaskId = sessionToTask.get(item.sourceSessionId);
    if (!linkedTaskId || !taskIds.has(linkedTaskId)) continue;
    if (processedBlockerTasks.has(linkedTaskId)) continue;

    const task = input.tasks.find((t) => t.id === linkedTaskId);
    if (!task) continue;
    if (task.status === 'done' || task.status === 'cancelled') continue;

    processedBlockerTasks.add(linkedTaskId);

    const proposedAction = {
      kind: 'update_plan' as const,
      taskId: linkedTaskId,
      suggestedStatus: 'blocked' as const,
    };

    candidates.push({
      type: 'update_plan',
      title: capTitle(`Mark task blocked: ${task.title}`),
      rationale: capRationale('A blocker was reported in a session associated with this task.'),
      proposedAction,
      confidence: 0.6,
      sources: [
        { type: 'task', id: linkedTaskId, reason: 'subject' },
        { type: 'memory_item', id: item.id, reason: 'driver' },
      ],
      relatedTaskId: linkedTaskId,
    });
  }

  return candidates;
}

// ── ask_user ───────────────────────────────────────────────────────────────────

export function askUserRule(input: RecommendationInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];

  const pendingDecisions = input.decisions.filter(
    (d) => d.confirmationRequired && d.status === 'proposed'
  );

  for (const decision of pendingDecisions) {
    // Use title only (typed field) — not decisionText body — to avoid leaking source content.
    const question = `Please confirm: ${decision.title}`.slice(0, 1024);

    const proposedAction = {
      kind: 'ask_user' as const,
      question,
    };

    const actionJson = JSON.stringify(proposedAction);
    if (!capProposedActionJson(actionJson)) continue;

    candidates.push({
      type: 'ask_user',
      title: capTitle(`Confirm decision: ${decision.title}`),
      rationale: capRationale('This decision requires explicit user confirmation before proceeding.'),
      proposedAction,
      confidence: 0.95,
      sources: [{ type: 'decision', id: decision.id, reason: 'driver' }],
    });
  }

  return candidates;
}

// ── mark_complete ──────────────────────────────────────────────────────────────

function allCriteriaMentionedInSummary(
  criteria: { id: string; text: string }[],
  summaryText: string
): boolean {
  if (criteria.length === 0) return false;
  const lower = summaryText.toLowerCase();
  return criteria.every((c) => {
    const words = c.text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    return words.length > 0 && words.some((w) => lower.includes(w));
  });
}

export function markCompleteRule(input: RecommendationInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];

  const taskSessionMap = new Map<string, SessionInput[]>();
  for (const s of input.sessions) {
    if (!s.taskId) continue;
    const arr = taskSessionMap.get(s.taskId) ?? [];
    arr.push(s);
    taskSessionMap.set(s.taskId, arr);
  }

  const summaryBySession = new Map<string, string>();
  for (const s of input.sessionSummaries) {
    if (!summaryBySession.has(s.sessionId)) {
      summaryBySession.set(s.sessionId, s.summaryText);
    }
  }

  for (const task of input.tasks) {
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') continue;
    if (task.acceptanceCriteria.length === 0) continue;

    const taskSessions = taskSessionMap.get(task.id) ?? [];

    // Check if all criteria mentioned in any session summary
    const criteriaMet = taskSessions.some((s) => {
      const summary = summaryBySession.get(s.id);
      return summary ? allCriteriaMentionedInSummary(task.acceptanceCriteria, summary) : false;
    });

    if (!criteriaMet) continue;

    // Check reviewer/qa session completed without failure
    const reviewerCompleted = taskSessions.some(
      (s) =>
        (s.role === 'reviewer' || s.role === 'qa') &&
        s.exitedAt !== null &&
        s.status !== 'failed'
    );

    if (!reviewerCompleted) continue;

    candidates.push({
      type: 'mark_complete',
      title: capTitle(`Mark complete: ${task.title}`),
      rationale: capRationale(
        'All acceptance criteria appear to have been met based on session summaries, and a reviewer session completed without issues.'
      ),
      proposedAction: { kind: 'mark_complete' as const, taskId: task.id },
      confidence: 0.6,
      sources: [{ type: 'task', id: task.id, reason: 'subject' }],
      relatedTaskId: task.id,
    });
  }

  return candidates;
}

// ── pause_work ─────────────────────────────────────────────────────────────────

export function pauseWorkRule(input: RecommendationInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];

  // Count open conflicts per task (via conflict sources of type 'task')
  const conflictsPerTask = new Map<string, ActiveConflictInput[]>();
  for (const conflict of input.activeConflicts) {
    if (conflict.status !== 'open') continue;
    for (const source of conflict.sources) {
      if (source.type === 'task') {
        const arr = conflictsPerTask.get(source.id) ?? [];
        arr.push(conflict);
        conflictsPerTask.set(source.id, arr);
      }
    }
  }

  for (const [taskId, conflicts] of conflictsPerTask.entries()) {
    if (conflicts.length < 2) continue;

    const task = input.tasks.find((t) => t.id === taskId);
    if (!task) continue;
    if (task.status === 'done' || task.status === 'cancelled') continue;

    const proposedAction = {
      kind: 'pause_work' as const,
      reason: `${conflicts.length} active conflicts are blocking this task.`,
      relatedTaskIds: [taskId],
    };

    const actionJson = JSON.stringify(proposedAction);
    if (!capProposedActionJson(actionJson)) continue;

    const sources: RecommendationSourceRef[] = [
      { type: 'task', id: taskId, reason: 'subject' },
      ...conflicts.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES - 1).map((c) => ({
        type: 'conflict' as const,
        id: c.id,
        reason: 'driver',
      })),
    ];

    candidates.push({
      type: 'pause_work',
      title: capTitle(`Pause work on: ${task.title}`),
      rationale: capRationale(
        `${conflicts.length} active conflicts target this task. Resolve conflicts before continuing.`
      ),
      proposedAction,
      confidence: 0.7,
      sources: sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
      relatedTaskId: taskId,
    });
  }

  return candidates;
}

// ── run_validation ─────────────────────────────────────────────────────────────

// Archive threshold: number of new arch notes before review_output fires (Trigger 2).
const ARCH_NOTE_THRESHOLD = 3;

// ── Shared helpers for run_validation / review_output ─────────────────────────

function buildSummaryBySessionMap(
  sessionSummaries: SessionSummaryInput[]
): Map<string, SessionSummaryInput> {
  const map = new Map<string, SessionSummaryInput>();
  for (const s of sessionSummaries) {
    if (!map.has(s.sessionId)) map.set(s.sessionId, s);
  }
  return map;
}

function buildRunValidationObjective(
  session: SessionInput,
  tasks: TaskInput[]
): string {
  if (session.taskId) {
    const task = tasks.find((t) => t.id === session.taskId);
    if (task) return `${task.title} (${task.role})`.slice(0, 200);
  }
  return `${session.role ?? 'engineer'} session`.slice(0, 200);
}

function isActiveSuppressed(
  goalId: string,
  type: RecommendationType,
  proposedAction: object,
  activeRecommendations: ActiveRecommendationInput[]
): boolean {
  const canonical = canonicalizeProposedActionJson(JSON.stringify(proposedAction));
  const fp = recommendationFingerprint(goalId, type, canonical);
  return activeRecommendations.some(
    (r) => r.fingerprint === fp && (r.status === 'proposed' || r.status === 'modified')
  );
}

export function runValidationRule(input: RecommendationInput): RecommendationCandidate[] {
  const summaryBySession = buildSummaryBySessionMap(input.sessionSummaries);

  const validationResultSessionIds = new Set<string>(
    input.memoryItems
      .filter((m) => m.type === 'validation_result')
      .map((m) => m.sourceSessionId)
      .filter((id): id is string => id !== null)
  );

  // Pre-compute latest positive reviewer/qa exitedAt to avoid N×M session scan.
  const maxPositiveReviewAt = input.sessions
    .filter((s) => (s.role === 'reviewer' || s.role === 'qa') && s.exitedAt !== null && s.status !== 'failed')
    .reduce((max, s) => (s.exitedAt! > max ? s.exitedAt! : max), '');

  const candidates: RecommendationCandidate[] = [];

  for (const session of input.sessions) {
    if (session.role !== 'engineer') continue;
    if (session.exitedAt === null) continue;

    const summary = summaryBySession.get(session.id);
    const evidence: SessionSummaryEvidence = {
      sessionId: session.id,
      sessionStatus: session.status,
      sessionRole: session.role,
      summaryText: summary?.summaryText ?? '',
      hasValidationResult: validationResultSessionIds.has(session.id),
    };

    if (!detectImplementationEvidence(evidence)) continue;
    if (maxPositiveReviewAt > session.exitedAt) continue;

    const objective = buildRunValidationObjective(session, input.tasks);
    const proposedAction = {
      kind: 'run_validation' as const,
      sessionId: session.id,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      suggestedRole: 'reviewer' as const,
      objective,
    };

    const actionJson = JSON.stringify(proposedAction);
    if (!capProposedActionJson(actionJson)) continue;
    if (isActiveSuppressed(input.goalId, 'run_validation', proposedAction, input.activeRecommendations)) continue;

    const sources: RecommendationSourceRef[] = [
      { type: 'session', id: session.id, reason: 'subject' },
    ];
    if (summary) {
      sources.push({ type: 'session_summary', id: summary.id, reason: 'evidence' });
    }

    candidates.push({
      type: 'run_validation',
      title: capTitle(`Validate: ${objective}`),
      rationale: capRationale(
        'Engineer session completed with implementation evidence. A reviewer or QA session is recommended.'
      ),
      proposedAction,
      confidence: 0.85,
      sources: sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
      relatedSessionId: session.id,
      ...(session.taskId ? { relatedTaskId: session.taskId } : {}),
    });
  }

  return candidates;
}

// ── review_output ──────────────────────────────────────────────────────────────

function mostRecentCompletedSession(sessions: SessionInput[]): SessionInput | undefined {
  return sessions
    .filter((s) => s.exitedAt !== null)
    .sort((a, b) => (b.exitedAt ?? '').localeCompare(a.exitedAt ?? ''))
    .at(0);
}

function tryReviewOutputCandidate(
  goalId: string,
  anchorSession: SessionInput,
  title: string,
  rationale: string,
  sources: RecommendationSourceRef[],
  activeRecommendations: ActiveRecommendationInput[]
): RecommendationCandidate | null {
  const proposedAction = { kind: 'review_output' as const, sessionId: anchorSession.id };
  if (!capProposedActionJson(JSON.stringify(proposedAction))) return null;
  if (isActiveSuppressed(goalId, 'review_output', proposedAction, activeRecommendations)) return null;
  return {
    type: 'review_output',
    title: capTitle(title),
    rationale: capRationale(rationale),
    proposedAction,
    confidence: 0.8,
    sources: sources.slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
    relatedSessionId: anchorSession.id,
  };
}

export function reviewOutputRule(input: RecommendationInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];

  // Cache anchor session for Triggers 1 and 2 (same computation).
  const anchorSession = mostRecentCompletedSession(input.sessions);

  // Trigger 1: decision requiring confirmation.
  if (anchorSession) {
    const confirmRequired = input.decisions.filter(
      (d) => d.confirmationRequired && d.status !== 'confirmed' && d.status !== 'archived'
    );
    if (confirmRequired.length > 0) {
      const sources: RecommendationSourceRef[] = [
        { type: 'session', id: anchorSession.id, reason: 'subject' },
        ...confirmRequired
          .slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES - 1)
          .map((d) => ({ type: 'decision' as const, id: d.id, reason: 'driver' })),
      ];
      const c = tryReviewOutputCandidate(
        input.goalId, anchorSession,
        'Review output: decision requires confirmation',
        'One or more decisions require confirmation. A review of the current session output is recommended.',
        sources, input.activeRecommendations
      );
      if (c) candidates.push(c);
    }
  }

  // Trigger 2: >= ARCH_NOTE_THRESHOLD non-archived architecture notes accumulated.
  if (anchorSession) {
    const archNotes = input.memoryItems.filter(
      (m) => m.type === 'architecture_note' && m.status !== 'archived'
    );
    if (archNotes.length >= ARCH_NOTE_THRESHOLD) {
      const sources: RecommendationSourceRef[] = [
        { type: 'session', id: anchorSession.id, reason: 'subject' },
        ...archNotes
          .slice(0, ORCHESTRATION_RECOMMENDATION_MAX_SOURCES - 1)
          .map((m) => ({ type: 'memory_item' as const, id: m.id, reason: 'evidence' })),
      ];
      const c = tryReviewOutputCandidate(
        input.goalId, anchorSession,
        `Review output: ${archNotes.length} architecture notes`,
        `${archNotes.length} architecture notes have accumulated. A review is recommended to confirm architectural direction.`,
        sources, input.activeRecommendations
      );
      if (c) candidates.push(c);
    }
  }

  // Trigger 3: reviewer-role session with negative outcome.
  const summaryBySession = buildSummaryBySessionMap(input.sessionSummaries);

  for (const session of input.sessions) {
    if (session.role !== 'reviewer') continue;
    const summary = summaryBySession.get(session.id);
    if (!summary) continue;

    const evidence: SessionSummaryEvidence = {
      sessionId: session.id,
      sessionStatus: session.status,
      sessionRole: session.role,
      summaryText: summary.summaryText,
      hasValidationResult: false,
    };

    if (!detectReviewerRejection(evidence)) continue;

    const proposedAction = {
      kind: 'review_output' as const,
      sessionId: session.id,
      reviewerRole: 'reviewer' as const,
    };

    const actionJson = JSON.stringify(proposedAction);
    if (!capProposedActionJson(actionJson)) continue;
    if (isActiveSuppressed(input.goalId, 'review_output', proposedAction, input.activeRecommendations)) continue;

    candidates.push({
      type: 'review_output',
      title: capTitle('Review output: reviewer session reported issues'),
      rationale: capRationale(
        'A reviewer session failed, indicating rejection or issues with the current output. A follow-up review is recommended.'
      ),
      proposedAction,
      confidence: 0.8,
      sources: [
        { type: 'session', id: session.id, reason: 'subject' },
        { type: 'session_summary', id: summary.id, reason: 'evidence' },
      ],
      relatedSessionId: session.id,
    });
  }

  return candidates;
}

// ── resolve_conflict (standalone; invoked by conflict detector orchestration conflict detector) ─────────

export interface ResolveConflictCandidateInput {
  conflictId: string;
  conflictTitle: string;
  goalId: string;
}

export function resolveConflictCandidate(
  input: ResolveConflictCandidateInput
): RecommendationCandidate {
  const proposedAction = {
    kind: 'resolve_conflict' as const,
    conflictId: input.conflictId,
  };

  return {
    type: 'resolve_conflict',
    title: capTitle(`Resolve conflict: ${input.conflictTitle}`),
    rationale: capRationale('A conflict was detected that requires user resolution before work can continue.'),
    proposedAction,
    confidence: 1.0,
    sources: [{ type: 'conflict', id: input.conflictId, reason: 'driver' }],
    relatedConflictId: input.conflictId,
  };
}
