import type { AdapterId } from "@orca/contracts";

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
  resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult>;
  probeAvailability(): Promise<AdapterAvailability>;
}
