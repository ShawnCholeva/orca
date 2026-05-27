import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  type DomainEvent,
  SubmitWorkflowUserInputRequest,
  WorkflowStepRunResponse,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import { redactSecrets } from "../../memory/normalize.js";
import { createArtifact } from "../artifacts/usecases.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";
import type { OperatorRegistry } from "../operators/registry.js";
import type { OperatorSelector } from "../operators/selector.js";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { OrchestratorService } from "../orchestrator/service.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
import { getDecisionById } from "../decisions/usecases.js";
import { getWorkflowStepRunById } from "./projection.js";

export interface WorkflowStepRouteDeps {
  db: Database.Database;
  bus?: EventBus;
  operatorSelector?: Pick<OperatorSelector, "select">;
  orchestrationTransportBroker?: Pick<OrchestrationTransportBroker, "propose">;
  operatorRegistry?: Pick<OperatorRegistry, "list">;
  now?: () => string;
  idFactory?: () => string;
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function registerWorkflowStepRoutes(
  server: FastifyInstance,
  deps: WorkflowStepRouteDeps
): void {
  const now = deps.now ?? (() => new Date().toISOString());
  const orchestratorService =
    deps.operatorSelector && deps.orchestrationTransportBroker && deps.operatorRegistry
      ? new OrchestratorService(
          deps.operatorSelector,
          deps.orchestrationTransportBroker,
          deps.operatorRegistry
        )
      : null;

  function stepForGoal(goalId: string, stepRunId: string) {
    const stepRun = getWorkflowStepRunById(deps.db, stepRunId);
    if (!stepRun || stepRun.goalId !== goalId) return null;
    return stepRun;
  }

  server.get("/v1/goals/:goalId/workflow-step-runs/:id", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const stepRun = stepForGoal(goalId, id);
    if (!stepRun) {
      reply.status(404);
      return apiError(
        "workflow_step_run_not_found",
        `Workflow step run not found for goal ${goalId}: ${id}`
      );
    }
    return WorkflowStepRunResponse.parse({ stepRun });
  });

  server.post("/v1/goals/:goalId/workflow-step-runs/:id/submit-input", async (request, reply) => {
    const { goalId, id } = request.params as { goalId: string; id: string };
    const parsed = SubmitWorkflowUserInputRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "validation_failed", issues: parsed.error.issues };
    }
    if (parsed.data.stepRunId !== id) {
      reply.status(400);
      return apiError("validation_failed", "stepRunId in body must match route id");
    }

    const stepRun = stepForGoal(goalId, id);
    if (!stepRun) {
      reply.status(404);
      return apiError(
        "workflow_step_run_not_found",
        `Workflow step run not found for goal ${goalId}: ${id}`
      );
    }

    // Validate answerText + questionDecisionId BEFORE opening the transaction
    // so we can return proper HTTP errors.
    const answerText = parsed.data.answerText;
    const questionDecisionId = parsed.data.questionDecisionId;
    let validatedDecision: Awaited<ReturnType<typeof getDecisionById>> = null;
    let existingTurns: ReturnType<typeof listArtifactsForRun> = [];

    if (answerText !== undefined) {
      if (answerText.trim().length === 0) {
        reply.status(400);
        return apiError("validation_failed", "answerText must not be empty");
      }
      if (!questionDecisionId) {
        reply.status(400);
        return apiError(
          "validation_failed",
          "questionDecisionId is required when submitting an answer"
        );
      }
      const decision = getDecisionById(deps.db, questionDecisionId);
      if (
        !decision ||
        decision.stepRunId !== stepRun.id ||
        decision.decisionType !== "request_user_input"
      ) {
        reply.status(400);
        return apiError(
          "validation_failed",
          "questionDecisionId does not match an active question for this step"
        );
      }
      const turns = listArtifactsForRun(deps.db, stepRun.workflowRunId).filter(
        (a) => a.type === "interview_turn" && a.stepRunId === stepRun.id
      );
      if (
        turns.some(
          (a) =>
            (JSON.parse(a.body) as { questionDecisionId?: string }).questionDecisionId ===
            questionDecisionId
        )
      ) {
        reply.status(409);
        return apiError("question_already_answered", "this question has already been answered");
      }
      validatedDecision = decision;
      existingTurns = turns;
    }

    const artifactIds: string[] = [];
    const stagedEvents: DomainEvent[] = [];
    deps.db.transaction(() => {
      if (answerText !== undefined && validatedDecision) {
        const turn = {
          turnIndex: existingTurns.length,
          questionDecisionId: questionDecisionId!,
          question: validatedDecision.reason,
          answer: redactSecrets(answerText),
          answeredAt: now(),
        };
        const created = createArtifact(
          deps.db,
          now,
          {
            goalId,
            workflowRunId: stepRun.workflowRunId,
            stepRunId: stepRun.id,
            type: "interview_turn",
            title: `Turn ${turn.turnIndex}`.slice(0, 256),
            body: JSON.stringify(turn),
            source: "user",
            linkedSessionId: null,
            linkedTaskId: null,
            linkedContextPackageId: null,
          },
          deps.idFactory,
          stagedEvents
        );
        artifactIds.push(created.id);
      }

      for (const artifact of parsed.data.artifactInputs ?? []) {
        const created = createArtifact(
          deps.db,
          now,
          {
            goalId,
            workflowRunId: stepRun.workflowRunId,
            stepRunId: stepRun.id,
            type: artifact.type,
            title: redactSecrets(artifact.title).slice(0, 256),
            body: redactSecrets(artifact.body),
            source: "user",
            linkedSessionId: null,
            linkedTaskId: null,
            linkedContextPackageId: null,
          },
          deps.idFactory,
          stagedEvents
        );
        artifactIds.push(created.id);
      }

      stagedEvents.push(
        appendWorkflowEvent(
          deps.db,
          "workflow.user.input.submitted",
          {
            goalId,
            workflowRunId: stepRun.workflowRunId,
            stepRunId: stepRun.id,
            answerBytes:
              parsed.data.answerText === undefined
                ? undefined
                : Buffer.byteLength(redactSecrets(parsed.data.answerText), "utf8"),
            artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
          },
          now(),
          deps.idFactory
        )
      );
    })();
    if (deps.bus) {
      publishStagedWorkflowEvents(deps.bus, stagedEvents);
    }

    if (orchestratorService) {
      await orchestratorService.requestNextDecision(deps.db, now, stepRun.workflowRunId, {
        bus: deps.bus,
        idFactory: deps.idFactory,
      });
    }

    const refreshed = getWorkflowStepRunById(deps.db, id);
    if (!refreshed) {
      reply.status(404);
      return apiError(
        "workflow_step_run_not_found",
        `Workflow step run not found for goal ${goalId}: ${id}`
      );
    }
    return WorkflowStepRunResponse.parse({ stepRun: refreshed });
  });
}
