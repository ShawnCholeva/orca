import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability, AdapterContextDelivery } from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveFn } from "./resolve.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly title = "Claude Code";
  // preview_only: no verified safe CLI surface for context-file delivery yet.
  readonly contextDelivery: AdapterContextDelivery = { mode: 'preview_only', maxBytes: 32768 };

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(claudeCodeCandidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`claude not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" }
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(claudeCodeCandidates());
    if ("error" in result) {
      return { status: "unavailable", detail: `claude not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code. Tried: ${result.tried.join(", ")}` };
    }
    return { status: "available" };
  }
}

function claudeCodeCandidates(): string[] {
  const override = process.env["ORCA_CLAUDE_CODE_BIN"];
  return override ? [override] : ["claude"];
}
