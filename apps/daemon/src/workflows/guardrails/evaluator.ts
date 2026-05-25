import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type DomainEvent,
  type GuardrailEvaluationResult,
  type GuardrailKind,
  type WorkflowGuardrailConfig,
} from "@orca/contracts";
import { z } from "zod";

import type { EventBus } from "../../events.js";
import { redactSecrets } from "../../memory/normalize.js";
import { appendWorkflowEvent, publishStagedWorkflowEvents } from "../events.js";

export type GuardrailContext = {
  goalId: string;
  workflowRunId: string;
  stepRunId: string | null;
  stepTemplateId?: string;
  activeExecutionCount?: number;
  riskLabels?: string[];
  candidateAction:
    | { kind: "launch_workflow_session"; operatorId: string }
    | { kind: "advance_step" }
    | { kind: "mark_run_complete" }
    | { kind: "skip_validation" }
    | { kind: "select_operator"; operatorId: string }
    | { kind: "use_raw_terminal_output" };
};

export type GuardrailResult = {
  guardrailId: string;
  kind: GuardrailKind;
  result: GuardrailEvaluationResult;
  message?: string;
};

export type EvaluateGuardrailsOptions = {
  idFactory?: () => string;
  stagedEvents?: DomainEvent[];
};

export type EvaluateAllGuardrailsOptions = {
  idFactory?: () => string;
  bus?: EventBus;
};

function parseApprovalRequiredConfig(value: unknown): { actions: string[] } {
  const parsed = z.object({ actions: z.array(z.string()).optional() }).safeParse(value);
  return { actions: parsed.success ? parsed.data.actions ?? [] : [] };
}

function parseAllowedOperatorsConfig(value: unknown): { allowed: string[] } {
  const parsed = z.object({ allowed: z.array(z.string()).optional() }).safeParse(value);
  return { allowed: parsed.success ? parsed.data.allowed ?? [] : [] };
}

function parseValidationRuleConfig(value: unknown): {
  appliesToSteps: string[];
  required: string[];
} {
  const parsed = z
    .object({
      appliesToSteps: z.array(z.string()).optional(),
      required: z.array(z.string()).optional(),
    })
    .safeParse(value);
  return {
    appliesToSteps: parsed.success ? parsed.data.appliesToSteps ?? [] : [],
    required: parsed.success ? parsed.data.required ?? [] : [],
  };
}

function parseContextRuleConfig(value: unknown): { allowRawTerminalOutput: boolean } {
  const parsed = z.object({ allowRawTerminalOutput: z.boolean().optional() }).safeParse(value);
  return {
    allowRawTerminalOutput: parsed.success
      ? parsed.data.allowRawTerminalOutput === true
      : false,
  };
}

function parseConcurrencyRuleConfig(value: unknown): { maxConcurrentExecution?: number } {
  const parsed = z
    .object({ maxConcurrentExecution: z.number().int().nonnegative().optional() })
    .safeParse(value);
  return parsed.success ? parsed.data : {};
}

function parseRiskRuleConfig(value: unknown): { escalateOn: string[] } {
  const parsed = z.object({ escalateOn: z.array(z.string()).optional() }).safeParse(value);
  return { escalateOn: parsed.success ? parsed.data.escalateOn ?? [] : [] };
}

function sanitizeMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const sanitized = redactSecrets(message.trim()).slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeResultMessage(result: GuardrailResult): GuardrailResult {
  const message = sanitizeMessage(result.message);
  if (!message) {
    return {
      guardrailId: result.guardrailId,
      kind: result.kind,
      result: result.result,
    };
  }
  return { ...result, message };
}

function actionOperatorId(ctx: GuardrailContext): string | null {
  if (
    ctx.candidateAction.kind === "select_operator" ||
    ctx.candidateAction.kind === "launch_workflow_session"
  ) {
    return ctx.candidateAction.operatorId;
  }
  return null;
}

