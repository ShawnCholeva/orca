import type Database from "better-sqlite3";
import {
  buildOrchestratorContext,
  type OrchestratorInvocationContext,
  type OrchestratorContextInput,
} from "./context.js";

const RECENT_CHAT_LIMIT = 40;

// A minimal valid WorkflowStepOutputSchema entry (the Zod schema requires .min(1))
// used for the freeform (no active run) path where no real step schema exists.
const FREEFORM_OUTPUT_SCHEMA: OrchestratorContextInput["currentStep"]["outputSchema"] = [
  { key: "response", type: "string", required: true, description: "Orchestrator response" },
];

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

  // Freeform-chat path (no active run). Active-run enrichment (currentStep,
  // agent turns, prior artifacts) is wired in a later task.
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
