import type Database from "better-sqlite3";
import {
  buildOrchestratorContext,
  type OrchestratorInvocationContext,
  type OrchestratorContextInput,
} from "./context.js";
import { type WorkflowArtifact, type WorkflowStepTemplate, type WorkflowRunStatus } from "@orca/contracts";
import { reconstructTranscript } from "../workflows/orchestrator/interview.js";

const RECENT_CHAT_LIMIT = 40;

// A minimal valid WorkflowStepOutputSchema entry (the Zod schema requires .min(1))
// used for the freeform (no active run) path where no real step schema exists.
const FREEFORM_OUTPUT_SCHEMA: OrchestratorContextInput["currentStep"]["outputSchema"] = [
  { key: "response", type: "string", required: true, description: "Orchestrator response" },
];

function loadWorkspaces(
  db: Database.Database,
  goalId: string
): OrchestratorContextInput["goal"]["attachedWorkspaces"] {
  const rows = db
    .prepare("SELECT id, name, path FROM workspaces WHERE goal_id = ? ORDER BY attached_at ASC")
    .all(goalId) as Array<{ id: string; name: string; path: string }>;
  return rows.map((r) => ({ id: r.id, name: r.name, root: r.path }));
}

function loadPriorArtifacts(
  db: Database.Database,
  runId: string,
  currentStepRunId: string
): OrchestratorContextInput["priorStepArtifacts"] {
  const stepRuns = db
    .prepare("SELECT id, step_template_id FROM workflow_step_runs WHERE workflow_run_id = ?")
    .all(runId) as Array<{ id: string; step_template_id: string }>;
  const byId = new Map(stepRuns.map((s) => [s.id, s]));

  // Artifacts ordered ASC by created_at; the last seen per template is the most recent.
  const artifacts = db
    .prepare(
      "SELECT step_run_id, body FROM workflow_artifacts WHERE workflow_run_id = ? AND type = 'step_output' AND step_run_id IS NOT NULL ORDER BY created_at ASC"
    )
    .all(runId) as Array<{ step_run_id: string; body: string }>;

  const latestByTemplate = new Map<string, unknown>();
  for (const artifact of artifacts) {
    if (artifact.step_run_id === currentStepRunId) continue;
    const owner = byId.get(artifact.step_run_id);
    if (!owner) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(artifact.body);
    } catch {
      parsed = artifact.body;
    }
    latestByTemplate.set(owner.step_template_id, parsed);
  }

  return [...latestByTemplate].map(([stepId, outputJson]) => ({ stepId, outputJson }));
}

function loadCurrentStepAgentTurns(
  db: Database.Database,
  runId: string,
  stepRunId: string
): OrchestratorContextInput["currentStepAgentTurns"] {
  const rows = db
    .prepare(
      "SELECT type, body FROM workflow_artifacts WHERE workflow_run_id = ? AND step_run_id = ? AND type = 'interview_turn' ORDER BY created_at ASC"
    )
    .all(runId, stepRunId) as WorkflowArtifact[];

  const turns = reconstructTranscript(rows);
  const result: OrchestratorContextInput["currentStepAgentTurns"] = [];
  for (const turn of turns) {
    result.push({ role: "agent", body: turn.question, ts: turn.answeredAt });
    result.push({ role: "user_via_orchestrator", body: turn.answer, ts: turn.answeredAt });
  }
  return result;
}

