import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES,
  ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS,
  type DomainEvent,
  type ProposedAction,
  type RecommendationType,
} from "@orca/contracts";

import { redactSecrets } from "../../memory/normalize.js";
import {
  canonicalizeProposedActionJson,
  recommendationFingerprint,
} from "../../recommendations/fingerprint.js";
import { appendWorkflowEvent } from "../events.js";

export type WorkflowRecommendationType = Extract<
  RecommendationType,
  | "advance_workflow_step"
  | "launch_workflow_session"
  | "complete_workflow_run"
  | "mark_artifact_satisfied"
  | "request_user_input"
>;

export interface CreateWorkflowRecommendationInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  type: WorkflowRecommendationType;
  proposedAction: ProposedAction;
  rationale: string;
  decisionId: string;
}

export interface CreateWorkflowRecommendationInTxOptions {
  idFactory?: () => string;
  stagedEvents?: DomainEvent[];
}

const TITLE_BY_TYPE: Record<WorkflowRecommendationType, string> = {
  advance_workflow_step: "Advance workflow step",
  launch_workflow_session: "Launch workflow session",
  complete_workflow_run: "Complete workflow run",
  mark_artifact_satisfied: "Mark artifact satisfied",
  request_user_input: "Request user input",
};

function capRationale(rationale: string): string {
  return redactSecrets(rationale.trim()).slice(0, ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS);
}

export function createRecommendationForWorkflowInTx(
  db: Database.Database,
  now: () => string,
  input: CreateWorkflowRecommendationInput,
  options: CreateWorkflowRecommendationInTxOptions = {}
): string {
  const idFactory = options.idFactory ?? randomUUID;
  const id = idFactory();
  const createdAt = now();
  const proposedActionJson = JSON.stringify(input.proposedAction);
  if (
    Buffer.byteLength(proposedActionJson, "utf8") >
    ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES
  ) {
    throw new Error("workflow_recommendation_proposed_action_too_large");
  }
  const fingerprint = recommendationFingerprint(
    input.goalId,
    input.type,
    canonicalizeProposedActionJson(proposedActionJson)
  );

  db.prepare(
    "UPDATE recommendations SET status = 'superseded', superseded_reason = 'duplicate', resolved_at = ?, updated_at = ? WHERE goal_id = ? AND type = ? AND status = 'proposed'"
  ).run(createdAt, createdAt, input.goalId, input.type);

  db.prepare(
    `INSERT INTO recommendations
      (id, goal_id, generation_id, type, status, source, title, rationale, proposed_action_json,
       confidence, sources_json, related_task_id, related_session_id, related_context_pkg_id,
       related_conflict_id, fingerprint, superseded_by_id, superseded_reason, created_at,
       updated_at, resolved_at, workflow_step_run_id)
     VALUES (?, ?, NULL, ?, 'proposed', 'deterministic_provider', ?, ?, ?, 0.8, '[]',
       NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, ?)`
  ).run(
    id,
    input.goalId,
    input.type,
    TITLE_BY_TYPE[input.type].slice(0, ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS),
    capRationale(input.rationale),
    proposedActionJson,
    fingerprint,
    createdAt,
    createdAt,
    input.stepRunId
  );

  const event = appendWorkflowEvent(
    db,
    "workflow.recommendation.created",
    {
      recommendationId: id,
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      type: input.type,
      decisionId: input.decisionId,
    },
    createdAt,
    idFactory
  );
  options.stagedEvents?.push(event);
  if (input.type === "request_user_input") {
    options.stagedEvents?.push(
      appendWorkflowEvent(
        db,
        "workflow.user.input.requested",
        {
          goalId: input.goalId,
          workflowRunId: input.workflowRunId,
          stepRunId: input.stepRunId,
          recommendationId: id,
        },
        createdAt,
        idFactory
      )
    );
  }

  return id;
}

