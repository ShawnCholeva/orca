import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  HumanReviewPayload,
  ORCHESTRATION_HUMAN_REVIEW_MAX_SUMMARY_BYTES,
  OperatorSelection,
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type DomainEvent,
  type ModelProviderId,
  type OperatorDescriptor,
  type OrchestrationDecisionKind,
  type OrchestrationRequest as OrchestrationRequestT,
  type SubmitHumanReviewDecisionRequest as SubmitHumanReviewDecisionRequestT,
  type WorkflowDecisionTrace,
  WorkflowGuardrailConfig,
  type WorkflowGuardrailConfig as WorkflowGuardrailConfigT,
} from "@orca/contracts";
import { z } from "zod";

import type { EventBus } from "../../events.js";
import { redactSecrets } from "../../memory/normalize.js";
import { decisionFingerprint, recordDecisionInTx } from "../decisions/usecases.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";
import {
  evaluateAllGuardrailsInTx,
  evaluateGuardrail,
  type GuardrailContext,
} from "../guardrails/evaluator.js";
import { createRecommendationForWorkflowInTx } from "../orchestrator/workflow-recommendations.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { getWorkflowStepRunById } from "../steps/projection.js";
import { getTemplateById } from "../templates/projection.js";
import { appendTransportAttemptFinishedEvent } from "./events.js";
import { validateOperatorSelectionProposal } from "./proposals.js";

interface AttemptRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  decision_id: string | null;
  provider_id: ModelProviderId;
  model: string;
  transport: "one_shot" | "hidden_interactive" | "human_review";
  status: "pending" | "running" | "succeeded" | "rejected" | "failed" | "fallback";
  failure_reason: string | null;
  failure_message: string | null;
}

interface HumanReviewRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  attempt_id: string;
  decision_kind: OrchestrationDecisionKind;
  payload_json: string;
  status: "pending" | "submitted" | "accepted" | "rejected";
}

const SelectOperatorRequestPayload = z
  .object({
    stepName: z.string().min(1).max(100),
    stepPurpose: z.string().max(4096),
    recommendedCapabilities: z.array(z.string().min(1).max(80)).max(20).default([]),
    recommendedOperatorIds: z.array(z.string().min(1).max(100)).max(10).default([]),
    excludedOperatorIds: z.array(z.string().min(1).max(100)).max(10).default([]),
    readyOperators: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            kind: z.enum(["agent", "model", "human"]),
            capabilities: z.array(z.string().min(1).max(80)).max(20),
          })
          .strict()
      )
      .max(20)
      .default([]),
  })
  .strict();

type SelectOperatorRequestPayload = z.infer<typeof SelectOperatorRequestPayload>;

export class HumanReviewNotFoundError extends Error {
  readonly code = "human_review_not_found" as const;

  constructor(goalId: string, workflowRunId: string, attemptId: string) {
    super(
      `Human review not found for goal ${goalId}, run ${workflowRunId}, attempt ${attemptId}`
    );
    this.name = "HumanReviewNotFoundError";
  }
}

export class HumanReviewNotPendingError extends Error {
  readonly code = "human_review_not_pending" as const;

  constructor(attemptId: string) {
    super(`Human review attempt is not pending: ${attemptId}`);
    this.name = "HumanReviewNotPendingError";
  }
}

export class HumanReviewValidationError extends Error {
  readonly code = "validation_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "HumanReviewValidationError";
  }
}

export class HumanReviewProposalRejectedError extends Error {
  readonly code = "proposal_rejected" as const;

  constructor(message: string) {
    super(message);
    this.name = "HumanReviewProposalRejectedError";
  }
}

export interface CreateHumanReviewRequestInput {
  request: OrchestrationRequestT;
  attemptId: string;
}

export interface CreateHumanReviewRequestDeps {
  db: Database.Database;
  now?: () => string;
  idFactory?: () => string;
}

export interface SubmitHumanReviewDecisionInput {
  goalId: string;
  workflowRunId: string;
  attemptId: string;
  request: SubmitHumanReviewDecisionRequestT;
}

export interface SubmitHumanReviewDecisionDeps {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
  listOperators?: (goalId: string) => Promise<OperatorDescriptor[]>;
}

export interface SubmitHumanReviewDecisionResult {
  decision: WorkflowDecisionTrace;
  recommendationIds: string[];
}

function nowIso(now: (() => string) | undefined): string {
  return now?.() ?? new Date().toISOString();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8").subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function sanitizeMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  const sanitized = redactSecrets(value.trim()).slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
  return sanitized.length > 0 ? sanitized : null;
}

