import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";

const execFileAsync = promisify(execFile);

// Opt-in: needs a real, authenticated claude on PATH and spends tokens.
// Follows the repo's existing *-smoke gate (see claude-code.auth-smoke.test.ts,
// codex.auth-smoke.test.ts): ORCA_RUN_REAL_SMOKE=1.
const runGated = process.env["ORCA_RUN_REAL_SMOKE"] === "1" ? describe : describe.skip;

const adapter = new ClaudeCodeAdapter();

runGated("claude-code accepts the model flags Orca sends (real)", () => {
  it(
    "accepts --model and --effort together",
    async () => {
      const args = adapter.modelSpawnArgs({
        adapterId: "claude-code",
        modelId: "claude-opus-5",
        contextVariant: "default",
        effort: "low",
      });
      const { stdout } = await execFileAsync("claude", ["-p", "reply with just: ok", ...args], {
        timeout: 120_000,
      });
      expect(stdout.toLowerCase()).toContain("ok");
    },
    130_000,
  );

  it(
    "accepts the [1m] context-variant suffix",
    async () => {
      const args = adapter.modelSpawnArgs({
        adapterId: "claude-code",
        modelId: "claude-opus-5",
        contextVariant: "1m",
        effort: "low",
      });
      const { stdout } = await execFileAsync("claude", ["-p", "reply with just: ok", ...args], {
        timeout: 120_000,
      });
      expect(stdout.toLowerCase()).toContain("ok");
    },
    130_000,
  );

  it(
    "rejects a model that does not exist, so a bad catalog fails loudly",
    async () => {
      const args = adapter.modelSpawnArgs({
        adapterId: "claude-code",
        modelId: "claude-not-a-real-model",
        contextVariant: "default",
        effort: null,
      });
      await expect(execFileAsync("claude", ["-p", "hi", ...args], { timeout: 60_000 })).rejects.toThrow();
    },
    70_000,
  );
});
