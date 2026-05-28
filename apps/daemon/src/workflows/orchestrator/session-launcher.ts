export interface WorkflowLaunchContext {
  goalId: string;
  workflowRunId: string;
  workflowStepRunId: string;
  operatorId: string;
  operatorKind: "agent";
  objective: string;
}

export interface WorkflowSessionLauncher {
  launch(ctx: WorkflowLaunchContext): Promise<{ sessionId: string }>;
}

export type LaunchOutcome = "recommendation" | "direct";

export function recommendationOrDirectLaunch(args: {
  requiresApproval: boolean;
  launcher: WorkflowSessionLauncher;
  ctx: WorkflowLaunchContext;
}): LaunchOutcome {
  if (args.requiresApproval) return "recommendation";
  void args.launcher.launch(args.ctx);
  return "direct";
}
