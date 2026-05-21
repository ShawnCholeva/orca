import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  AssociateTaskSessionRequest,
  AssociateTaskSessionResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  ListTasksQuery,
  ListTasksResponse,
  SplitTaskResponse,
  SplitTaskRequest,
  TaskGenerationResponse,
  TaskGenerationRequest,
  UpdateTaskRequest,
  UpdateTaskResponse,
  type TaskAcceptanceCriterion,
  type TaskValidationStep,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import type { TaskGenerator } from './rules.js';
import { buildTaskGenerationInput } from './input.js';
import { taskGenerationRequestFingerprint } from './fingerprint.js';
import {
  associateTaskWithSession,
  createTask,
  CrossGoalAssociationError,
  getTaskById,
  getActiveTaskGenerationByFp,
  InvalidStatusTransitionError,
  listTaskGenerationsByGoal,
  listTasksByGoal,
  runTaskGeneration,
  splitTask,
  TaskNotFoundError,
  updateTask,
} from './usecases.js';
import { getTasksByIds, getSessionGoalId } from './projection.js';
import { GoalArchivedError, GoalNotFoundError } from '../sessions/errors.js';
import { getWorkspaceByIdAndGoal } from '../workspaces/projection.js';

export interface TaskRouteDeps {
  db: Database.Database;
  bus: EventBus;
  taskGenerator: TaskGenerator;
  now?: () => string;
  idFactory?: () => string;
}

interface GoalRow {
  id: string;
  archived_at: string | null;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function makeCriterionIds(
  items: string[],
  idFactory: () => string
): TaskAcceptanceCriterion[] {
  return items.map((text) => ({
    id: idFactory(),
    text,
  }));
}

function makeValidationStepIds(
  items: Array<{ text: string; kind: TaskValidationStep['kind'] }>,
  idFactory: () => string
): TaskValidationStep[] {
  return items.map((item) => ({
    id: idFactory(),
    text: item.text,
    kind: item.kind,
  }));
}

function isQueuedForReevaluation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('queued for re-evaluation');
}