function tryParseSelectOperatorPayload(
  payload: unknown
): SelectOperatorRequestPayload | null {
  const parsed = SelectOperatorRequestPayload.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function toOperatorDescriptors(payload: SelectOperatorRequestPayload): OperatorDescriptor[] {
  return payload.readyOperators.map((operator) => ({
    id: operator.id,
    kind: operator.kind,
    displayName: operator.id,
    capabilities: operator.capabilities,
    ready: true,
    supportsRepoEditing: operator.kind !== "model",
    supportsTerminal: operator.kind !== "model",
  }));
}

function sortOperators(
  operators: OperatorDescriptor[],
  recommendedOperatorIds: string[]
): OperatorDescriptor[] {
  return [...operators].sort((left, right) => {
    const leftIndex = recommendedOperatorIds.indexOf(left.id);
    const rightIndex = recommendedOperatorIds.indexOf(right.id);
    const leftRank = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER;
    const rightRank = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return left.id.localeCompare(right.id);
  });
}

function loadGuardrails(
  db: Database.Database,
  workflowRunId: string
): WorkflowGuardrailConfigT[] {
  const row = db
    .prepare(
      `SELECT wt.guardrails_json
         FROM workflow_runs wr
         JOIN workflow_templates wt
           ON wt.id = wr.template_id
        WHERE wr.id = ?`
    )
    .get(workflowRunId) as { guardrails_json: string } | undefined;
  if (!row) return [];
  const parsed = z.array(WorkflowGuardrailConfig).safeParse(
    JSON.parse(row.guardrails_json)
  );
  return parsed.success ? parsed.data : [];
}

function describeGuardrails(guardrails: WorkflowGuardrailConfigT[]): string {
  if (guardrails.length === 0) return "none";
  return guardrails
    .slice(0, 8)
    .map((guardrail) => `${guardrail.id}:${guardrail.kind}`)
    .join(", ");
}

function loadFailedTrace(
  db: Database.Database,
  request: OrchestrationRequestT,
  attemptId: string
): string {
  const rows = db
    .prepare(
      "SELECT transport, status, failure_reason, failure_message FROM orchestration_transport_attempts WHERE goal_id = ? AND workflow_run_id = ? AND COALESCE(step_run_id, '') = COALESCE(?, '') AND id != ? ORDER BY created_at ASC, id ASC LIMIT 12"
    )
    .all(
      request.goalId,
      request.workflowRunId,
      request.stepRunId,
      attemptId
    ) as Array<{
      transport: string;
      status: string;
      failure_reason: string | null;
      failure_message: string | null;
    }>;

  if (rows.length === 0) return "no prior transport attempts";
  return rows
    .map((row) => {
      const reason = row.failure_reason ?? "none";
      const message = sanitizeMessage(row.failure_message);
      return `${row.transport}:${row.status}:${reason}${message ? ` (${message})` : ""}`;
    })
    .join("; ");
}

function reviewTitle(kind: OrchestrationDecisionKind): string {
  if (kind === "select_operator") return "Choose an operator";
  return "Human review required";
}

function summaryForReview(args: {
  stepPurpose: string;
  guardrailsSummary: string;
  failedTraceSummary: string;
}): string {
  const lines = [
    `Step purpose: ${redactSecrets(args.stepPurpose).trim() || "not provided"}`,
    `Guardrails: ${args.guardrailsSummary}`,
    `Failed transports: ${args.failedTraceSummary}`,
    "Submit one structured proposal envelope.",
  ];
  return truncateUtf8(lines.join("\n"), ORCHESTRATION_HUMAN_REVIEW_MAX_SUMMARY_BYTES);
}

function createOperatorChoices(
  payload: SelectOperatorRequestPayload,
  guardrails: WorkflowGuardrailConfigT[],
  request: OrchestrationRequestT
): HumanReviewPayload["choices"] {
  const readyOperators = sortOperators(
    toOperatorDescriptors(payload).filter(
      (operator) => !payload.excludedOperatorIds.includes(operator.id)
    ),
    payload.recommendedOperatorIds
  );

  const validChoices: HumanReviewPayload["choices"] = [];
  for (const operator of readyOperators) {
    const alternatives = readyOperators
      .filter((item) => item.id !== operator.id)
      .map((item) => item.id)
      .slice(0, 8);
    const selection = {
      operatorId: operator.id,
      operatorKind: operator.kind,
      reason: `Human review selected ${operator.id}`,
      requiredCapabilities: payload.recommendedCapabilities.filter((capability) =>
        operator.capabilities.includes(capability)
      ),
      alternativesConsidered: alternatives,
      confidence: 0.5,
      requiresUserApproval: operator.kind !== "human",
    };
    const validation = validateOperatorSelectionProposal({
      selection,
      goalId: request.goalId,
      workflowRunId: request.workflowRunId,
      stepRunId: request.stepRunId,
      stepTemplateId: payload.stepName,
      readyOperators,
      guardrails,
    });
    if (!validation.valid) continue;

    validChoices.push({
      id: operator.id.slice(0, 100),
      label: operator.id.slice(0, 120),
      description: `${operator.kind} operator (${operator.capabilities.join(", ") || "no capabilities"})`.slice(
        0,
        512
      ),
      proposal: {
        orcaProposalVersion: 1,
        kind: "select_operator",
        payload: validation.selection,
      },
    });
  }

  if (validChoices.length > 0) return validChoices.slice(0, 20);
  return [
    {
      id: "human",
      label: "human",
      description: "Continue with explicit human supervision.",
      proposal: {
        orcaProposalVersion: 1,
        kind: "select_operator",
        payload: {
          operatorId: "human",
          operatorKind: "human",
          reason: "Human review fallback",
          requiredCapabilities: [],
          alternativesConsidered: [],
          confidence: 0.5,
          requiresUserApproval: false,
        },
      },
    },
  ];
}

export function createHumanReviewRequest(
  deps: CreateHumanReviewRequestDeps,
  input: CreateHumanReviewRequestInput
): HumanReviewPayload {
  const now = nowIso(deps.now);
  const idFactory = deps.idFactory ?? randomUUID;
  const attempt = deps.db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_run_id, provider_id, model, transport FROM orchestration_transport_attempts WHERE id = ?"
    )
    .get(input.attemptId) as
    | {
        id: string;
        goal_id: string;
        workflow_run_id: string;
        step_run_id: string | null;
        provider_id: ModelProviderId;
        model: string;
        transport: string;
      }
    | undefined;

  if (!attempt || attempt.transport !== "human_review") {
    throw new Error(`human review attempt not found: ${input.attemptId}`);
  }

  const guardrails = loadGuardrails(deps.db, input.request.workflowRunId);
  const parsedPayload =
    input.request.kind === "select_operator"
      ? tryParseSelectOperatorPayload(input.request.payload)
      : null;
  const choices =
    input.request.kind === "select_operator" && parsedPayload
      ? createOperatorChoices(parsedPayload, guardrails, input.request)
      : [
          {
            id: "human",
            label: "human",
            description: "Continue with explicit human supervision.",
            proposal: {
              orcaProposalVersion: 1,
              kind: input.request.kind,
              payload: {},
            },
          },
        ];

  const payload = HumanReviewPayload.parse({
    id: idFactory(),
    goalId: input.request.goalId,
    workflowRunId: input.request.workflowRunId,
    stepRunId: input.request.stepRunId,
    attemptId: input.attemptId,
    kind: input.request.kind,
    providerId: attempt.provider_id,
    modelId: attempt.model,
    title: reviewTitle(input.request.kind),
    summary: summaryForReview({
      stepPurpose: parsedPayload?.stepPurpose ?? "not provided",
      guardrailsSummary: describeGuardrails(guardrails),
      failedTraceSummary: loadFailedTrace(deps.db, input.request, input.attemptId),
    }),
    choices,
    createdAt: now,
  });

  deps.db
    .prepare(
      "INSERT INTO orchestration_human_reviews (id, goal_id, workflow_run_id, step_run_id, attempt_id, decision_kind, payload_json, status, submitted_proposal_json, created_at, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)"
    )
    .run(
      payload.id,
      payload.goalId,
      payload.workflowRunId,
      payload.stepRunId,
      payload.attemptId,
      payload.kind,
      JSON.stringify(payload),
      payload.createdAt
    );

  return payload;
}

