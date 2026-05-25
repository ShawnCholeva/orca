import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  AcceptRecommendationResponse,
  DismissRecommendationResponse,
  GetRecommendationResponse,
  ListRecommendationsQuery,
  ListRecommendationsResponse,
  ModifyRecommendationRequest,
  ModifyRecommendationResponse,
  RecommendationFeedbackRequest,
  RecommendationGenerationRequest,
  RecommendationGenerationResponse,
  RejectRecommendationResponse,
} from '@orca/contracts';
import type { EventBus } from '../events.js';
import type { RecommendationProvider } from './provider.js';
import { buildRecommendationInput } from './input.js';
import { recommendationGenerationRequestFingerprint } from './fingerprint.js';
import {
  acceptRecommendation,
  dismissRecommendation,
  getActiveRecommendationGenerationByFp,
  getFeedbackByRecommendationId,
  getRecommendationById,
  InvalidRecommendationStatusError,
  listRecommendationGenerationsByGoal,
  listRecommendationsByGoal,
  modifyRecommendation,
  RecommendationNotFoundError,
  rejectRecommendation,
  runRecommendationGeneration,
  WorkflowRecommendationActionError,
} from './usecases.js';

export interface RecommendationRouteDeps {
  db: Database.Database;
  bus: EventBus;
  recommendationProvider: RecommendationProvider;
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

function isQueuedForReevaluation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('queued for re-evaluation');
}

function parseBooleanQuery(value: unknown): boolean | null {
  if (value === undefined) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

export function registerRecommendationRoutes(
  server: FastifyInstance,
  deps: RecommendationRouteDeps
): void {
  const { db, bus, recommendationProvider } = deps;

  const stmtGetGoal = db.prepare<[string], GoalRow>(
    'SELECT id, archived_at FROM goals WHERE id = ?'
  );

  function getGoalRow(goalId: string): GoalRow | undefined {
    return stmtGetGoal.get(goalId);
  }

  server.post('/v1/goals/:goalId/recommendations/generate', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const parsed = RecommendationGenerationRequest.safeParse(request.body);
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

    const generationInput = buildRecommendationInput({
      db,
      goalId,
      trigger: parsed.data.trigger,
    });
    const requestFingerprint = recommendationGenerationRequestFingerprint(
      goalId,
      parsed.data.trigger,
      'manual',
      recommendationProvider.id,
      recommendationProvider.version,
      generationInput.inputFingerprint
    );
    const existing = getActiveRecommendationGenerationByFp(db, goalId, requestFingerprint);
    if (existing) {
      reply.status(202);
      return RecommendationGenerationResponse.parse({ generation: existing });
    }

    try {
      const generation = await runRecommendationGeneration(
        {
          db,
          bus,
          recommendationProvider,
          now: deps.now,
          idFactory: deps.idFactory,
        },
        {
          goalId,
          trigger: parsed.data.trigger,
          triggerSourceId: 'manual',
        }
      );
      reply.status(202);
      return RecommendationGenerationResponse.parse({ generation });
    } catch (error) {
      if (isQueuedForReevaluation(error)) {
        const activeGeneration = getActiveRecommendationGenerationByFp(db, goalId, requestFingerprint);
        if (activeGeneration) {
          reply.status(202);
          return RecommendationGenerationResponse.parse({ generation: activeGeneration });
        }
      }
      throw error;
    }
  });

  server.get('/v1/goals/:goalId/recommendations', async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    const queryParsed = ListRecommendationsQuery.safeParse(request.query);
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
    const rawIncludeGenerations = (request.query as { includeGenerations?: unknown }).includeGenerations;
    const includeGenerations = rawIncludeGenerations === undefined
      ? query.includeGenerations
      : parseBooleanQuery(rawIncludeGenerations);
    if (includeGenerations === null) {
      reply.status(400);
      return apiError('validation_failed', 'includeGenerations must be true or false');
    }

    const result = listRecommendationsByGoal(db, {
      goalId,
      status: query.status ?? 'proposed',
      type: query.type,
      relatedTaskId: query.relatedTaskId,
      limit: query.limit,
      cursor: query.cursor,
    });

    return ListRecommendationsResponse.parse({
      recommendations: result.recommendations,
      generations: includeGenerations
        ? listRecommendationGenerationsByGoal(db, goalId, 5)
        : [],
    });
  });

  server.get('/v1/recommendations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const recommendation = getRecommendationById(db, id);
    if (!recommendation) {
      reply.status(404);
      return apiError('recommendation_not_found', `Recommendation not found: ${id}`);
    }

    return GetRecommendationResponse.parse({
      recommendation,
      feedback: getFeedbackByRecommendationId(db, id),
    });
  });

  server.post('/v1/recommendations/:id/accept', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RecommendationFeedbackRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const result = acceptRecommendation(
        { db, bus, now: deps.now, idFactory: deps.idFactory },
        id,
        parsed.data.note
      );
      return AcceptRecommendationResponse.parse({
        recommendation: result.recommendation,
        proposedAction: result.recommendation.proposedAction,
        feedback: result.feedback,
      });
    } catch (error) {
      if (error instanceof RecommendationNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof InvalidRecommendationStatusError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      if (error instanceof WorkflowRecommendationActionError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post('/v1/recommendations/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RecommendationFeedbackRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const result = rejectRecommendation(
        { db, bus, now: deps.now, idFactory: deps.idFactory },
        id,
        parsed.data.note
      );
      return RejectRecommendationResponse.parse({
        recommendation: result.recommendation,
        feedback: result.feedback,
      });
    } catch (error) {
      if (error instanceof RecommendationNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof InvalidRecommendationStatusError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.post('/v1/recommendations/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RecommendationFeedbackRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const result = dismissRecommendation(
        { db, bus, now: deps.now, idFactory: deps.idFactory },
        id,
        parsed.data.note
      );
      return DismissRecommendationResponse.parse({
        recommendation: result.recommendation,
        feedback: result.feedback,
      });
    } catch (error) {
      if (error instanceof RecommendationNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof InvalidRecommendationStatusError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });

  server.patch('/v1/recommendations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ModifyRecommendationRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const result = modifyRecommendation(
        { db, bus, now: deps.now, idFactory: deps.idFactory },
        id,
        parsed.data
      );
      return ModifyRecommendationResponse.parse({
        recommendation: result.recommendation,
        feedback: result.feedback,
      });
    } catch (error) {
      if (error instanceof RecommendationNotFoundError) {
        reply.status(404);
        return apiError(error.code, error.message);
      }
      if (error instanceof InvalidRecommendationStatusError) {
        reply.status(409);
        return apiError(error.code, error.message);
      }
      throw error;
    }
  });
}
