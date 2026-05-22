export type KnownAdapterId = "claude-code" | "codex" | "gemini-cli" | "opencode";

const INSTALL_URLS: Record<KnownAdapterId, string> = {
  "claude-code": "https://docs.anthropic.com/claude/docs/claude-code",
  codex: "https://github.com/openai/codex",
  "gemini-cli": "https://github.com/google-gemini/gemini-cli",
  opencode: "https://opencode.ai",
};

const SIGN_IN_COMMANDS: Record<KnownAdapterId, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  "gemini-cli": "gemini",
  opencode: "opencode auth login",
};

export function installUrlFor(id: KnownAdapterId): string | null {
  return INSTALL_URLS[id] ?? null;
}

export function signInCommandFor(id: KnownAdapterId): string | null {
  return SIGN_IN_COMMANDS[id] ?? null;
}
