import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  WORKFLOW_ARTIFACT_MAX_BODY_BYTES,
  type DomainEvent,
  type WorkflowArtifact,
  type WorkflowArtifactType,
} from "@orca/contracts";

import { appendWorkflowEvent } from "../events.js";
import { stepRules, type StepRuleContext } from "../steps/rules/index.js";
import { getWorkflowStepRunById } from "../steps/projection.js";
import { recordExitCriteriaSatisfaction } from "../steps/usecases.js";
import {
  getArtifactById,
  listArtifactsForGoal as listArtifactsForGoalProjection,
  listArtifactsForRun as listArtifactsForRunProjection,
} from "./projection.js";

export interface CreateArtifactInput {
  goalId: string;
  workflowRunId: string | null;
  stepRunId: string | null;
  type: WorkflowArtifactType;
  title: string;
  body: string;
  source: WorkflowArtifact["source"];
  linkedSessionId?: string | null;
  linkedTaskId?: string | null;
  linkedContextPackageId?: string | null;
}

function contextForStep(
  db: Database.Database,
  stepRunId: string
): StepRuleContext | null {
  const stepRun = getWorkflowStepRunById(db, stepRunId);
  if (!stepRun) return null;
  return {
    goalId: stepRun.goalId,
    workflowRunId: stepRun.workflowRunId,
    stepRunId: stepRun.id,
    artifacts: listArtifactsForRunProjection(db, stepRun.workflowRunId),
    satisfiedExitCriteria: stepRun.satisfiedExitCriteria,
    outstandingExitCriteria: stepRun.outstandingExitCriteria,
  };
}

export function createArtifact(
  db: Database.Database,
  now: () => string,
  input: CreateArtifactInput,
  idFactory: () => string = randomUUID,
  stagedEvents?: DomainEvent[]
): WorkflowArtifact {
  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  if (bodyBytes > WORKFLOW_ARTIFACT_MAX_BODY_BYTES) {
    throw new Error("artifact_body_too_large");
  }

  const artifactId = idFactory();
  const createdAt = now();

  return db.transaction(() => {
    db.prepare(
      "INSERT INTO workflow_artifacts (id, goal_id, workflow_run_id, step_run_id, type, title, body, source, linked_session_id, linked_task_id, linked_context_package_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      artifactId,
      input.goalId,
      input.workflowRunId,
      input.stepRunId,
      input.type,
      input.title.slice(0, 256),
      input.body,
      input.source,
      input.linkedSessionId ?? null,
      input.linkedTaskId ?? null,
      input.linkedContextPackageId ?? null,
      createdAt
    );

    const event = appendWorkflowEvent(
      db,
      "workflow.artifact.created",
      {
        artifactId,
        goalId: input.goalId,
        workflowRunId: input.workflowRunId,
        stepRunId: input.stepRunId,
        type: input.type,
        bodyBytes,
      },
      createdAt,
      idFactory
    );
    stagedEvents?.push(event);

    const artifact = getArtifactById(db, artifactId)!;
    if (input.stepRunId) {
      const ctx = contextForStep(db, input.stepRunId);
      const stepRun = ctx ? getWorkflowStepRunById(db, input.stepRunId) : null;
      const rule = stepRun ? stepRules[stepRun.stepTemplateId] : undefined;
      if (rule && ctx) {
        const result =
          rule.onArtifactCreated?.({ db, now, artifact, ctx }) ?? {
            satisfiedCriteria: rule.evaluateArtifactSatisfies?.(artifact, ctx) ?? [],
          };
        if (result.satisfiedCriteria.length > 0) {
          recordExitCriteriaSatisfaction(db, now, input.stepRunId, result.satisfiedCriteria);
        }
      }
    }

    return artifact;
  })();
}

export function listArtifactsForRun(
  db: Database.Database,
  runId: string
): WorkflowArtifact[] {
  return listArtifactsForRunProjection(db, runId);
}

export function listArtifactsForGoal(
  db: Database.Database,
  goalId: string,
  type?: WorkflowArtifactType
): WorkflowArtifact[] {
  return listArtifactsForGoalProjection(db, goalId, type);
}

export function getArtifact(
  db: Database.Database,
  id: string
): WorkflowArtifact | null {
  return getArtifactById(db, id);
}
