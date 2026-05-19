import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveBinaryResult } from "./resolve.js";

type ResolveFn = (candidates: string[]) => Promise<ResolveBinaryResult>;

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly title = "Codex";

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const candidates = codexCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      throw Object.assign(
        new Error(`codex binary not found. Set ORCA_CODEX_BIN or install Codex. Tried: ${result.tried.join(", ")}`),
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
    const candidates = codexCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `codex not found. Set ORCA_CODEX_BIN or install Codex.`,
      };
    }
    return { status: "available" };
  }
}

function codexCandidates(): string[] {
  const override = process.env["ORCA_CODEX_BIN"];
  return override ? [override, "codex"] : ["codex"];
}
