import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TaskRole, TaskStatus } from '@orca/contracts';
import { getGoalRefinement } from '../goal-refinements.js';
import { GoalArchivedError, GoalNotFoundError } from '../sessions/errors.js';
import { listWorkspacesByGoal } from '../workspaces/projection.js';
import { listTasksByGoal } from './projection.js';

interface GoalRow {
  id: string;
  title: string;
  description: string;
  archived_at: string | null;
}

interface TaskInputWorkspace {
  id: string;
  isDirty: boolean | null;
}

interface TaskInputExistingTask {
  id: string;
  title: string;
  role: TaskRole;
  status: TaskStatus;
  fingerprint: string;
  updatedAt: string;
}

interface TaskInputRefinement {
  id: string;
  refinedAt: string;
  successCriteria: string[];
  constraints: string[];
  assumptions: string[];
}

export interface TaskGenerationInput {
  goalId: string;
  objective: string;
  refinement: TaskInputRefinement | null;
  workspaces: TaskInputWorkspace[];
  existingGeneratorTasks: TaskInputExistingTask[];
  inputFingerprint: string;
}

export interface BuildTaskGenerationInputParams {
  db: Database.Database;
  goalId: string;
}

const ACTIVE_TASK_STATUSES: TaskStatus[] = ['proposed', 'open', 'in_progress', 'blocked'];
const MAX_EXISTING_GENERATOR_TASKS = 20;
const FINGERPRINT_VERSION = 'm7-task-input-v1';

let _db: Database.Database | null = null;
let _selectGoal: Database.Statement<[string], GoalRow> | null = null;

function ensureGoalStmt(db: Database.Database): Database.Statement<[string], GoalRow> {
  if (db !== _db) {
    _db = db;
    _selectGoal = db.prepare(
      'SELECT id, title, description, archived_at FROM goals WHERE id = ?'
    );
  }
  return _selectGoal!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _selectGoal = null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function normalizeGoalObjective(description: string): string {
  return description.trim();
}

export function buildTaskGenerationInput(
  params: BuildTaskGenerationInputParams
): TaskGenerationInput {
  const { db, goalId } = params;
  const goalRow = ensureGoalStmt(db).get(goalId);

  if (!goalRow) {
    throw new GoalNotFoundError(goalId);
  }
  if (goalRow.archived_at !== null) {
    throw new GoalArchivedError(goalId);
  }

  const refinement = getGoalRefinement(db, goalId);
  const workspaces = listWorkspacesByGoal(db, goalId)
    .map((workspace) => ({
      id: workspace.id,
      isDirty: workspace.isDirty,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const existingGeneratorTasks = listTasksByGoal(db, {
    goalId,
    statuses: ACTIVE_TASK_STATUSES,
    includeArchived: false,
    limit: 200,
  }).tasks
    .filter((task) => task.origin === 'generator')
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
      return b.id.localeCompare(a.id);
    })
    .slice(0, MAX_EXISTING_GENERATOR_TASKS)
    .map((task) => ({
      id: task.id,
      title: task.title,
      role: task.role,
      status: task.status,
      fingerprint: task.fingerprint,
      updatedAt: task.updatedAt,
    }));

  const normalizedObjective = normalizeGoalObjective(goalRow.description);
  const normalizedRefinement: TaskInputRefinement | null = refinement
    ? {
        id: refinement.goalId,
        refinedAt: refinement.refinedAt,
        successCriteria: refinement.successCriteria,
        constraints: refinement.constraints,
        assumptions: refinement.assumptions,
      }
    : null;

  const fingerprintPayload = {
    version: FINGERPRINT_VERSION,
    goalId,
    objective: normalizedObjective,
    refinement: normalizedRefinement
      ? {
          id: normalizedRefinement.id,
          refinedAt: normalizedRefinement.refinedAt,
          successCriteria: normalizedRefinement.successCriteria,
          constraints: normalizedRefinement.constraints,
          assumptions: normalizedRefinement.assumptions,
        }
      : null,
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      isDirty: workspace.isDirty,
    })),
    existingGeneratorTasks: existingGeneratorTasks
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((task) => ({
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt,
        fingerprint: task.fingerprint,
      })),
  };

  return {
    goalId,
    objective: normalizedObjective,
    refinement: normalizedRefinement,
    workspaces,
    existingGeneratorTasks,
    inputFingerprint: sha256(JSON.stringify(fingerprintPayload)),
  };
}

