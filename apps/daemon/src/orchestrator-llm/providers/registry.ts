import { ClaudeAgentProvider } from "./claude.js";
import { CodexAgentProvider } from "./codex.js";
import { AntigravityAgentProvider } from "./antigravity.js";
import type { ShadowAdapterId, AgentProvider } from "./types.js";

const PROVIDERS: Record<ShadowAdapterId, AgentProvider> = {
  "claude-code": new ClaudeAgentProvider(),
  codex: new CodexAgentProvider(),
  antigravity: new AntigravityAgentProvider(),
};

export function resolveAgentProvider(id: ShadowAdapterId): AgentProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown shadow provider: ${id}`);
  return provider;
}
