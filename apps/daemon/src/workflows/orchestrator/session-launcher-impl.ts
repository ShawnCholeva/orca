import type {
  WorkflowLaunchContext,
  WorkflowSessionLauncher,
} from "./session-launcher.js";

export interface ProductionLauncherDeps {
  createSession: (input: {
    goalId: string;
    workspaceId: string;
    adapterId: string;
    workflowStepRunId: string;
    instruction: string;
    role?: string;
    title?: string;
  }) => Promise<{ id: string }>;
  firstWorkspaceId: (goalId: string) => string | null;
}

function adapterIdFrom(operatorId: string): string {
  return operatorId.startsWith("agent:") ? operatorId.slice("agent:".length) : operatorId;
}

export class ProductionWorkflowSessionLauncher implements WorkflowSessionLauncher {
  constructor(private readonly deps: ProductionLauncherDeps) {}

  async launch(ctx: WorkflowLaunchContext): Promise<{ sessionId: string }> {
    const workspaceId = this.deps.firstWorkspaceId(ctx.goalId);
    if (!workspaceId) throw new Error("direct_launch_unsupported: no workspace attached to goal");
    const created = await this.deps.createSession({
      goalId: ctx.goalId,
      workspaceId,
      adapterId: adapterIdFrom(ctx.operatorId),
      workflowStepRunId: ctx.workflowStepRunId,
      instruction: ctx.objective,
      role: "engineer",
      title: `Workflow step: ${ctx.workflowStepRunId}`,
    });
    return { sessionId: created.id };
  }
}
