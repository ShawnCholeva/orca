// step-input.ts
import type { InterviewTurn, WorkflowArtifact, WorkflowStepTemplate } from "@orca/contracts";
import type { WorkspaceContextOutput } from "./workspace-context.js";

export interface StepExecutionInput {
  goal: { id: string; description: string };
  currentStep: Pick<WorkflowStepTemplate, "id" | "ordinal" | "name" | "instructions" | "outputSchema">;
  previousStepOutput: unknown | null;
  priorStepOutputs: Array<{ stepId: string; stepName: string; output: unknown }>;
  transcript: InterviewTurn[];
  workspaceContext?: WorkspaceContextOutput;
}

function parseOutput(body: string): unknown {
  try { return JSON.parse(body); } catch { return null; }
}

export function buildStepExecutionInput(args: {
  goal: { id: string; description: string };
  steps: WorkflowStepTemplate[];
  currentStep: WorkflowStepTemplate;
  artifacts: WorkflowArtifact[];
  transcript: InterviewTurn[];
  stepRunByStepId: Record<string, string>; // stepTemplateId -> stepRunId
  workspaceContext?: WorkspaceContextOutput;
  // Composition (I2/Task 8 deferral): delegate `writes` materialized on a surrogate
  // delegate step-run are NOT template steps, so the `steps` loop above never surfaces
  // them. Thread them here so the parent's next step sees delegate outputs on the
  // skill/model path too (the AGENT prior-output path already reads the surrogate).
  delegatePriorOutputs?: Array<{ stepId: string; stepName: string; output: unknown }>;
}): StepExecutionInput {
  const { goal, steps, currentStep, artifacts, transcript, stepRunByStepId, workspaceContext, delegatePriorOutputs } = args;
  const outputByStepRunId = new Map<string, unknown>();
  for (const a of artifacts) {
    if (a.type === "step_output" && a.stepRunId) outputByStepRunId.set(a.stepRunId, parseOutput(a.body));
  }
  const priorStepOutputs: StepExecutionInput["priorStepOutputs"] = [];
  for (const s of steps) {
    if (s.ordinal >= currentStep.ordinal) continue;
    const sr = stepRunByStepId[s.id];
    if (sr && outputByStepRunId.has(sr)) {
      priorStepOutputs.push({ stepId: s.id, stepName: s.name, output: outputByStepRunId.get(sr) ?? null });
    }
  }
  for (const d of delegatePriorOutputs ?? []) priorStepOutputs.push(d);
  const previousStepOutput =
    priorStepOutputs.length > 0 ? priorStepOutputs[priorStepOutputs.length - 1].output : null;
  return {
    goal,
    currentStep: { id: currentStep.id, ordinal: currentStep.ordinal, name: currentStep.name, instructions: currentStep.instructions, outputSchema: currentStep.outputSchema },
    previousStepOutput,
    priorStepOutputs,
    transcript,
    ...(workspaceContext !== undefined ? { workspaceContext } : {}),
  };
}
