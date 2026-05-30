import type { AdapterId, AgentReadinessStatus, CheckStep, RepairAction, ExecutionMode } from "@orca/contracts";
import { inheritCredEnv } from "../readiness/exec.js";

// Non-secret host vars an interactive agent (and its shell hooks) needs to
// behave like a real terminal: locale, TERM, and shell/user identity. HOME and
// the XDG/config dirs come from inheritCredEnv (the same curation the readiness
// auth checks use), so `~/.claude` auth, plugins, and MCP config resolve.
const INTERACTIVE_ENV_PASSTHROUGH = [
  "TERM", "COLORTERM", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ",
  "USER", "LOGNAME", "SHELL",
] as const;

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
  supportsRepoEditing?: boolean;
  supportsTerminal?: boolean;
  /**
   * Execution modes this adapter can technically dispatch. Code-declared invariant.
   * The runtime DB-backed AdapterExecutionModeConfig must declare a subset of these.
   */
  supportedExecutionModes: ExecutionMode[];
  /** Return true if this adapter can drive the given model id. */
  supportsModel(modelId: string): boolean;
  contextDelivery: AdapterContextDelivery;
  resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult>;
  probeAvailability(): Promise<AdapterAvailability>;

  checkInstalled(): Promise<CheckStep & { version?: string }>;
  checkAuth(): Promise<CheckStep>;
  repairFor(status: AgentReadinessStatus): RepairAction | undefined;
}

/**
 * Build the spawn env for a session: cred dirs (HOME/XDG) + PATH + a curated
 * interactive-terminal passthrough + ORCA_* session vars. The child pty runs
 * with exactly this env (full replace), so anything omitted is simply absent —
 * which is why HOME must be included or `~/.claude` auth/hooks/MCP break. We
 * allowlist rather than copy process.env wholesale to avoid leaking daemon
 * secrets (API keys, tokens) into the agent.
 */
export function buildSpawnEnv(input: AdapterSpawnInput): Record<string, string> {
  const env: Record<string, string> = { ...inheritCredEnv() };
  if (process.env["PATH"]) env["PATH"] = process.env["PATH"];
  for (const k of INTERACTIVE_ENV_PASSTHROUGH) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  env["ORCA_GOAL_ID"] = input.goalId;
  env["ORCA_SESSION_ID"] = input.sessionId;
  if (input.role) env["ORCA_ROLE"] = input.role;
  if (input.instruction) env["ORCA_INSTRUCTION"] = input.instruction;
  return env;
}
