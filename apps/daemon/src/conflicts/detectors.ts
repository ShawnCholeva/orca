import type Database from 'better-sqlite3';
import type {
  Conflict,
  ConflictSourceRef,
  RecommendationSourceRef,
} from '@orca/contracts';
import { listTasksByGoal } from '../tasks/projection.js';
import { listMemoryByGoal } from '../memory/projection.js';
import { listDecisionsByGoal } from '../decisions/projection.js';
import { listGoalWorkspaceLinks } from '../workspaces/projection.js';

const MAX_SESSIONS = 100;
const MAX_SUMMARIES = 20;
const MAX_TASKS = 100;
const MAX_MEMORY_ITEMS = 100;
const MAX_DECISIONS = 100;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'be',
  'for',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'use',
  'with',
]);

export interface TriggerEventRef {
  id?: string;
  type: string;
}

export interface ConflictDetectorRunInput {
  goalId: string;
  db: Database.Database;
  triggerEvent?: TriggerEventRef | null;
}

export interface ConflictDetector {
  run(input: ConflictDetectorRunInput): ConflictCandidate[];
}

export interface ConflictCandidate {
  conflictType: Conflict['conflictType'];
  severity: Conflict['severity'];
  title: string;
  description: string;
  sources: ConflictSourceRef[];
  recommendationSources: RecommendationSourceRef[];
  sourceUpdatedAts: string[];
}

interface SessionRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  status: string;
  role: string | null;
  created_at: string;
  exited_at: string | null;
}

interface SummaryRow {
  id: string;
  session_id: string;
  created_at: string;
}

interface DetectorSession {
  id: string;
  workspaceId: string;
  taskId: string | null;
  status: string;
  role: string | null;
  createdAt: string;
  exitedAt: string | null;
}

interface DetectorSummary {
  id: string;
  sessionId: string;
  createdAt: string;
}

interface DetectorTask {
  id: string;
  workspaceId: string | null;
  status: string;
  sources: { type: string; id: string }[];
  updatedAt: string;
}

interface DetectorMemoryItem {
  id: string;
  type: string;
  status: string;
  sourceId: string | null;
  sourceSessionId: string | null;
  updatedAt: string;
}

interface DetectorDecision {
  id: string;
  title: string;
  decisionText: string;
  status: string;
  confirmationRequired: boolean;
  updatedAt: string;
}

interface DetectorWorkspace {
  id: string;
  attachedAt: string;
}

export interface ConflictSnapshot {
  goalId: string;
  sessions: DetectorSession[];
  sessionSummaries: DetectorSummary[];
  tasks: DetectorTask[];
  memoryItems: DetectorMemoryItem[];
  decisions: DetectorDecision[];
  workspaces: DetectorWorkspace[];
}

let _db: Database.Database | null = null;
let _stmts: {
  listSessions: Database.Statement;
  listSummaries: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      listSessions: db.prepare(`
        SELECT id, workspace_id, task_id, status, role, created_at, exited_at
        FROM sessions
        WHERE goal_id = ? AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `),
      listSummaries: db.prepare(`
        SELECT ss.id, ss.session_id, ss.created_at
        FROM session_summaries ss
        JOIN sessions s ON s.id = ss.session_id
        WHERE ss.goal_id = ? AND s.archived_at IS NULL
        ORDER BY ss.created_at DESC, ss.id DESC
        LIMIT ?
      `),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function buildConflictSnapshot(db: Database.Database, goalId: string): ConflictSnapshot {
  const stmts = ensureStmts(db);
  const sessionRows = stmts.listSessions.all(goalId, MAX_SESSIONS) as SessionRow[];
  const summaryRows = stmts.listSummaries.all(goalId, MAX_SUMMARIES) as SummaryRow[];

  const tasks = listTasksByGoal(db, { goalId, includeArchived: false, limit: MAX_TASKS }).tasks
    .slice(0, MAX_TASKS)
    .map((task) => ({
      id: task.id,
      workspaceId: task.workspaceId,
      status: task.status,
      sources: task.sources.map((source) => ({ type: source.type, id: source.id })),
      updatedAt: task.updatedAt,
    }));

  const memoryItems = listMemoryByGoal(db, goalId, { includeArchived: false })
    .slice(0, MAX_MEMORY_ITEMS)
    .map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      sourceId: item.sourceId,
      sourceSessionId: item.sourceSessionId,
      updatedAt: item.updatedAt,
    }));

  const decisions = listDecisionsByGoal(db, goalId, { includeArchived: false })
    .slice(0, MAX_DECISIONS)
    .map((decision) => ({
      id: decision.id,
      title: decision.title,
      decisionText: decision.decisionText,
      status: decision.status,
      confirmationRequired: decision.confirmationRequired,
      updatedAt: decision.updatedAt,
    }));

  const workspaces = listGoalWorkspaceLinks(db, goalId).map((link) => ({
    id: link.workspaceId,
    attachedAt: link.attachedAt,
  }));

  return {
    goalId,
    sessions: sessionRows.map((session) => ({
      id: session.id,
      workspaceId: session.workspace_id,
      taskId: session.task_id,
      status: session.status,
      role: session.role,
      createdAt: session.created_at,
      exitedAt: session.exited_at,
    })),
    sessionSummaries: summaryRows.map((summary) => ({
      id: summary.id,
      sessionId: summary.session_id,
      createdAt: summary.created_at,
    })),
    tasks,
    memoryItems,
    decisions,
    workspaces,
  };
}