export function evaluateGuardrail(
  guardrail: WorkflowGuardrailConfig,
  ctx: GuardrailContext
): GuardrailResult {
  switch (guardrail.kind) {
    case "approval_required": {
      const cfg = parseApprovalRequiredConfig(guardrail.configJson);
      const needsApproval = (cfg.actions ?? []).includes(ctx.candidateAction.kind);
      return {
        guardrailId: guardrail.id,
        kind: guardrail.kind,
        result: needsApproval ? "require_approval" : "allow",
      };
    }
    case "allowed_operators": {
      const operatorId = actionOperatorId(ctx);
      if (!operatorId) {
        return { guardrailId: guardrail.id, kind: guardrail.kind, result: "allow" };
      }
      const cfg = parseAllowedOperatorsConfig(guardrail.configJson);
      const allowed = cfg.allowed ?? [];
      const isAllowed = allowed.includes(operatorId);
      return {
        guardrailId: guardrail.id,
        kind: guardrail.kind,
        result: isAllowed ? "allow" : "deny",
        message: isAllowed ? undefined : `operator ${operatorId} not allowed`,
      };
    }
    case "validation_rule": {
      const cfg = parseValidationRuleConfig(guardrail.configJson);
      const appliesToStep =
        ctx.stepTemplateId !== undefined &&
        (cfg.appliesToSteps ?? []).includes(ctx.stepTemplateId);
      if (ctx.candidateAction.kind === "skip_validation" && appliesToStep) {
        return {
          guardrailId: guardrail.id,
          kind: guardrail.kind,
          result: "require_approval",
          message: "validation skip requires explicit reason",
        };
      }
      return { guardrailId: guardrail.id, kind: guardrail.kind, result: "allow" };
    }
    case "context_rule": {
      const cfg = parseContextRuleConfig(guardrail.configJson);
      if (
        ctx.candidateAction.kind === "use_raw_terminal_output" &&
        cfg.allowRawTerminalOutput !== true
      ) {
        return {
          guardrailId: guardrail.id,
          kind: guardrail.kind,
          result: "deny",
          message: "raw terminal output not allowed",
        };
      }
      return { guardrailId: guardrail.id, kind: guardrail.kind, result: "allow" };
    }
    case "concurrency_rule": {
      const cfg = parseConcurrencyRuleConfig(guardrail.configJson);
      if (
        ctx.candidateAction.kind === "launch_workflow_session" &&
        cfg.maxConcurrentExecution !== undefined &&
        (ctx.activeExecutionCount ?? 0) >= cfg.maxConcurrentExecution
      ) {
        return {
          guardrailId: guardrail.id,
          kind: guardrail.kind,
          result: "deny",
          message: "execution concurrency limit reached",
        };
      }
      return { guardrailId: guardrail.id, kind: guardrail.kind, result: "allow" };
    }
    case "risk_rule": {
      const cfg = parseRiskRuleConfig(guardrail.configJson);
      const escalations = cfg.escalateOn ?? [];
      const matched = (ctx.riskLabels ?? []).some((label) => escalations.includes(label));
      return {
        guardrailId: guardrail.id,
        kind: guardrail.kind,
        result: matched ? "require_approval" : "allow",
        message: matched ? "risk rule requires approval" : undefined,
      };
    }
    case "cost_speed_preference":
      return {
        guardrailId: guardrail.id,
        kind: guardrail.kind,
        result: "allow",
        message: "cost/speed preference applies to operator ranking",
      };
  }
}

export function evaluateAllGuardrailsInTx(
  db: Database.Database,
  now: () => string,
  guardrails: WorkflowGuardrailConfig[],
  ctx: GuardrailContext,
  decisionId: string | null,
  options: EvaluateGuardrailsOptions = {}
): GuardrailResult[] {
  const idFactory = options.idFactory ?? randomUUID;
  const results = guardrails.map((guardrail) => evaluateGuardrail(guardrail, ctx));
  const createdAt = now();

  for (const result of results) {
    const evaluationId = idFactory();
    const message = sanitizeMessage(result.message) ?? null;
    db.prepare(
      "INSERT INTO workflow_guardrail_evaluations (id, goal_id, workflow_run_id, step_run_id, guardrail_id, guardrail_kind, decision_id, result, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      evaluationId,
      ctx.goalId,
      ctx.workflowRunId,
      ctx.stepRunId,
      result.guardrailId,
      result.kind,
      decisionId,
      result.result,
      message,
      createdAt
    );

    const event = appendWorkflowEvent(
      db,
      "workflow.guardrail.evaluated",
      {
        guardrailEvaluationId: evaluationId,
        goalId: ctx.goalId,
        workflowRunId: ctx.workflowRunId,
        stepRunId: ctx.stepRunId,
        guardrailId: result.guardrailId,
        guardrailKind: result.kind,
        result: result.result,
      },
      createdAt,
      idFactory
    );
    options.stagedEvents?.push(event);
  }

  return results.map(sanitizeResultMessage);
}

export function evaluateAllGuardrails(
  db: Database.Database,
  now: () => string,
  guardrails: WorkflowGuardrailConfig[],
  ctx: GuardrailContext,
  decisionId: string | null,
  options: EvaluateAllGuardrailsOptions = {}
): GuardrailResult[] {
  const stagedEvents: DomainEvent[] = [];
  const results = db.transaction(() =>
    evaluateAllGuardrailsInTx(db, now, guardrails, ctx, decisionId, {
      idFactory: options.idFactory,
      stagedEvents,
    })
  )();

  if (options.bus) {
    publishStagedWorkflowEvents(options.bus, stagedEvents);
  }
  return results;
}
