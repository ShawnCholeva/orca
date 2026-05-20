import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability, AdapterContextDelivery } from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveFn } from "./resolve.js";

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const;
  readonly title = "opencode";
  // preview_only: no verified safe CLI surface for context-file delivery in M6
  readonly contextDelivery: AdapterContextDelivery = { mode: 'preview_only', maxBytes: 32768 };

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(openCodeCandidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`opencode not found. Set ORCA_OPENCODE_BIN or install opencode. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" }
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(openCodeCandidates());
    if ("error" in result) {
      return { status: "unavailable", detail: `opencode not found. Set ORCA_OPENCODE_BIN or install opencode. Tried: ${result.tried.join(", ")}` };
    }
    return { status: "available" };
  }
}

function openCodeCandidates(): string[] {
  const override = process.env["ORCA_OPENCODE_BIN"];
  return override ? [override] : ["opencode"];
}