function loadActiveStep(
  db: Database.Database,
  runId: string,
  stepRunId: string
): {
  stepTpl: WorkflowStepTemplate;
  templateVersion: number;
  ordinal: number;
  templateId: string;
  status: WorkflowRunStatus;
  selectedOperatorId: string | null;
} | null {
  const run = db
    .prepare("SELECT id, template_id, status FROM workflow_runs WHERE id = ?")
    .get(runId) as { id: string; template_id: string; status: string } | undefined;
  if (!run) return null;

  const tplRow = db
    .prepare("SELECT steps_json, version FROM workflow_templates WHERE id = ?")
    .get(run.template_id) as { steps_json: string; version: number } | undefined;
  if (!tplRow) return null;

  let steps: WorkflowStepTemplate[];
  try {
    steps = JSON.parse(tplRow.steps_json) as WorkflowStepTemplate[];
  } catch {
    return null;
  }

  const stepRun = db
    .prepare("SELECT step_template_id, ordinal, selected_operator_id FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { step_template_id: string; ordinal: number; selected_operator_id: string | null } | undefined;
  if (!stepRun) return null;

  const stepTpl = steps.find((s) => s.id === stepRun.step_template_id);
  if (!stepTpl) return null;

  return { stepTpl, templateVersion: tplRow.version, ordinal: stepRun.ordinal, templateId: run.template_id, status: run.status as WorkflowRunStatus, selectedOperatorId: stepRun.selected_operator_id };
}

export function buildContextFromDb(
  db: Database.Database,
  args: { goalId: string; runId: string | null; stepRunId: string | null; payloadBudgetBytes: number }
): OrchestratorInvocationContext {
  const goal = db
    .prepare("SELECT id, title, description FROM goals WHERE id = ?")
    .get(args.goalId) as { id: string; title: string; description: string } | undefined;
  if (!goal) throw new Error(`goal not found: ${args.goalId}`);

  const chatRows = db
    .prepare(
      `SELECT role, body, created_at FROM orchestrator_messages
        WHERE goal_id = ? AND kind = 'message'
        ORDER BY created_at DESC LIMIT ?`
    )
    .all(args.goalId, RECENT_CHAT_LIMIT) as Array<{ role: string; body: string; created_at: string }>;

  const chatMessages: OrchestratorContextInput["chatMessages"] = chatRows
    .reverse()
    .map((r) => ({
      role: (r.role === "user"
        ? "user"
        : r.role === "agent_paraphrased"
        ? "agent_paraphrased"
        : "orchestrator") as "user" | "orchestrator" | "agent_paraphrased",
      body: r.body,
      ts: r.created_at,
    }));

  // Active-run enrichment path: populate real step context from the DB.
  if (args.runId && args.stepRunId) {
    const activeStep = loadActiveStep(db, args.runId, args.stepRunId);
    if (activeStep) {
      const { stepTpl, templateVersion, ordinal, templateId, status, selectedOperatorId } = activeStep;
      const attachedWorkspaces = loadWorkspaces(db, args.goalId);
      const priorStepArtifacts = loadPriorArtifacts(db, args.runId, args.stepRunId);
      const currentStepAgentTurns = loadCurrentStepAgentTurns(db, args.runId, args.stepRunId);

      const agentAdapterId =
        typeof selectedOperatorId === "string" && selectedOperatorId.startsWith("agent:")
          ? selectedOperatorId.slice("agent:".length)
          : "claude-code";

      const input: OrchestratorContextInput = {
        goal: { id: goal.id, title: goal.title, description: goal.description, attachedWorkspaces },
        run: { templateId, templateVersion, ordinal, status },
        currentStep: {
          id: stepTpl.id,
          instructions: stepTpl.instructions,
          outputSchema: stepTpl.outputSchema,
          completionPolicy: stepTpl.completionPolicy,
          agentAdapterId,
          executionMode: "shadow_session",
        },
        chatMessages,
        currentStepAgentTurns,
        priorStepArtifacts,
        payloadBudgetBytes: args.payloadBudgetBytes,
      };
      return buildOrchestratorContext(input);
    }
    // Guard: if any lookup failed, fall through to the freeform placeholder.
  }

  // Freeform-chat path (no active run or run/template/step row missing).
  const input: OrchestratorContextInput = {
    goal: { id: goal.id, title: goal.title, description: goal.description, attachedWorkspaces: [] },
    run: { templateId: "", templateVersion: 0, ordinal: 0, status: "active" },
    currentStep: {
      id: "",
      instructions: "",
      outputSchema: FREEFORM_OUTPUT_SCHEMA,
      agentAdapterId: "claude-code",
      executionMode: "shadow_session",
    },
    chatMessages,
    currentStepAgentTurns: [],
    priorStepArtifacts: [],
    payloadBudgetBytes: args.payloadBudgetBytes,
  };
  return buildOrchestratorContext(input);
}
