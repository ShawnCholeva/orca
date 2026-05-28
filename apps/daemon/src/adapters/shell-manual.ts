import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability, AdapterContextDelivery } from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveFn } from "./resolve.js";
import type { AgentReadinessStatus, CheckStep, RepairAction, ExecutionMode } from "@orca/contracts";

export class ShellManualAdapter implements AgentAdapter {
  readonly id = "shell-manual" as const;
  readonly title = "Shell (Manual)";
  readonly supportedExecutionModes: ExecutionMode[] = ["shadow_session"];
  readonly contextDelivery: AdapterContextDelivery = { mode: 'initial_input', maxBytes: 32768 };

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(shellCandidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`No shell binary found. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" }
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(shellCandidates());
    if ("error" in result) {
      return { status: "unavailable", detail: `No shell found. Tried: ${result.tried.join(", ")}` };
    }
    return { status: "available" };
  }

  async checkInstalled() {
    const result = await this.resolveFn(shellCandidates());
    if ("error" in result) {
      return {
        name: "installed" as const,
        ok: false,
        command: "shell",
        detail: `No shell binary found. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { name: "installed" as const, ok: true, command: "shell", detail: result.resolvedPath };
  }
  async checkAuth(): Promise<CheckStep> {
    const result = await this.resolveFn(shellCandidates());
    if ("error" in result) {
      return {
        name: "authenticated" as const,
        ok: false,
        authStatus: "misconfigured" as const,
        command: "shell",
        detail: "no shell binary",
      };
    }
    return { name: "authenticated" as const, ok: true, authStatus: "ready" as const, command: "shell" };
  }
  repairFor(_status: AgentReadinessStatus): RepairAction | undefined {
    return undefined;
  }
}

function shellCandidates(): string[] {
  const base: Array<string | undefined> = process.platform === "win32"
    ? [process.env["COMSPEC"], "cmd.exe"]
    : [process.env["SHELL"], "/bin/zsh", "/bin/bash", "/bin/sh"];
  return [process.env["ORCA_SHELL"], ...base].filter((s): s is string => s != null && s.length > 0);
}
