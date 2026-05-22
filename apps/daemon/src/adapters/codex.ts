import type { AgentAdapter, AdapterSpawnInput, AdapterSpawnResult, AdapterAvailability, AdapterContextDelivery } from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary } from "./resolve.js";
import type { ResolveFn } from "./resolve.js";

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly title = "Codex";
  // preview_only: no verified safe CLI surface for context-file delivery yet.
  readonly contextDelivery: AdapterContextDelivery = { mode: 'preview_only', maxBytes: 32768 };

  private readonly resolveFn: ResolveFn;

  constructor(resolveFn: ResolveFn = resolveBinary) {
    this.resolveFn = resolveFn;
  }

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(codexCandidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`codex not found. Set ORCA_CODEX_BIN or install Codex. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" }
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(codexCandidates());
    if ("error" in result) {
      return { status: "unavailable", detail: `codex not found. Set ORCA_CODEX_BIN or install Codex. Tried: ${result.tried.join(", ")}` };
    }
    return { status: "available" };
  }
}

function codexCandidates(): string[] {
  const override = process.env["ORCA_CODEX_BIN"];
  return override ? [override] : ["codex"];
}
