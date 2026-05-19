import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveBinaryResult } from "./resolve.js";

type ResolveFn = (candidates: string[]) => Promise<ResolveBinaryResult>;

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const;
  readonly title = "opencode";

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const candidates = openCodeCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      throw Object.assign(
        new Error(`opencode binary not found. Set ORCA_OPENCODE_BIN or install opencode. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" }
      );
    }

    const env: Record<string, string> = {};
    if (process.env["PATH"]) env["PATH"] = process.env["PATH"];
    env["ORCA_GOAL_ID"] = input.goalId;
    env["ORCA_SESSION_ID"] = input.sessionId;
    if (input.role) env["ORCA_ROLE"] = input.role;
    if (input.instruction) env["ORCA_INSTRUCTION"] = input.instruction;

    return {
      command: result.resolvedPath,
      args: [],
      env,
      cwd: input.workspacePath,
    };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const candidates = openCodeCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `opencode not found. Set ORCA_OPENCODE_BIN or install opencode.`,
      };
    }
    return { status: "available" };
  }
}

function openCodeCandidates(): string[] {
  const override = process.env["ORCA_OPENCODE_BIN"];
  return override ? [override, "opencode"] : ["opencode"];
}