function requireAttempt(
  db: Database.Database,
  goalId: string,
  workflowRunId: string,
  attemptId: string
): AttemptRow {
  const row = db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, status, failure_reason, failure_message FROM orchestration_transport_attempts WHERE id = ?"
    )
    .get(attemptId) as AttemptRow | undefined;
  if (
    !row ||
    row.goal_id !== goalId ||
    row.workflow_run_id !== workflowRunId ||
    row.transport !== "human_review"
  ) {
    throw new HumanReviewNotFoundError(goalId, workflowRunId, attemptId);
  }
  return row;
}

function requireHumanReview(
  db: Database.Database,
  goalId: string,
  workflowRunId: string,
  attemptId: string
): HumanReviewRow {
  const row = db
    .prepare(
      "SELECT id, goal_id, workflow_run_id, step_run_id, attempt_id, decision_kind, payload_json, status FROM orchestration_human_reviews WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(attemptId) as HumanReviewRow | undefined;
  if (!row || row.goal_id !== goalId || row.workflow_run_id !== workflowRunId) {
    throw new HumanReviewNotFoundError(goalId, workflowRunId, attemptId);
  }
  return row;
}

function toFallbackDescriptors(payload: HumanReviewPayload): OperatorDescriptor[] {
  return payload.choices
    .map((choice) => {
      const parsed = OperatorSelection.safeParse(choice.proposal.payload);
      if (!parsed.success) return null;
      return {
        id: parsed.data.operatorId,
        kind: parsed.data.operatorKind,
        displayName: parsed.data.operatorId,
        capabilities: parsed.data.requiredCapabilities,
        ready: true,
        supportsRepoEditing: parsed.data.operatorKind !== "model",
        supportsTerminal: parsed.data.operatorKind !== "model",
      } as OperatorDescriptor;
    })
    .filter((value): value is OperatorDescriptor => value !== null);
}

export async function submitHumanReviewDecision(
  deps: SubmitHumanReviewDecisionDeps,
  input: SubmitHumanReviewDecisionInput
): Promise<SubmitHumanReviewDecisionResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const idFactory = deps.idFactory ?? randomUUID;
  const run = getWorkflowRunById(deps.db, input.workflowRunId);
  if (!run || run.goalId !== input.goalId) {
    throw new HumanReviewNotFoundError(input.goalId, input.workflowRunId, input.attemptId);
  }

  const attempt = requireAttempt(
    deps.db,
    input.goalId,
    input.workflowRunId,
    input.attemptId
  );
  if (attempt.status !== "pending") {
    throw new HumanReviewNotPendingError(input.attemptId);
  }

  const reviewRow = requireHumanReview(
    deps.db,
    input.goalId,
    input.workflowRunId,
    input.attemptId
  );
  if (reviewRow.status !== "pending") {
    throw new HumanReviewNotPendingError(input.attemptId);
  }

  const payload = HumanReviewPayload.parse(JSON.parse(reviewRow.payload_json));
  if (input.request.proposal.kind !== payload.kind) {
    throw new HumanReviewValidationError("proposal kind does not match review kind");
  }
  if (
    input.request.choiceId &&
    !payload.choices.some((choice) => choice.id === input.request.choiceId)
  ) {
    throw new HumanReviewValidationError("choiceId was not found in human review payload");
  }
  if (payload.kind !== "select_operator") {
    throw new HumanReviewValidationError("unsupported human review kind");
  }

  const stepRun = payload.stepRunId
    ? getWorkflowStepRunById(deps.db, payload.stepRunId)
    : null;
  if (!stepRun || stepRun.goalId !== input.goalId || stepRun.workflowRunId !== input.workflowRunId) {
    throw new HumanReviewNotFoundError(input.goalId, input.workflowRunId, input.attemptId);
  }

  const template = getTemplateById(deps.db, run.templateId);
  if (!template) {
    throw new HumanReviewNotFoundError(input.goalId, input.workflowRunId, input.attemptId);
  }
  const stepTemplate = template.steps.find((step) => step.id === stepRun.stepTemplateId);
  if (!stepTemplate) {
    throw new HumanReviewNotFoundError(input.goalId, input.workflowRunId, input.attemptId);
  }

  const selection = OperatorSelection.parse(input.request.proposal.payload);
  const readyOperators = (
    deps.listOperators ? await deps.listOperators(input.goalId) : toFallbackDescriptors(payload)
  ).filter((operator) => operator.ready);
  const proposalValidation = validateOperatorSelectionProposal({
    selection,
    goalId: input.goalId,
    workflowRunId: input.workflowRunId,
    stepRunId: stepRun.id,
    stepTemplateId: stepTemplate.id,
    readyOperators,
    guardrails: template.guardrails,
  });
  if (!proposalValidation.valid) {
    throw new HumanReviewProposalRejectedError(proposalValidation.failureMessage);
  }

  const normalizedSelection = proposalValidation.selection;
  const guardCtx: GuardrailContext = {
    goalId: input.goalId,
    workflowRunId: input.workflowRunId,
    stepRunId: stepRun.id,
    stepTemplateId: stepTemplate.id,
    candidateAction: {
      kind: "launch_workflow_session",
      operatorId: normalizedSelection.operatorId,
    },
  };
  const guardResults = template.guardrails.map((guardrail) =>
    evaluateGuardrail(guardrail, guardCtx)
  );
  const requiresApproval =
    normalizedSelection.requiresUserApproval ||
    guardResults.some((result) => result.result === "require_approval");

  const stagedEvents: DomainEvent[] = [];
  const result = deps.db.transaction(() => {
    const submittedAt = now();
    deps.db
      .prepare(
        "UPDATE orchestration_human_reviews SET status = 'accepted', submitted_proposal_json = ?, submitted_at = ? WHERE id = ?"
      )
      .run(JSON.stringify(input.request.proposal), submittedAt, reviewRow.id);

    const decision = recordDecisionInTx(
      deps.db,
      now,
      {
        goalId: input.goalId,
        workflowRunId: input.workflowRunId,
        stepRunId: stepRun.id,
        decisionType: "select_operator",
        selectedAction: `select:${normalizedSelection.operatorId}`,
        reason: normalizedSelection.reason,
        influencedBy: [
          {
            kind: "workflow_step",
            id: stepTemplate.id,
            label: stepTemplate.name,
            effect: "preferred",
          },
          {
            kind: "operator_readiness",
            id: normalizedSelection.operatorId,
            label: normalizedSelection.operatorId,
            effect: "satisfied",
          },
          ...guardResults
            .filter((guardrail) => guardrail.result === "require_approval")
            .map((guardrail) => ({
              kind: "guardrail" as const,
              id: guardrail.guardrailId,
              label: guardrail.kind,
              effect: "required" as const,
            })),
        ],
        alternativesConsidered: normalizedSelection.alternativesConsidered,
        confidence: normalizedSelection.confidence,
        operatorSelection: normalizedSelection,
        inputFingerprint: decisionFingerprint({
          runId: input.workflowRunId,
          stepRunId: stepRun.id,
          decisionType: "select_operator",
          payload: {
            operatorId: normalizedSelection.operatorId,
            source: "human_review",
            reviewId: reviewRow.id,
          },
        }),
      },
      { idFactory, stagedEvents }
    );

    evaluateAllGuardrailsInTx(
      deps.db,
      now,
      template.guardrails,
      guardCtx,
      decision.decisionId,
      {
        idFactory,
        stagedEvents,
      }
    );

    stagedEvents.push(
      appendWorkflowEvent(
        deps.db,
        "workflow.operator.selected",
        {
          decisionId: decision.decisionId,
          goalId: input.goalId,
          workflowRunId: input.workflowRunId,
          stepRunId: stepRun.id,
          operatorId: normalizedSelection.operatorId,
          operatorKind: normalizedSelection.operatorKind,
          source: "fallback",
          requiresApproval,
        },
        now(),
        idFactory
      )
    );

    const recommendationId = createRecommendationForWorkflowInTx(
      deps.db,
      now,
      {
        goalId: input.goalId,
        workflowRunId: input.workflowRunId,
        stepRunId: stepRun.id,
        type: "launch_workflow_session",
        proposedAction: {
          kind: "launch_workflow_session",
          workflowStepRunId: stepRun.id,
          operatorId: normalizedSelection.operatorId,
          operatorKind: normalizedSelection.operatorKind,
          objective: stepTemplate.instructions,
        },
        rationale: normalizedSelection.reason,
        decisionId: decision.decisionId,
      },
      {
        idFactory,
        stagedEvents,
      }
    );

    deps.db
      .prepare(
        "UPDATE orchestration_transport_attempts SET status = 'succeeded', decision_id = ?, failure_reason = NULL, failure_message = NULL, finished_at = ? WHERE id = ?"
      )
      .run(decision.decisionId, submittedAt, attempt.id);

    stagedEvents.push(
      appendTransportAttemptFinishedEvent(
        deps.db,
        {
          goalId: input.goalId,
          workflowRunId: input.workflowRunId,
          stepRunId: stepRun.id,
          attemptId: attempt.id,
          providerId: attempt.provider_id,
          transport: "human_review",
        },
        "succeeded",
        submittedAt,
        undefined,
        idFactory
      )
    );

    return { decision, recommendationIds: [recommendationId] };
  })();

  publishStagedWorkflowEvents(deps.bus, stagedEvents);
  return result;
}
