import type { TmuxRunner } from "../../tmux/runner.js";

export type ShadowAdapterId = "claude-code" | "codex" | "antigravity";

export interface ShadowLaunch {
  /** Executable invoked by `tmux new-session` for this provider. */
  bin: string;
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
  }): { files: { relPath: string; contents: string }[]; spawnArgs: string[]; env?: Record<string, string> };
  captureMode(): ShadowCaptureMode;
  turnParser(): ShadowTurnParse;
  /** Optional hook run before each prompt submission (e.g. dismiss a modal). */
  beforeSubmit?(ctx: {
    tmux: TmuxRunner;
    sessionName: string;
    dbg: (msg: string) => void;
  }): Promise<void>;
}
