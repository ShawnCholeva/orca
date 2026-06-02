import type { AdapterId, ModelProviderId } from "@orca/contracts";

export type AdapterModelInfo = {
  id: string;
  displayName: string;
  capabilities: string[];
};

export const PROVIDER_BY_AGENT_ID: Record<string, ModelProviderId | undefined> = {
  "claude-code": "orca/anthropic",
  codex: "orca/openai",
  antigravity: "orca/google",
};

export const MODELS_BY_AGENT_ID: Record<string, AdapterModelInfo[] | undefined> = {
  "claude-code": [
    {
      id: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      capabilities: ["reasoning", "long_context", "tool_use"],
    },
    {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      capabilities: ["reasoning", "tool_use"],
    },
    {
      id: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      capabilities: ["fast", "cheap"],
    },
  ],
  codex: [
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      capabilities: ["reasoning", "long_context", "tool_use"],
    },
    {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      capabilities: ["reasoning", "tool_use"],
    },
    {
      id: "gpt-5.4-mini",
      displayName: "GPT-5.4 mini",
      capabilities: ["fast", "cheap", "tool_use"],
    },
    {
      id: "gpt-5.3-codex",
      displayName: "GPT-5.3 Codex",
      capabilities: ["reasoning", "code_editing", "tool_use"],
    },
    {
      id: "gpt-5.2",
      displayName: "GPT-5.2",
      capabilities: ["reasoning", "tool_use"],
    },
  ],
  antigravity: [
    {
      id: "gemini-3.5-flash",
      displayName: "Gemini 3.5 Flash",
      capabilities: ["reasoning", "long_context", "tool_use", "code_editing"],
    },
    {
      id: "gemini-3.1-pro-high",
      displayName: "Gemini 3.1 Pro (high)",
      capabilities: ["reasoning", "long_context", "tool_use", "code_editing"],
    },
    {
      id: "gemini-3.1-pro-low",
      displayName: "Gemini 3.1 Pro (low)",
      capabilities: ["reasoning", "tool_use", "code_editing"],
    },
    {
      id: "gemini-3-flash",
      displayName: "Gemini 3 Flash",
      capabilities: ["fast", "tool_use", "code_editing"],
    },
  ],
};

export function adapterSupportsModel(adapterId: AdapterId, modelId: string): boolean {
  return MODELS_BY_AGENT_ID[adapterId]?.some((model) => model.id === modelId) ?? false;
}
