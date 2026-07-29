import path from "node:path";
import type Database from "better-sqlite3";
import type { EventBus } from "./events.js";
import { classifyToolAction } from "./harness-risk/classify.js";
import { decideGate } from "./harness-risk/gate-decision.js";
import { emitToolGate } from "./harness-transitions/emit.js";
import { loadRunTemplate } from "./workflows/runs/run-template.js";
import type { GateDecision, OperatingMode } from "@orca/contracts";

const EDIT_TOOL_PATHS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Step-scoped write policy: returns a denial reason when the step run owning this
 * session declares `workspaceWrites: "deny"` and the tool would edit a file inside
 * one of the goal's workspaces; null when it has no opinion.
 *
 * Evaluated from the PreToolUse write-gate rather than PermissionRequest, because
 * PermissionRequest only fires when Claude Code would otherwise prompt — a
 * workspace `Edit(<path>)` allow-rule silently bypasses it. Fails OPEN (null): this
 * gate only ever ADDS a denial, and the normal permission path still fails closed.
 */
export function resolveStepWriteDenial(
  db: Database.Database,
  sessionId: string,
  payload: { toolName: string; toolInput: unknown }
): string | null {
  const pathKey = EDIT_TOOL_PATHS[payload.toolName];
  if (!pathKey) return null;
  const input = payload.toolInput as Record<string, unknown> | null | undefined;
  const target = typeof input?.[pathKey] === "string" ? (input[pathKey] as string) : "";
  if (!target) return null;

  const row = db
    .prepare(
      `SELECT s.goal_id AS goal_id, sr.step_template_id AS step_id, sr.workflow_run_id AS run_id
       FROM sessions s JOIN workflow_step_runs sr ON sr.id = s.workflow_step_run_id
       WHERE s.id = ?`
    )
    .get(sessionId) as { goal_id: string; step_id: string; run_id: string } | undefined;
  if (!row) return null;

  const run = db
    .prepare("SELECT id, template_id AS templateId FROM workflow_runs WHERE id = ?")
    .get(row.run_id) as { id: string; templateId: string } | undefined;
  if (!run) return null;
  // Runs on every edit-tool call; a bad snapshot must degrade to ungoverned rather
  // than break the agent's turn. The normal permission gate still applies.
  let step;
  try {
    step = loadRunTemplate(db, run)?.steps.find((s) => s.id === row.step_id);
  } catch (err) {
    console.error("resolveStepWriteDenial: template load failed", err);
    return null;
  }
  if (step?.workspaceWrites !== "deny") return null;

  const roots = db
    .prepare(
      `SELECT w.path AS path FROM workspaces w
       JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ?`
    )
    .all(row.goal_id) as Array<{ path: string }>;
  if (!roots.some((r) => isInside(r.path, target))) return null;

  return (
    `The ${step.name} step is read-only — it may not change files in the workspace. ` +
    `Do not work around this by writing elsewhere and applying it. If the work genuinely ` +
    `requires code changes, say so in your step output so the run can advance to a step that builds.`
  );
}

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

/**
 * The blocking PreToolUse policy gate: returns a denial reason the agent will be
 * SHOWN, or null to fall through to the normal permission flow.
 *
 * Why here and not in resolvePermissionDecision: a PermissionRequest deny has no
 * reason field (`decision: { behavior }` only), so an agent sees an opaque refusal
 * and reasonably tries another route to the same end — a denied inline `node -e`
 * probe came back as a file written to disk and executed. PreToolUse's
 * `permissionDecisionReason` is shown to the model, so a denial can teach.
 *
 * Scoped to bash + the edit tools: every hard-constraint pattern in the classifier
 * is a bash pattern, so reads never pay for a blocking round-trip.
 */
export function resolveToolPolicyDenial(
  ctx: PermissionGateCtx,
  sessionId: string,
  payload: { toolName: string; toolInput: unknown }
): string | null {
  const writeDenial = resolveStepWriteDenial(ctx.db, sessionId, payload);
  if (writeDenial) {
    emitDenialTransition(ctx, sessionId, payload, [writeDenial]);
    return writeDenial;
  }
  const classification = classifyToolAction(payload);
  if (classification.hardConstraintViolations.length === 0) return null;
  emitDenialTransition(ctx, sessionId, payload, classification.hardConstraintViolations);
  return (
    `Denied by Orca's safety floor — ${classification.hardConstraintViolations.join("; ")}. ` +
    `This is a hard constraint, not an approval prompt: do not retry it in another form. ` +
    `If you believe the classification is wrong, say so in your response instead of working around it.`
  );
}

// Records the deny so a policy refusal is auditable in the harness spine. The
// PermissionRequest path never runs for a PreToolUse-denied call, so this is the
// only transition emitted for it — no double-count.
function emitDenialTransition(
  ctx: PermissionGateCtx,
  sessionId: string,
  payload: { toolName: string; toolInput: unknown },
  violations: string[]
): void {
  try {
    const row = ctx.db
      .prepare(
        `SELECT s.goal_id AS goal_id, s.workflow_step_run_id AS step_run_id, sr.workflow_run_id AS run_id
         FROM sessions s LEFT JOIN workflow_step_runs sr ON sr.id = s.workflow_step_run_id
         WHERE s.id = ?`
      )
      .get(sessionId) as { goal_id: string; step_run_id: string | null; run_id: string | null } | undefined;
    if (!row) return;
    const c = classifyToolAction(payload);
    emitToolGate(
      { db: ctx.db, bus: ctx.bus, now: ctx.now, idFactory: ctx.idFactory },
      {
        goalId: row.goal_id,
        workflowRunId: row.run_id ?? null,
        workflowStepRunId: row.step_run_id ?? null,
        risk: {
          risk_class: c.riskClass,
          permission_tier: c.permissionTier,
          classification_reasons: violations,
          gate_decision: "deny",
          hard_constraint_violations: violations,
          mode: "human_review",
        },
      }
    );
  } catch (err) {
    console.error("emitToolGate (policy deny) failed", err);
  }
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
