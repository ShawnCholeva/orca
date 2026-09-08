import { describe, expect, it } from "vitest";
import type { ResolvedModelChoice } from "@orca/contracts";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";

const choice = (over: Partial<ResolvedModelChoice> = {}): ResolvedModelChoice => ({
  adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "high", ...over,
});

describe("ClaudeCodeAdapter.modelSpawnArgs", () => {
  const adapter = new ClaudeCodeAdapter();

  it("passes the model and the effort together", () => {
    expect(adapter.modelSpawnArgs(choice())).toEqual(["--model", "claude-opus-5", "--effort", "high"]);
  });

  it("appends the 1m suffix for a long-context variant", () => {
    expect(adapter.modelSpawnArgs(choice({ contextVariant: "1m" })))
      .toEqual(["--model", "claude-opus-5[1m]", "--effort", "high"]);
  });

  it("omits --effort only when there is no effort to pass", () => {
    expect(adapter.modelSpawnArgs(choice({ effort: null }))).toEqual(["--model", "claude-opus-5"]);
  });
});

describe("CodexAdapter.modelSpawnArgs", () => {
  const adapter = new CodexAdapter();

  it("uses -m and the reasoning-effort config key", () => {
    expect(adapter.modelSpawnArgs(choice({ adapterId: "codex", modelId: "gpt-5.5", effort: "high" })))
      .toEqual(["-m", "gpt-5.5", "-c", "model_reasoning_effort=high"]);
  });

  it("passes only the model when no effort is set", () => {
    expect(adapter.modelSpawnArgs(choice({ adapterId: "codex", modelId: "gpt-5.5", effort: null })))
      .toEqual(["-m", "gpt-5.5"]);
  });
});

describe("AntigravityAdapter.modelSpawnArgs", () => {
  it("passes the model and never an effort", () => {
    expect(new AntigravityAdapter().modelSpawnArgs(
      choice({ adapterId: "antigravity", modelId: "gemini-3.5-flash", effort: "high" }),
    )).toEqual(["--model", "gemini-3.5-flash"]);
  });
});

describe("resolveSpawn", () => {
  it("carries the model args when a choice is supplied", async () => {
    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({
      goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws", model: choice(),
    });
    expect(spawn.args).toEqual(["--model", "claude-opus-5", "--effort", "high"]);
  });

  it("carries no model args when no choice is supplied", async () => {
    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({ goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws" });
    expect(spawn.args).toEqual([]);
  });
});
