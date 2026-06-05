import type { TmuxRunner } from "../../tmux/runner.js";

export type ShadowAdapterId = "claude-code" | "codex" | "antigravity";

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
  detectError?(turnText: string): Error | null;
}

export interface ShadowProvider {
  readonly id: ShadowAdapterId;
  readonly displayName: string;
  /** Model-provider registry id used by the non-shadow LLM client. */
  readonly modelProviderId: string;
  /** Whether this provider can persist a per-command "always allow" permission rule. */
  readonly supportsPermissionPersistence: boolean;
  launch(deps: { binOverride?: string }): ShadowLaunch;
  hookConfig(args: { goalId: string; port: number; authToken: string }): ShadowHookConfig;
  /**
   * Hook config for a workflow-step worker session of this provider. Returns files
   * to write under the worker's private config dir plus spawn args/env to append.
   * (Generalizes the provider seam to workers; future: rename to AgentProvider.)
   */
  workerHookConfig(args: {
    goalId: string;
    sessionId: string;
    port: number;
    authToken: string;
    configDir: string;
  }): {
    files: { relPath: string; contents: string }[];
    /** Existing files to copy into the worker's config dir (e.g. provider credentials). Skipped if the source is missing. */
    copyFiles?: { relPath: string; sourcePath: string }[];
    spawnArgs: string[];
    env?: Record<string, string>;
  };
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
}
