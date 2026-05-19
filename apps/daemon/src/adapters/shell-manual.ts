import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveBinaryResult } from "./resolve.js";

type ResolveFn = (candidates: string[]) => Promise<ResolveBinaryResult>;

export class ShellManualAdapter implements AgentAdapter {
  readonly id = "shell-manual" as const;
  readonly title = "Shell (Manual)";

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const candidates = shellCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      throw Object.assign(
        new Error(`No shell binary found. Tried: ${result.tried.join(", ")}`),
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
    const candidates = shellCandidates();
    const result = await this.resolveFn(candidates);
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `No shell found. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }
}

function shellCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    if (process.env["ORCA_SHELL"]) candidates.push(process.env["ORCA_SHELL"]);
    if (process.env["COMSPEC"]) candidates.push(process.env["COMSPEC"]);
    candidates.push("cmd.exe");
  } else {
    if (process.env["ORCA_SHELL"]) candidates.push(process.env["ORCA_SHELL"]);
    if (process.env["SHELL"]) candidates.push(process.env["SHELL"]);
    candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  }
  return candidates.filter(Boolean);
}
