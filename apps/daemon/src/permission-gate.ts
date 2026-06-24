import type Database from "better-sqlite3";
import type { EventBus } from "./events.js";
import { classifyToolAction } from "./harness-risk/classify.js";
import { decideGate } from "./harness-risk/gate-decision.js";
import { recordHarnessTransition } from "./harness-transitions/usecases.js";
import type { GateDecision, OperatingMode } from "@orca/contracts";

export interface PermissionGateCtx {
  db: Database.Database;
  bus: EventBus;
  now?: () => string;
  idFactory?: () => string;
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
  const sessionRow = ctx.db.prepare("SELECT goal_id FROM sessions WHERE id = ?").get(sessionId) as { goal_id: string } | undefined;
  if (!sessionRow) return "deny";
  const goalRow = ctx.db.prepare("SELECT operating_mode FROM goals WHERE id = ?").get(sessionRow.goal_id) as { operating_mode: string } | undefined;
  if (!goalRow) return "deny";
  const mode = goalRow.operating_mode as OperatingMode;

  const classification = classifyToolAction({ toolName: payload.toolName, toolInput: payload.toolInput });
  const gateDecision = decideGate(mode, classification);

  try {
    recordHarnessTransition(
      { db: ctx.db, bus: ctx.bus, now: ctx.now, idFactory: ctx.idFactory },
      {
        goalId: sessionRow.goal_id,
        boundary: "tool_gate",
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
    console.error("recordHarnessTransition (tool_gate) failed", err);
  }
  return gateDecision;
}
