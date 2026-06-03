import { ClaudeShadowProvider } from "./claude.js";
import { CodexShadowProvider } from "./codex.js";
import { AntigravityShadowProvider } from "./antigravity.js";
import type { ShadowAdapterId, ShadowProvider } from "./types.js";

const PROVIDERS: Record<ShadowAdapterId, ShadowProvider> = {
  "claude-code": new ClaudeShadowProvider(),
  codex: new CodexShadowProvider(),
  antigravity: new AntigravityShadowProvider(),
};

export function resolveShadowProvider(id: ShadowAdapterId): ShadowProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown shadow provider: ${id}`);
  return provider;
}
