import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConflictSourceRef } from '@orca/contracts';
import { getGoalRefinement } from '../goal-refinements.js';
import { GoalArchivedError, GoalNotFoundError } from '../sessions/errors.js';
import { listWorkspacesByGoal } from '../workspaces/projection.js';
import { listTasksByGoal } from '../tasks/projection.js';
import { listMemoryByGoal } from '../memory/projection.js';
import { listDecisionsByGoal } from '../decisions/projection.js';
import { listConflictsByGoal } from '../conflicts/projection.js';
import { listRecommendationsByGoal } from './projection.js';
import { listRecentFeedbackByGoal } from './feedback.js';

const FINGERPRINT_VERSION = 'm7-rec-input-v1';

// ── Body caps for rule consumption ─────────────────────────────────────────────
// Bodies may be included in input for rule evaluation only.
// They must never leak into events, logs, or persisted free-text fields.
const BODY_CAP_MEMORY = 512;
const BODY_CAP_DECISION = 512;
const BODY_CAP_SUMMARY = 1024;

// ── Collection caps ────────────────────────────────────────────────────────────
const MAX_TASKS = 20;
const MAX_SESSION_SUMMARIES = 5;
const MAX_DECISIONS = 20;
const MAX_MEMORY_ITEMS = 30;
const MAX_ACTIVE_RECS = 10;
const MAX_ACTIVE_CONFLICTS = 10;
const MAX_RECENT_FEEDBACK = 10;

// ── Input types ────────────────────────────────────────────────────────────────

export interface WorkspaceInput {
  id: string;
  isDirty: boolean | null;
}

export interface TaskInput {
  id: string;
  title: string;
  role: string;
  status: string;
  workspaceId: string | null;
  parentTaskId: string | null;
  description: string;
  acceptanceCriteria: { id: string; text: string }[];
  sources: { type: string; id: string }[];
  fingerprint: string;
  updatedAt: string;
}

export interface SessionInput {
  id: string;
  workspaceId: string;
  taskId: string | null;
  status: string;
  role: string | null;
  adapterId: string;
  exitedAt: string | null;
}

export interface SessionSummaryInput {
  id: string;
  sessionId: string;
  /** Capped summaryText for rule evaluation only. Not for events/logs. */
  summaryText: string;
  headline: string;
  createdAt: string;
}

export interface DecisionInput {
  id: string;
  title: string;
  status: string;
  confirmationRequired: boolean;
  /** Capped decisionText for rule evaluation only. Not for events/logs. */
  decisionText: string;
  updatedAt: string;
}

export interface MemoryItemInput {
  id: string;
  type: string;
  status: string;
  /** Capped content for rule evaluation only. Not for events/logs. */
  content: string;
  sourceSessionId: string | null;
  updatedAt: string;
}

export interface ActiveRecommendationInput {
  id: string;
  type: string;
  status: string;
  relatedTaskId: string | null;
  relatedConflictId: string | null;
  fingerprint: string;
}

export interface ActiveConflictInput {
  id: string;
  conflictType: string;
  status: string;
  sources: ConflictSourceRef[];
}

export interface RecentFeedbackInput {
  id: string;
  recommendationId: string;
  action: string;
  createdAt: string;
}

export interface RefinementInput {
  goalId: string;
  successCriteria: string[];
  constraints: string[];
  assumptions: string[];
  refinedAt: string;
}

export interface RecommendationInput {
  goalId: string;
  objective: string;
  refinement: RefinementInput | null;
  workspaces: WorkspaceInput[];
  tasks: TaskInput[];
  sessions: SessionInput[];
  sessionSummaries: SessionSummaryInput[];
  decisions: DecisionInput[];
  memoryItems: MemoryItemInput[];
  latestContextPackageId: string | null;
  activeRecommendations: ActiveRecommendationInput[];
  activeConflicts: ActiveConflictInput[];
  recentFeedback: RecentFeedbackInput[];
  inputFingerprint: string;
}

export interface BuildRecommendationInputParams {
  db: Database.Database;
  goalId: string;
  trigger?: string;
}

// ── Private DB row types (never exposed) ──────────────────────────────────────

interface GoalDbRow {
  id: string;
  title: string;
  description: string;
  archived_at: string | null;
}

