import type { AdapterId, AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export interface AdapterContextDelivery {
  mode: 'initial_input' | 'context_file' | 'preview_only';
  contextFileEnvVar?: string;
  contextFileArgFlag?: string;
  maxBytes: number;
}

export interface AdapterSpawnInput {
  goalId: string;
  sessionId: string;
  workspacePath: string;
  role?: string;
  instruction?: string;
}

export interface AdapterSpawnResult {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type AdapterAvailability =
  | { status: "available"; detail?: string }
  | { status: "unavailable"; detail: string }
  | { status: "unknown" };

export interface AgentAdapter {
  id: AdapterId;
  title: string;
  contextDelivery: AdapterContextDelivery;
  resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult>;
  probeAvailability(): Promise<AdapterAvailability>;

  checkInstalled(): Promise<CheckStep & { version?: string }>;
  checkAuth(): Promise<CheckStep>;
  repairFor(status: AgentReadinessStatus): RepairAction | undefined;
}

/** Build the spawn env from a session input: PATH pass-through + ORCA_* session vars. */
export function buildSpawnEnv(input: AdapterSpawnInput): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env["PATH"]) env["PATH"] = process.env["PATH"];
  env["ORCA_GOAL_ID"] = input.goalId;
  env["ORCA_SESSION_ID"] = input.sessionId;
  if (input.role) env["ORCA_ROLE"] = input.role;
  if (input.instruction) env["ORCA_INSTRUCTION"] = input.instruction;
  return env;
}
