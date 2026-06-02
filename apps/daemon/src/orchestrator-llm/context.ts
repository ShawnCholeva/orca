import type {
  ExecutionMode,
  WorkflowRunStatus,
  WorkflowStepOutputSchema,
} from "@orca/contracts";

interface WorkspaceRef {
  id: string;
  name: string;
  root: string;
}

export interface OrchestratorContextInput {
  goal: { id: string; title: string; description: string; attachedWorkspaces: WorkspaceRef[] };
  run: { templateId: string; templateVersion: number; ordinal: number; status: WorkflowRunStatus };
  currentStep: {
    id: string;
    instructions: string;
    outputSchema: WorkflowStepOutputSchema;
    agentAdapterId: string;
    executionMode: ExecutionMode;
  };
  chatMessages: Array<{
    role: "user" | "orchestrator" | "agent_paraphrased";
    body: string;
    ts: string;
    stepRunId?: string;
  }>;
  currentStepAgentTurns: Array<{
    role: "agent" | "user_via_orchestrator";
    body: string;
    ts: string;
  }>;
  priorStepArtifacts: Array<{ stepId: string; outputJson: unknown }>;
  payloadBudgetBytes: number;
}

export interface OrchestratorInvocationContext {
  goal: OrchestratorContextInput["goal"];
  workflowRun: OrchestratorContextInput["run"];
  currentStep: OrchestratorContextInput["currentStep"];
  conversation: {
    chatMessages: OrchestratorContextInput["chatMessages"];
    currentStepAgentTurns: OrchestratorContextInput["currentStepAgentTurns"];
  };
  priorStepArtifacts: OrchestratorContextInput["priorStepArtifacts"];
}

export function buildOrchestratorContext(
  input: OrchestratorContextInput
): OrchestratorInvocationContext {
  let agentTurns = input.currentStepAgentTurns.slice();
  let priorArtifacts = input.priorStepArtifacts.slice();

  while (estimateBytes({ ...input, currentStepAgentTurns: agentTurns, priorStepArtifacts: priorArtifacts }) > input.payloadBudgetBytes && agentTurns.length > 1) {
    agentTurns = agentTurns.slice(1);
  }
  while (estimateBytes({ ...input, currentStepAgentTurns: agentTurns, priorStepArtifacts: priorArtifacts }) > input.payloadBudgetBytes && priorArtifacts.length > 1) {
    priorArtifacts = priorArtifacts.slice(1);
  }

  return {
    goal: input.goal,
    workflowRun: input.run,
    currentStep: input.currentStep,
    conversation: {
      chatMessages: input.chatMessages,
      currentStepAgentTurns: agentTurns,
    },
    priorStepArtifacts: priorArtifacts,
  };
}

function estimateBytes(input: OrchestratorContextInput): number {
  return Buffer.byteLength(JSON.stringify(input), "utf8");
}
