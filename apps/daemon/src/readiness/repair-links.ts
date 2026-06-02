export type KnownAdapterId = "claude-code" | "codex";

const INSTALL_URLS: Record<KnownAdapterId, string> = {
  "claude-code": "https://docs.anthropic.com/claude/docs/claude-code",
  codex: "https://github.com/openai/codex",
};

const SIGN_IN_COMMANDS: Record<KnownAdapterId, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
};

export function installUrlFor(id: KnownAdapterId): string | null {
  return INSTALL_URLS[id] ?? null;
}

export function signInCommandFor(id: KnownAdapterId): string | null {
  return SIGN_IN_COMMANDS[id] ?? null;
}
