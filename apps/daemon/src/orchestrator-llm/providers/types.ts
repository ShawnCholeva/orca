import type { ProviderTerminalFailureCode } from "@orca/contracts";
import type { TmuxRunner } from "../../tmux/runner.js";

export type ShadowAdapterId = "claude-code" | "codex" | "antigravity";

export type HookSurface = "orchestrator" | "worker";

/**
 * A single declared assumption about a third-party CLI hook surface this
 * provider depends on. Plain data, co-located with the provider so it cannot
 * silently drift from the code that emits the hook. Checked at boot
 * (self-conformance) and surfaced on-demand (version-pin / unverified).
 */
export interface HookAssumption {
  /** Adapter this assumption belongs to. */
  provider: ShadowAdapterId;
  /** Which emitter surface produces it: hookConfig ("orchestrator") vs workerHookConfig ("worker"). */
  surface: HookSurface;
  /** Hook event name we depend on (e.g. "Stop", "PermissionRequest"); null = unknown. */
  event: string | null;
  /** relPath the hook is wired into (asserted present in emitted config); null = unknown. */
  file: string | null;
  /** Payload fields the emitted config textually references (asserted present). */
  payloadFields: string[];
  /** Spawn arg asserted present in spawnArgs (worker surface only); null = none. */
  assertSpawnArg: string | null;
  /** Documentation only: "interactive-tui-only" | "unattended" | "unknown" | … */
  firingContext: string;
  /** CLI version this surface was last human-verified against; drives version-pin. null = none pinned. */
  verifiedAgainstVersion: string | null;
  /** false = honest unknown (skipped by self-conformance, surfaced as "unverified", never green). */
  verified: boolean;
  /** Provenance note (verification source, or the open unknowns). */
  note: string;
}

export interface ProviderTerminalFailure {
  code: ProviderTerminalFailureCode;
  message: string;
  resetTimeText: string | null;
  resetAt: string | null;
  timezone: string | null;
}

export interface ShadowLaunch {
  /** Executable invoked by `tmux new-session` for this provider. */
  bin: string;
  /** Extra CLI args appended after the executable (e.g. Codex's hook-trust bypass). */
  args?: string[];
}

interface ShadowHookFile {
  /** Path relative to the goal's shadow dir, e.g. ".claude/settings.local.json". */
  relPath: string;
  /** File contents written verbatim. */
  contents: string;
}

export interface ShadowHookConfig {
  files: ShadowHookFile[];
}

/**
 * How the manager harvests a finished turn for this provider.
 * - "hook": the daemon hook endpoint calls resolvePending (Claude).
 * - "pane-poll": the manager polls capture-pane every intervalMs (Codex).
 */
export type ShadowCaptureMode =
  | { kind: "hook" }
  | { kind: "pane-poll"; intervalMs: number };

export interface ShadowTurnParse {
  /** Extract the structured action from finished turn text, or null if not present yet. */
  parseAction(turnText: string): string | null;
  /** Detect a terminal provider error (usage limit, auth lost, …) in turn text. */
  detectError?(turnText: string, detectedAt?: Date): ProviderTerminalFailure | null;
  /** Return true when turn text confirms the provider has started processing. */
  detectTurnStarted?(turnText: string): boolean;
}

export interface AgentProvider {
  readonly id: ShadowAdapterId;
  readonly displayName: string;
  /** Model-provider registry id used by the non-shadow LLM client. */
  readonly modelProviderId: string;
  /** Whether this provider can persist a per-command "always allow" permission rule. */
  readonly supportsPermissionPersistence: boolean;
  launch(deps: { binOverride?: string }): ShadowLaunch;
  hookConfig(args: { goalId: string; resolverCommand: string[] }): ShadowHookConfig;
  /**
   * Hook config for a workflow-step worker session of this provider. Returns files
   * to write under the worker's private config dir plus spawn args/env to append.
   * (Generalizes the AgentProvider seam to workers — part of the agent-provider contract.)
   */
  workerHookConfig(args: {
    goalId: string;
    sessionId: string;
    resolverCommand: string[];
    configDir: string;
    /** Daemon loopback OTLP base URL (`http://127.0.0.1:${port}/v1/otlp`); enables worker telemetry emission when present. */
    otlpBaseUrl?: string;
    /** Daemon auth token, sent as the OTLP `Authorization: Bearer` header. */
    authToken?: string;
  }): {
    files: { relPath: string; contents: string }[];
    /** Existing files to copy into the worker's config dir (e.g. provider credentials). Skipped if the source is missing. */
    copyFiles?: { relPath: string; sourcePath: string }[];
    spawnArgs: string[];
    env?: Record<string, string>;
  };
  /** Declared hook-surface assumptions for this provider (see HookAssumption). */
  hookContract(): HookAssumption[];
  captureMode(): ShadowCaptureMode;
  turnParser(): ShadowTurnParse;
  /** Native permission rule string for an "always allow" of this tool call, or null if not persistable. */
  permissionRule(toolName: string, toolInput: unknown): string | null;
  /** Persist a permission rule into the workspace's native config (best-effort). No-op if unsupported. */
  writePermissionRule(workspacePath: string, rule: string): void;
  /** Optional hook run before each prompt submission (e.g. dismiss a modal). */
  beforeSubmit?(ctx: {
    tmux: TmuxRunner;
    sessionName: string;
    dbg: (msg: string) => void;
  }): Promise<void>;
  /** Optional hook to wait for a provider session/usage limit to reset. */
  waitForLimitReset?(ctx: {
    tmux: TmuxRunner;
    sessionName: string;
    dbg: (msg: string) => void;
  }): Promise<void>;
}