interface SessionDbRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  status: string;
  role: string | null;
  adapter_id: string;
  exited_at: string | null;
}

interface ContextPkgIdRow {
  id: string;
}

interface SummaryDbRow {
  id: string;
  session_id: string;
  headline: string;
  summary_text: string;
  created_at: string;
}

// ── Statement cache ────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;
let _stmts: {
  getGoal: Database.Statement;
  listSessions: Database.Statement;
  getLatestContextPackageId: Database.Statement;
  listSummaries: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      getGoal: db.prepare('SELECT id, title, description, archived_at FROM goals WHERE id = ?'),
      listSessions: db.prepare(
        'SELECT id, workspace_id, task_id, status, role, adapter_id, exited_at FROM sessions WHERE goal_id = ? ORDER BY created_at DESC LIMIT 100'
      ),
      getLatestContextPackageId: db.prepare(
        "SELECT id FROM context_packages WHERE goal_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1"
      ),
      listSummaries: db.prepare(
        `SELECT id, session_id, headline, SUBSTR(summary_text, 1, ${BODY_CAP_SUMMARY}) AS summary_text, created_at FROM session_summaries WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

// ── Fingerprint ────────────────────────────────────────────────────────────────

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function computeInputFingerprint(params: {
  goalId: string;
  refinement: RefinementInput | null;
  workspaces: WorkspaceInput[];
  tasks: TaskInput[];
  memoryItems: MemoryItemInput[];
  decisions: DecisionInput[];
  sessionSummaries: SessionSummaryInput[];
  latestContextPackageId: string | null;
  activeRecommendations: ActiveRecommendationInput[];
  activeConflicts: ActiveConflictInput[];
  trigger: string;
}): string {
  const payload = {
    version: FINGERPRINT_VERSION,
    goalId: params.goalId,
    refinement: params.refinement
      ? { goalId: params.refinement.goalId, refinedAt: params.refinement.refinedAt }
      : null,
    workspaces: [...params.workspaces]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => ({ id: w.id, isDirty: w.isDirty })),
    tasks: [...params.tasks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({ id: t.id, status: t.status, updatedAt: t.updatedAt })),
    memoryItems: [...params.memoryItems]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, updatedAt: m.updatedAt })),
    decisions: [...params.decisions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => ({ id: d.id, status: d.status, updatedAt: d.updatedAt })),
    sessionSummaries: [...params.sessionSummaries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({ id: s.id, createdAt: s.createdAt })),
    latestContextPackageId: params.latestContextPackageId,
    activeRecommendations: [...params.activeRecommendations]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, status: r.status })),
    activeConflicts: [...params.activeConflicts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({ id: c.id, status: c.status })),
    trigger: params.trigger,
  };
  return sha256(JSON.stringify(payload));
}

// ── Builder ────────────────────────────────────────────────────────────────────

export function buildRecommendationInput(
  params: BuildRecommendationInputParams
): RecommendationInput {
  const { db, goalId, trigger = 'manual' } = params;
  const stmts = ensureStmts(db);

  const goalRow = stmts.getGoal.get(goalId) as GoalDbRow | undefined;
  if (!goalRow) throw new GoalNotFoundError(goalId);
  if (goalRow.archived_at !== null) throw new GoalArchivedError(goalId);

  const refinementRaw = getGoalRefinement(db, goalId);
  const refinement: RefinementInput | null = refinementRaw
    ? {
        goalId: refinementRaw.goalId,
        successCriteria: refinementRaw.successCriteria,
        constraints: refinementRaw.constraints,
        assumptions: refinementRaw.assumptions,
        refinedAt: refinementRaw.refinedAt,
      }
    : null;

  const workspaces: WorkspaceInput[] = listWorkspacesByGoal(db, goalId).map((w) => ({
    id: w.id,
    isDirty: w.isDirty,
  }));

  const tasksRaw = listTasksByGoal(db, {
    goalId,
    includeArchived: false,
    limit: 200,
  }).tasks
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, MAX_TASKS);

  const tasks: TaskInput[] = tasksRaw.map((t) => ({
    id: t.id,
    title: t.title,
    role: t.role,
    status: t.status,
    workspaceId: t.workspaceId,
    parentTaskId: t.parentTaskId,
    description: t.description,
    acceptanceCriteria: t.acceptanceCriteria.map((c) => ({ id: c.id, text: c.text })),
    sources: t.sources.map((s) => ({ type: s.type, id: s.id })),
    fingerprint: t.fingerprint,
    updatedAt: t.updatedAt,
  }));

  const sessionRows = stmts.listSessions.all(goalId) as SessionDbRow[];
  const sessions: SessionInput[] = sessionRows.map((s) => ({
    id: s.id,
    workspaceId: s.workspace_id,
    taskId: s.task_id,
    status: s.status,
    role: s.role,
    adapterId: s.adapter_id,
    exitedAt: s.exited_at,
  }));

  const summaryRows = stmts.listSummaries.all(goalId, MAX_SESSION_SUMMARIES) as SummaryDbRow[];
  const sessionSummaries: SessionSummaryInput[] = summaryRows.map((s) => ({
    id: s.id,
    sessionId: s.session_id,
    summaryText: s.summary_text,
    headline: s.headline,
    createdAt: s.created_at,
  }));

  const decisionsRaw = listDecisionsByGoal(db, goalId, {}).slice(0, MAX_DECISIONS);
  const decisions: DecisionInput[] = decisionsRaw.map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    confirmationRequired: d.confirmationRequired,
    decisionText: d.decisionText.slice(0, BODY_CAP_DECISION),
    updatedAt: d.updatedAt,
  }));

  const memoryRaw = listMemoryByGoal(db, goalId, { includeArchived: false }).slice(
    0,
    MAX_MEMORY_ITEMS
  );
  const memoryItems: MemoryItemInput[] = memoryRaw.map((m) => ({
    id: m.id,
    type: m.type,
    status: m.status,
    content: m.content.slice(0, BODY_CAP_MEMORY),
    sourceSessionId: m.sourceSessionId,
    updatedAt: m.updatedAt,
  }));

  const pkgRow = stmts.getLatestContextPackageId.get(goalId) as ContextPkgIdRow | undefined;
  const latestContextPackageId = pkgRow?.id ?? null;

  // Fetch both proposed and modified so suppression checks cover both non-terminal statuses.
  const proposedRecs = listRecommendationsByGoal(db, {
    goalId,
    status: 'proposed',
    limit: MAX_ACTIVE_RECS,
  }).recommendations;
  const modifiedRecs = listRecommendationsByGoal(db, {
    goalId,
    status: 'modified',
    limit: MAX_ACTIVE_RECS,
  }).recommendations;
  const activeRecsRaw = [...proposedRecs, ...modifiedRecs].slice(0, MAX_ACTIVE_RECS);
  const activeRecommendations: ActiveRecommendationInput[] = activeRecsRaw.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    relatedTaskId: r.relatedTaskId,
    relatedConflictId: r.relatedConflictId,
    fingerprint: r.fingerprint,
  }));

  const activeConflictsRaw = listConflictsByGoal(db, {
    goalId,
    status: 'open',
    limit: MAX_ACTIVE_CONFLICTS,
  }).conflicts;
  const activeConflicts: ActiveConflictInput[] = activeConflictsRaw.map((c) => ({
    id: c.id,
    conflictType: c.conflictType,
    status: c.status,
    sources: c.sources,
  }));

  const recentFeedbackRaw = listRecentFeedbackByGoal(db, goalId, MAX_RECENT_FEEDBACK);
  const recentFeedback: RecentFeedbackInput[] = recentFeedbackRaw.map((f) => ({
    id: f.id,
    recommendationId: f.recommendationId,
    action: f.action,
    createdAt: f.createdAt,
  }));

  const inputFingerprint = computeInputFingerprint({
    goalId,
    refinement,
    workspaces,
    tasks,
    memoryItems,
    decisions,
    sessionSummaries,
    latestContextPackageId,
    activeRecommendations,
    activeConflicts,
    trigger,
  });

  return {
    goalId,
    objective: goalRow.description.trim(),
    refinement,
    workspaces,
    tasks,
    sessions,
    sessionSummaries,
    decisions,
    memoryItems,
    latestContextPackageId,
    activeRecommendations,
    activeConflicts,
    recentFeedback,
    inputFingerprint,
  };
}
