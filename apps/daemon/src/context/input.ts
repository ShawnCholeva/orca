import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ContextAssemblyInput,
  CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS,
  CONTEXT_PACKAGE_MAX_RENDERED_BYTES,
  type SelectableDecision,
  type SelectableMemory,
  type SelectableSummary,
} from '@orca/contracts';
import { getGoalRefinement } from '../goal-refinements.js';
import { listMemoryByGoal } from '../memory/projection.js';
import { listDecisionsByGoal } from '../decisions/projection.js';
import { redactSecrets } from '../memory/normalize.js';
import { getWorkspaceByIdAndGoal } from '../workspaces/projection.js';
import { GoalNotFoundError } from '../sessions/errors.js';

// IMPORTANT: This file MUST NOT import from sessions/output-store or any pty/* module.
// The tail-isolation test (context-input-isolation.test.ts) statically enforces this.

const PER_SECTION_MAX_BYTES = 8 * 1024;
const ESTIMATED_TOKEN_BUDGET = 8000;

interface GoalInputRow {
  id: string;
  title: string;
  status: string;
  archived_at: string | null;
}

interface SiblingSummaryRow {
  id: string;
  session_id: string;
  headline: string;
  summary_text: string;
  truncated: 0 | 1;
  created_at: string;
}

export interface BuildContextInputDeps {
  db: Database.Database;
  assemblerVersion: string;
}

export interface BuildContextInputRequest {
  goalId: string;
  workspaceId: string | null;
  role: string;
  adapterId: string;
  objective: string;
  objectiveHash: string;
}

export interface BuildContextInputResult {
  input: ContextAssemblyInput;
  sourceFingerprint: string;
  goalArchivedAt: string | null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

let _db: Database.Database | null = null;
let _stmts: {
  selectGoal: Database.Statement;
  listSiblingSummaries: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (db !== _db) {
    _db = db;
    _stmts = {
      selectGoal: db.prepare(
        'SELECT id, title, status, archived_at FROM goals WHERE id = ?'
      ),
      // Non-archived sessions only; join ensures archived sessions' summaries are excluded.
      listSiblingSummaries: db.prepare(
        `SELECT ss.id, ss.session_id, ss.headline, ss.summary_text, ss.truncated, ss.created_at
         FROM session_summaries ss
         JOIN sessions s ON s.id = ss.session_id
         WHERE ss.goal_id = ?
           AND s.archived_at IS NULL
         ORDER BY ss.created_at DESC, ss.id DESC`
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

/**
 * Builds ContextAssemblyInput from bounded persisted projection reads.
 *
 * Throws GoalNotFoundError if the goal does not exist.
 * Returns goalArchivedAt so callers can check archived state without a second read.
 *
 * Does NOT read session output tails or transcript modules. Does NOT call git or scan
 * the filesystem. Uses only already-persisted workspace metadata.
 */
export function buildContextAssemblyInput(
  deps: BuildContextInputDeps,
  request: BuildContextInputRequest
): BuildContextInputResult {
  const { db, assemblerVersion } = deps;
  const { goalId, workspaceId, role, adapterId, objective, objectiveHash } = request;

  const stmts = ensureStmts(db);

  const goalRow = stmts.selectGoal.get(goalId) as GoalInputRow | undefined;
  if (!goalRow) {
    throw new GoalNotFoundError(goalId);
  }

  const refinement = getGoalRefinement(db, goalId);

  //    null if workspaceId absent, missing, or attached to a different goal.
  let workspaceInput: {
    id: string;
    name: string;
    pathDisplay: string;
    branch?: string | null;
    dirty?: boolean | null;
  } | null = null;

  if (workspaceId !== null) {
    const ws = getWorkspaceByIdAndGoal(db, workspaceId, goalId);
    if (ws) {
      workspaceInput = {
        id: ws.id,
        name: ws.name,
        pathDisplay: ws.path,
        branch: ws.branch ?? null,
        dirty: ws.isDirty ?? null,
      };
    }
    // Foreign or missing workspace: workspaceInput stays null.
    // The assembler detects the gap and adds a warning.
  }

  const memoryItems = listMemoryByGoal(db, goalId, { includeArchived: false });
  const decisions = listDecisionsByGoal(db, goalId, { includeArchived: false });
  const summaryRows = stmts.listSiblingSummaries.all(goalId) as SiblingSummaryRow[];

  const memory: SelectableMemory[] = memoryItems.map((item) => ({
    id: item.id,
    type: item.type,
    status: item.status,
    content: redactSecrets(item.content),
    contentHash: item.contentHash,
    confidence: item.confidence,
    sourceSessionId: item.sourceSessionId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  const selectableDecisions: SelectableDecision[] = decisions.map((d) => ({
    id: d.id,
    title: redactSecrets(d.title),
    decisionText: redactSecrets(d.decisionText),
    rationale: d.rationale !== null ? redactSecrets(d.rationale) : null,
    status: d.status,
    confirmationRequired: d.confirmationRequired,
    confidence: d.confidence,
    sourceSessionId: d.sourceSessionId,
    createdAt: d.createdAt,
    confirmedAt: d.confirmedAt,
    updatedAt: d.updatedAt,
  }));

  const siblingSummaries: SelectableSummary[] = summaryRows.map((s) => ({
    id: s.id,
    sessionId: s.session_id,
    headline: redactSecrets(s.headline),
    summaryText: redactSecrets(s.summary_text),
    truncated: s.truncated !== 0,
    createdAt: s.created_at,
  }));

  const sortedMemoryParts = memoryItems
    .map((m) => `${m.id}:${m.updatedAt}:${m.contentHash}`)
    .sort();

  const sortedDecisionParts = decisions
    .map((d) => `${d.id}:${d.updatedAt}`)
    .sort();

  const sortedSummaryParts = summaryRows
    .map((s) => `${s.id}:${s.created_at}`)
    .sort();

  // goal_refinements uses goal_id as PK; use refinedAt as the version signal.
  const refinementPart = refinement
    ? `${refinement.goalId}:${refinement.refinedAt}`
    : '';

  const wsPart = workspaceInput
    ? `${workspaceInput.id}:${workspaceInput.name}:${workspaceInput.branch ?? ''}:${workspaceInput.dirty?.toString() ?? ''}`
    : '';

  const fingerprintParts = [
    ...sortedMemoryParts,
    ...sortedDecisionParts,
    ...sortedSummaryParts,
    wsPart,
    refinementPart,
    `${role}:${adapterId}:${objectiveHash}`,
    assemblerVersion,
  ];

  const sourceFingerprint = sha256(fingerprintParts.join('\n'));

  const refinementInput = refinement
    ? {
        id: refinement.goalId,
        constraints: refinement.constraints,
        successCriteria: refinement.successCriteria,
      }
    : null;

  const input = ContextAssemblyInput.parse({
    goal: {
      id: goalRow.id,
      title: goalRow.title,
      status: goalRow.status,
      archivedAt: goalRow.archived_at,
    },
    refinement: refinementInput,
    workspace: workspaceInput ?? undefined,
    role,
    adapterId,
    objective: objective.slice(0, CONTEXT_PACKAGE_MAX_OBJECTIVE_CHARS),
    memory,
    decisions: selectableDecisions,
    siblingSummaries,
    budget: {
      maxBytes: CONTEXT_PACKAGE_MAX_RENDERED_BYTES,
      perSectionMaxBytes: PER_SECTION_MAX_BYTES,
      estimatedTokenBudget: ESTIMATED_TOKEN_BUDGET,
    },
  });

  return { input, sourceFingerprint, goalArchivedAt: goalRow.archived_at };
}