function source(type: ConflictSourceRef['type'], id: string, role?: ConflictSourceRef['role']): ConflictSourceRef {
  return role ? { type, id, role } : { type, id };
}

function recSource(type: RecommendationSourceRef['type'], id: string, reason: string): RecommendationSourceRef {
  return { type, id, reason };
}

function uniqueSources(sources: ConflictSourceRef[]): ConflictSourceRef[] {
  const seen = new Set<string>();
  const out: ConflictSourceRef[] = [];
  for (const item of sources) {
    const key = `${item.type}:${item.id}:${item.role ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function findTask(snapshot: ConflictSnapshot, taskId: string | null): DetectorTask | undefined {
  if (!taskId) return undefined;
  return snapshot.tasks.find((task) => task.id === taskId);
}

function tasksWithSource(
  snapshot: ConflictSnapshot,
  sourceType: string,
  sourceId: string
): DetectorTask[] {
  return snapshot.tasks.filter((task) =>
    task.sources.some((taskSource) => taskSource.type === sourceType && taskSource.id === sourceId)
  );
}

function workspaceTimestamp(snapshot: ConflictSnapshot, workspaceId: string): string | null {
  return snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.attachedAt ?? null;
}

function compactCandidate(input: ConflictCandidate): ConflictCandidate {
  return {
    ...input,
    sources: uniqueSources(input.sources).slice(0, 32),
    recommendationSources: input.recommendationSources.slice(0, 32),
    sourceUpdatedAts: [...new Set(input.sourceUpdatedAts.filter(Boolean))].sort(),
  };
}

export function detectWorkspaceOverlap(snapshot: ConflictSnapshot): ConflictCandidate[] {
  const running = snapshot.sessions.filter((session) => session.status === 'running');
  const byWorkspace = new Map<string, DetectorSession[]>();
  for (const session of running) {
    const existing = byWorkspace.get(session.workspaceId) ?? [];
    existing.push(session);
    byWorkspace.set(session.workspaceId, existing);
  }

  const candidates: ConflictCandidate[] = [];
  for (const [workspaceId, sessions] of byWorkspace) {
    if (sessions.length < 2) continue;
    const sorted = [...sessions].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        const taskA = findTask(snapshot, a.taskId);
        const taskB = findTask(snapshot, b.taskId);
        const sameTask = a.taskId !== null && a.taskId === b.taskId;
        const sources: ConflictSourceRef[] = [
          source('session', a.id, 'subject_a'),
          source('session', b.id, 'subject_b'),
          source('workspace', workspaceId, 'context'),
        ];
        if (taskA) sources.push(source('task', taskA.id, 'context'));
        if (taskB) sources.push(source('task', taskB.id, 'context'));

        candidates.push(compactCandidate({
          conflictType: 'workspace_overlap',
          severity: sameTask ? 'blocker' : 'warning',
          title: 'Workspace has overlapping running sessions',
          description: 'Two running sessions are attached to the same workspace.',
          sources,
          recommendationSources: [recSource('workspace', workspaceId, 'context')],
          sourceUpdatedAts: [
            a.exitedAt ?? a.createdAt,
            b.exitedAt ?? b.createdAt,
            taskA?.updatedAt,
            taskB?.updatedAt,
            workspaceTimestamp(snapshot, workspaceId),
          ].filter((value): value is string => Boolean(value)),
        }));
      }
    }
  }
  return candidates;
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 0 && !STOPWORDS.has(token))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

function negationSignature(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const signature = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === 'not' || token === 'no' || token === 'never') {
      signature.add(`${token}@${i}`);
    }
    if ((token === 'should' || token === 'must') && tokens[i + 1] === 'not') {
      signature.add(`${token} not@${i}`);
    }
  }
  return signature;
}

function negationsDiffer(a: string, b: string): boolean {
  const sigA = negationSignature(a);
  const sigB = negationSignature(b);
  for (const item of sigA) {
    if (!sigB.has(item)) return true;
  }
  for (const item of sigB) {
    if (!sigA.has(item)) return true;
  }
  return false;
}

export function detectContradictoryDecisions(snapshot: ConflictSnapshot): ConflictCandidate[] {
  const confirmed = snapshot.decisions
    .filter((decision) => decision.status === 'confirmed')
    .sort((a, b) => a.id.localeCompare(b.id));
  const candidates: ConflictCandidate[] = [];

  for (let i = 0; i < confirmed.length; i += 1) {
    for (let j = i + 1; j < confirmed.length; j += 1) {
      const a = confirmed[i]!;
      const b = confirmed[j]!;
      if (jaccard(titleTokens(a.title), titleTokens(b.title)) <= 0.5) continue;
      if (!negationsDiffer(a.decisionText, b.decisionText)) continue;

      candidates.push(compactCandidate({
        conflictType: 'contradictory_decisions',
        severity: 'warning',
        title: 'Confirmed decisions may contradict',
        description:
          'Two confirmed decisions have overlapping titles and different negation markers.',
        sources: [source('decision', a.id, 'subject_a'), source('decision', b.id, 'subject_b')],
        recommendationSources: [
          recSource('decision', a.id, 'evidence'),
          recSource('decision', b.id, 'evidence'),
        ],
        sourceUpdatedAts: [a.updatedAt, b.updatedAt],
      }));
    }
  }

  return candidates;
}

export function detectReviewerRejection(snapshot: ConflictSnapshot): ConflictCandidate[] {
  const latestSummaryBySession = new Map<string, DetectorSummary>();
  for (const summary of snapshot.sessionSummaries) {
    const existing = latestSummaryBySession.get(summary.sessionId);
    if (!existing || summary.createdAt > existing.createdAt) {
      latestSummaryBySession.set(summary.sessionId, summary);
    }
  }

  const latest = snapshot.sessions
    .filter((session) => session.role === 'reviewer' && session.status === 'failed')
    .map((session) => ({ session, summary: latestSummaryBySession.get(session.id) }))
    .filter((item): item is { session: DetectorSession; summary: DetectorSummary } =>
      item.summary !== undefined
    )
    .sort((a, b) => b.summary.createdAt.localeCompare(a.summary.createdAt))[0];

  if (!latest) return [];

  const task = findTask(snapshot, latest.session.taskId);
  const sources: ConflictSourceRef[] = [
    source('session', latest.session.id, 'subject_a'),
    source('session_summary', latest.summary.id, 'context'),
  ];
  if (task) sources.push(source('task', task.id, 'context'));

  return [
    compactCandidate({
      conflictType: 'reviewer_rejection',
      severity: 'warning',
      title: 'Reviewer reported rejection',
      description: 'A reviewer-role session ended in a rejected or failed state.',
      sources,
      recommendationSources: [
        recSource('session', latest.session.id, 'subject'),
        recSource('session_summary', latest.summary.id, 'evidence'),
      ],
      sourceUpdatedAts: [
        latest.session.exitedAt ?? latest.session.createdAt,
        latest.summary.createdAt,
        task?.updatedAt,
      ].filter((value): value is string => Boolean(value)),
    }),
  ];
}

export function detectBlockerReported(snapshot: ConflictSnapshot): ConflictCandidate[] {
  const candidates: ConflictCandidate[] = [];
  const blockers = snapshot.memoryItems.filter(
    (item) => item.type === 'blocker' && item.status !== 'archived'
  );

  for (const item of blockers) {
    const linkedTask = tasksWithSource(snapshot, 'memory_item', item.id)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    const severity = linkedTask?.status === 'in_progress' ? 'blocker' : 'warning';

    const sources: ConflictSourceRef[] = [source('memory_item', item.id, 'subject_a')];
    if (linkedTask) sources.push(source('task', linkedTask.id, 'context'));

    candidates.push(compactCandidate({
      conflictType: 'blocker_reported',
      severity,
      title: 'Blocker reported',
      description: 'A Goal memory item reports an unresolved blocker.',
      sources,
      recommendationSources: [recSource('memory_item', item.id, 'evidence')],
      sourceUpdatedAts: [item.updatedAt, linkedTask?.updatedAt].filter(
        (value): value is string => Boolean(value)
      ),
    }));
  }

  return candidates;
}

export function detectUnresolvedQuestion(snapshot: ConflictSnapshot): ConflictCandidate[] {
  const candidates: ConflictCandidate[] = [];
  const questions = snapshot.memoryItems.filter(
    (item) => item.type === 'open_question' && item.status !== 'archived'
  );
  const confirmationRequired = snapshot.decisions.filter(
    (decision) => decision.confirmationRequired && decision.status !== 'archived'
  );

  for (const item of questions) {
    const linkedTask = tasksWithSource(snapshot, 'memory_item', item.id)
      .filter((task) => task.status === 'in_progress')
      .sort((a, b) => a.id.localeCompare(b.id))[0];

    const linkedDecision =
      confirmationRequired.find((decision) => item.sourceId === decision.id) ??
      confirmationRequired.find((decision) =>
        snapshot.tasks.some(
          (task) =>
            task.sources.some((taskSource) => taskSource.type === 'memory_item' && taskSource.id === item.id) &&
            task.sources.some((taskSource) => taskSource.type === 'decision' && taskSource.id === decision.id)
        )
      );

    if (!linkedTask && !linkedDecision) continue;

    const sources: ConflictSourceRef[] = [source('memory_item', item.id, 'subject_a')];
    if (linkedTask) sources.push(source('task', linkedTask.id, 'context'));
    if (linkedDecision) sources.push(source('decision', linkedDecision.id, 'context'));

    candidates.push(compactCandidate({
      conflictType: 'unresolved_question',
      severity: 'info',
      title: 'Unresolved question blocks progress',
      description: 'An open question is linked to in-progress work or a decision requiring confirmation.',
      sources,
      recommendationSources: [recSource('memory_item', item.id, 'evidence')],
      sourceUpdatedAts: [item.updatedAt, linkedTask?.updatedAt, linkedDecision?.updatedAt].filter(
        (value): value is string => Boolean(value)
      ),
    }));
  }

  return candidates;
}

export class DeterministicConflictDetector implements ConflictDetector {
  run(input: ConflictDetectorRunInput): ConflictCandidate[] {
    const snapshot = buildConflictSnapshot(input.db, input.goalId);
    const all = [
      ...detectWorkspaceOverlap(snapshot),
      ...detectContradictoryDecisions(snapshot),
      ...detectReviewerRejection(snapshot),
      ...detectBlockerReported(snapshot),
      ...detectUnresolvedQuestion(snapshot),
    ];

    const seen = new Set<string>();
    const deduped: ConflictCandidate[] = [];
    for (const candidate of all) {
      const key = `${candidate.conflictType}:${candidate.sources
        .map((item) => item.id)
        .sort()
        .join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped;
  }
}

// ── Fake detector for tests ────────────────────────────────────────────────────

export class FakeConflictDetector implements ConflictDetector {
  private _candidates: ConflictCandidate[] = [];

  setFixtures(candidates: ConflictCandidate[]): void {
    this._candidates = candidates;
  }

  run(_input: ConflictDetectorRunInput): ConflictCandidate[] {
    return this._candidates;
  }
}
