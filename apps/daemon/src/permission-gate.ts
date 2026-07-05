import type Database from "better-sqlite3";
import type { EventBus } from "./events.js";
import { classifyToolAction } from "./harness-risk/classify.js";
import { decideGate } from "./harness-risk/gate-decision.js";
import { emitToolGate } from "./harness-transitions/emit.js";
import type { GateDecision, OperatingMode } from "@orca/contracts";

export interface PermissionGateCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
}

// The "Auto-run" worker toggle must actually auto-approve, so worker_permission_mode
// === "auto" upgrades the effective mode to "automated". "ask" (which is also the
// column default) does NOT downgrade — it defers to operating_mode, so an
// operating_mode="automated" goal still auto-runs. The hard-constraint/critical
// floor in decideGate applies regardless.
export function effectiveOperatingMode(
  operatingMode: string,
  workerPermissionMode: string | null | undefined
): OperatingMode {
  if (workerPermissionMode === "auto") return "automated";
  return operatingMode as OperatingMode;
}

// Pure-ish decision: classify, read the goal's mode, decide, and record a tool_gate
// transition carrying the RiskFacet. Returns the gate decision; the caller maps
// "allow"/"deny" to an immediate hook response and "require_approval" to the
// existing record-and-wait flow. Fail-closed: unknown session/goal → "deny".
export function resolvePermissionDecision(
  ctx: PermissionGateCtx,
  sessionId: string,
  payload: { toolName: string; toolInput: unknown; toolUseId: string }
): GateDecision {
  const sessionRow = ctx.db
    .prepare(
      `SELECT s.goal_id AS goal_id, s.workflow_step_run_id AS step_run_id, sr.workflow_run_id AS run_id
       FROM sessions s LEFT JOIN workflow_step_runs sr ON sr.id = s.workflow_step_run_id
       WHERE s.id = ?`
    )
    .get(sessionId) as { goal_id: string; step_run_id: string | null; run_id: string | null } | undefined;
  if (!sessionRow) return "deny";
  const goalRow = ctx.db
    .prepare("SELECT operating_mode, worker_permission_mode FROM goals WHERE id = ?")
    .get(sessionRow.goal_id) as { operating_mode: string; worker_permission_mode: string | null } | undefined;
  if (!goalRow) return "deny";
  // The "Auto-run / Ask-in-chat" toggle writes worker_permission_mode; when set it
  // is the source of truth for gating ('auto'→automated, 'ask'→human_review).
  // Falls back to operating_mode when unset. The hard-constraint/critical floor in
  // decideGate still applies in either mode.
  const mode = effectiveOperatingMode(goalRow.operating_mode, goalRow.worker_permission_mode);

  const classification = classifyToolAction({ toolName: payload.toolName, toolInput: payload.toolInput });
  const gateDecision = decideGate(mode, classification);

  try {
    emitToolGate(
      { db: ctx.db, bus: ctx.bus, now: ctx.now, idFactory: ctx.idFactory },
      {
        goalId: sessionRow.goal_id,
        // Thread the worker session's run/step ids so the tool_gate transition
        // joins into per-template metrics (safetyCompliance) and is visible to
        // the 5.4 refute risk-gate (stepToolRiskClass queries by step_run_id).
        workflowRunId: sessionRow.run_id ?? null,
        workflowStepRunId: sessionRow.step_run_id ?? null,
        risk: {
          risk_class: classification.riskClass,
          permission_tier: classification.permissionTier,
          classification_reasons: classification.reasons,
          gate_decision: gateDecision,
          hard_constraint_violations: classification.hardConstraintViolations,
          mode,
        },
      }
    );
  } catch (err) {
    console.error("emitToolGate (tool_gate) failed", err);
  }
  return gateDecision;
}
