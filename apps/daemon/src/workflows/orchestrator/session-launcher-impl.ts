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

/**
 * Spawns the pty for an already-created session. Orchestrator-dispatched
 * sessions have no UI terminal to trigger POST /v1/sessions/:id/start, so the
 * launcher must start them itself — otherwise the session sits in 'created'
 * forever and the agent never runs.
 */
export type WorkflowSessionStarter = (
  sessionId: string,
  opts: { terminalCols: number; terminalRows: number }
) => Promise<void>;

const HEADLESS_TERMINAL_DIMS = { terminalCols: 80, terminalRows: 24 } as const;

function adapterIdFrom(operatorId: string): string {
  return operatorId.startsWith("agent:") ? operatorId.slice("agent:".length) : operatorId;
}

export class ProductionWorkflowSessionLauncher implements WorkflowSessionLauncher {
  private starter: WorkflowSessionStarter | null = null;

  constructor(private readonly deps: ProductionLauncherDeps) {}

  /**
   * Wires the pty starter. Done after construction because the session runtime
   * and output store are built later in server bootstrap than the launcher.
   */
  setStarter(starter: WorkflowSessionStarter): void {
    this.starter = starter;
  }

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
    if (this.starter) {
      await this.starter(created.id, HEADLESS_TERMINAL_DIMS);
    }
    // No starter wired: row-only mode (worker sessions start the agent externally).
    return { sessionId: created.id };
  }
}
