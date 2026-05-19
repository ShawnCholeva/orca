import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveBinaryResult } from "./resolve.js";

type ResolveFn = (candidates: string[]) => Promise<ResolveBinaryResult>;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly title = "Claude Code";

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const candidates = claudeCodeCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      throw Object.assign(
        new Error(`claude binary not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code. Tried: ${result.tried.join(", ")}`),
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
    const candidates = claudeCodeCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `claude not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code.`,
      };
    }
    return { status: "available" };
  }
}

function claudeCodeCandidates(): string[] {
  const override = process.env["ORCA_CLAUDE_CODE_BIN"];
  return override ? [override, "claude"] : ["claude"];
}
