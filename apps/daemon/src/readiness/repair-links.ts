export type KnownAdapterId = "claude-code" | "codex" | "antigravity";

const INSTALL_URLS: Record<KnownAdapterId, string> = {
  "claude-code": "https://docs.anthropic.com/claude/docs/claude-code",
  codex: "https://github.com/openai/codex",
  antigravity: "https://www.antigravity.google/docs/cli-getting-started",
};

const SIGN_IN_COMMANDS: Record<KnownAdapterId, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  antigravity: "agy",
};

export function installUrlFor(id: KnownAdapterId): string | null {
  return INSTALL_URLS[id] ?? null;
}

export function signInCommandFor(id: KnownAdapterId): string | null {
  return SIGN_IN_COMMANDS[id] ?? null;
}