export function registerTaskRoutes(server: FastifyInstance, deps: TaskRouteDeps): void {
  const { db, bus, taskGenerator } = deps;

  const stmtGetGoal = db.prepare<[string], GoalRow>(
    'SELECT id, archived_at FROM goals WHERE id = ?'
  );

  function getGoalRow(goalId: string): GoalRow | undefined {
    return stmtGetGoal.get(goalId);
  }

  function ensureWorkspaceBelongsToGoal(
    workspaceId: string | null | undefined,
    goalId: string
  ): { ok: true } | { ok: false; response: ReturnType<typeof apiError>; status: number } {
    if (workspaceId === undefined || workspaceId === null) return { ok: true };
    const workspace = getWorkspaceByIdAndGoal(db, workspaceId, goalId);
    if (!workspace) {
      return {
        ok: false,
        status: 404,
        response: apiError(
          'workspace_not_found',
          `Workspace ${workspaceId} not attached to goal ${goalId}`
        ),
      };
    }
    return { ok: true };
  }

  function ensureDependenciesBelongToGoal(
    dependencyIds: string[] | undefined,
    goalId: string
  ): { ok: true } | { ok: false; response: ReturnType<typeof apiError>; status: number } {
    if (!dependencyIds || dependencyIds.length === 0) return { ok: true };
    const tasks = getTasksByIds(db, dependencyIds);
    if (tasks.length !== dependencyIds.length) {
      const existingIds = new Set(tasks.map((task) => task.id));
      const missingId = dependencyIds.find((id) => !existingIds.has(id))!;
      return {
        ok: false,
        status: 404,
        response: apiError(
          'dependency_task_not_found',
          `Dependency task not found: ${missingId}`
        ),
      };
    }
    const crossGoalTask = tasks.find((task) => task.goalId !== goalId);
    if (crossGoalTask) {
      return {
        ok: false,
        status: 404,
        response: apiError(
          'dependency_task_not_found',
          `Dependency task ${crossGoalTask.id} does not belong to goal ${goalId}`
        ),
      };
    }
    return { ok: true };
  }

  server.post('/v1/goals/:goalId/tasks/generate', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const parsed = TaskGenerationRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const goalRow = getGoalRow(goalId);
    if (!goalRow) {
      reply.status(404);
      return apiError('goal_not_found', `Goal not found: ${goalId}`);
    }
    if (goalRow.archived_at !== null) {
      reply.status(409);
      return apiError('goal_archived', `Goal is archived: ${goalId}`);
    }

    const generationInput = buildTaskGenerationInput({ db, goalId });
    const requestFingerprint = taskGenerationRequestFingerprint(
      goalId,
      parsed.data.trigger,
      null,
      taskGenerator.id,
      taskGenerator.version,
      generationInput.inputFingerprint
    );
    const existing = getActiveTaskGenerationByFp(db, goalId, requestFingerprint);
    if (existing) {
      reply.status(202);
      return TaskGenerationResponse.parse({ generation: existing });
    }

    try {
      const generation = await runTaskGeneration(
        {
          db,
          bus,
          taskGenerator,
          now: deps.now,
          idFactory: deps.idFactory,
        },
        {
          goalId,
          trigger: parsed.data.trigger,
          triggerSourceId: null,
        }
      );
      reply.status(202);
      return TaskGenerationResponse.parse({ generation });
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof GoalArchivedError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (isQueuedForReevaluation(error)) {
        const activeGeneration = getActiveTaskGenerationByFp(db, goalId, requestFingerprint);
        if (activeGeneration) {
          reply.status(202);
          return TaskGenerationResponse.parse({ generation: activeGeneration });
        }
      }
      throw error;
    }
  });

  server.get('/v1/goals/:goalId/tasks', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const queryParsed = ListTasksQuery.safeParse(request.query);
    if (!queryParsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: queryParsed.error.issues };
    }

    const goalRow = getGoalRow(goalId);
    if (!goalRow) {
      reply.status(404);
      return apiError('goal_not_found', `Goal not found: ${goalId}`);
    }

    const query = queryParsed.data;
    const result = listTasksByGoal(db, {
      goalId,
      statuses: query.status ? [query.status] : undefined,
      workspaceId: query.workspaceId,
      role: query.role,
      parentTaskId: query.parentTaskId,
      includeArchived: query.includeArchived,
      limit: query.limit,
      cursor: query.cursor,
    });

    return ListTasksResponse.parse({
      tasks: result.tasks,
      generations: listTaskGenerationsByGoal(db, goalId, 5),
    });
  });

  server.post('/v1/goals/:goalId/tasks', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const parsed = CreateTaskRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const goalRow = getGoalRow(goalId);
    if (!goalRow) {
      reply.status(404);
      return apiError('goal_not_found', `Goal not found: ${goalId}`);
    }
    if (goalRow.archived_at !== null) {
      reply.status(409);
      return apiError('goal_archived', `Goal is archived: ${goalId}`);
    }

    const workspaceValidation = ensureWorkspaceBelongsToGoal(parsed.data.workspaceId, goalId);
    if (!workspaceValidation.ok) {
      reply.status(workspaceValidation.status);
      return workspaceValidation.response;
    }

    if (parsed.data.parentTaskId !== null) {
      const parentTask = getTaskById(db, parsed.data.parentTaskId);
      if (!parentTask || parentTask.goalId !== goalId) {
        reply.status(404);
        return apiError(
          'parent_task_not_found',
          `Parent task ${parsed.data.parentTaskId} not found for goal ${goalId}`
        );
      }
    }

    const dependencyValidation = ensureDependenciesBelongToGoal(parsed.data.dependencies, goalId);
    if (!dependencyValidation.ok) {
      reply.status(dependencyValidation.status);
      return dependencyValidation.response;
    }

    const idFactory = deps.idFactory ?? randomUUID;
    const task = createTask(
      {
        db,
        bus,
        now: deps.now,
        idFactory: deps.idFactory,
      },
      {
        goalId,
        origin: 'user',
        role: parsed.data.role,
        title: parsed.data.title,
        description: parsed.data.description,
        workspaceId: parsed.data.workspaceId,
        parentTaskId: parsed.data.parentTaskId,
        dependencies: parsed.data.dependencies,
        sources: parsed.data.sources,
        acceptanceCriteria: makeCriterionIds(parsed.data.acceptanceCriteria, idFactory),
        validationSteps: makeValidationStepIds(parsed.data.validationSteps, idFactory),
      }
    );

    return CreateTaskResponse.parse({ task });
  });

  server.patch('/v1/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = UpdateTaskRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const task = getTaskById(db, id);
    if (!task) {
      reply.status(404);
      return apiError('task_not_found', `Task not found: ${id}`);
    }

    const goalRow = getGoalRow(task.goalId);
    if (goalRow?.archived_at !== null) {
      reply.status(409);
      return apiError('goal_archived', `Goal is archived: ${task.goalId}`);
    }

    const workspaceValidation = ensureWorkspaceBelongsToGoal(parsed.data.workspaceId, task.goalId);
    if (!workspaceValidation.ok) {
      reply.status(workspaceValidation.status);
      return workspaceValidation.response;
    }

    const dependencyValidation = ensureDependenciesBelongToGoal(parsed.data.dependencies, task.goalId);
    if (!dependencyValidation.ok) {
      reply.status(dependencyValidation.status);
      return dependencyValidation.response;
    }

    try {
      const idFactory = deps.idFactory ?? randomUUID;
      const updated = updateTask(
        {
          db,
          bus,
          now: deps.now,
          idFactory: deps.idFactory,
        },
        id,
        {
          title: parsed.data.title,
          description: parsed.data.description,
          role: parsed.data.role,
          workspaceId: parsed.data.workspaceId,
          status: parsed.data.status,
          dependencies: parsed.data.dependencies,
          sources: parsed.data.sources,
          acceptanceCriteria: parsed.data.acceptanceCriteria
            ? makeCriterionIds(parsed.data.acceptanceCriteria, idFactory)
            : undefined,
          validationSteps: parsed.data.validationSteps
            ? makeValidationStepIds(parsed.data.validationSteps, idFactory)
            : undefined,
        }
      );
      return UpdateTaskResponse.parse({ task: updated.task });
    } catch (error) {
      if (error instanceof InvalidStatusTransitionError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof TaskNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post('/v1/tasks/:id/split', async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = SplitTaskRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const parentTask = getTaskById(db, id);
    if (!parentTask) {
      reply.status(404);
      return apiError('task_not_found', `Task not found: ${id}`);
    }

    const goalRow = getGoalRow(parentTask.goalId);
    if (goalRow?.archived_at !== null) {
      reply.status(409);
      return apiError('goal_archived', `Goal is archived: ${parentTask.goalId}`);
    }

    for (const child of parsed.data.children) {
      const workspaceValidation = ensureWorkspaceBelongsToGoal(child.workspaceId, parentTask.goalId);
      if (!workspaceValidation.ok) {
        reply.status(workspaceValidation.status);
        return workspaceValidation.response;
      }

      const dependencyValidation = ensureDependenciesBelongToGoal(child.dependencies, parentTask.goalId);
      if (!dependencyValidation.ok) {
        reply.status(dependencyValidation.status);
        return dependencyValidation.response;
      }
    }

    try {
      const idFactory = deps.idFactory ?? randomUUID;
      const result = splitTask(
        {
          db,
          bus,
          now: deps.now,
          idFactory: deps.idFactory,
        },
        {
          parentTaskId: id,
          setParentStatus: parsed.data.setParentStatus,
          children: parsed.data.children.map((child) => ({
            title: child.title,
            description: child.description,
            role: child.role,
            workspaceId: child.workspaceId ?? null,
            dependencies: child.dependencies,
            sources: child.sources,
            acceptanceCriteria: makeCriterionIds(child.acceptanceCriteria, idFactory),
            validationSteps: makeValidationStepIds(child.validationSteps, idFactory),
          })),
        }
      );
      return SplitTaskResponse.parse({
        parentTask: result.parent,
        childTasks: result.children,
      });
    } catch (error) {
      if (error instanceof InvalidStatusTransitionError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof TaskNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post('/v1/tasks/:id/associate-session', async (request, reply) => {
    const { id } = request.params as { id: string };

    const parsed = AssociateTaskSessionRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const task = getTaskById(db, id);
    if (!task) {
      reply.status(404);
      return apiError('task_not_found', `Task not found: ${id}`);
    }

    const goalRow = getGoalRow(task.goalId);
    if (goalRow?.archived_at !== null) {
      reply.status(409);
      return apiError('goal_archived', `Goal is archived: ${task.goalId}`);
    }

    const sessionGoalId = getSessionGoalId(db, parsed.data.sessionId);
    if (sessionGoalId === null) {
      reply.status(404);
      return apiError('session_not_found', `Session not found: ${parsed.data.sessionId}`);
    }
    if (sessionGoalId !== task.goalId) {
      reply.status(409);
      return apiError(
        'cross_goal_association',
        `Session ${parsed.data.sessionId} does not belong to goal ${task.goalId}`
      );
    }

    try {
      const updatedTask = associateTaskWithSession(
        {
          db,
          bus,
          now: deps.now,
          idFactory: deps.idFactory,
        },
        id,
        parsed.data.sessionId
      );
      return AssociateTaskSessionResponse.parse({ task: updatedTask });
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof CrossGoalAssociationError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
