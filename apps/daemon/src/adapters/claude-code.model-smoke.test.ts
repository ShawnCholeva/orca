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
      let caught: (NodeJS.ErrnoException & { stderr?: string }) | undefined;
      try {
        await execFileAsync("claude", ["-p", "hi", ...args], { timeout: 60_000 });
      } catch (err) {
        caught = err as NodeJS.ErrnoException & { stderr?: string };
      }
      if (!caught) {
        expect.fail("expected claude to reject an unrecognized model id, but it exited successfully");
      }
      // err.code is the process exit status for a normal exit, but the string
      // "ENOENT" when the binary is missing and undefined on a timeout kill —
      // asserting it is the number 1 already rules both of those out. The
      // stderr match is what actually pins this to model-id rejection rather
      // than any other way execFile can reject.
      expect(caught.code).toBe(1);
      expect(caught.stderr).toMatch(/unrecognized_model|isn't described by this version's model catalog/i);
    },
    70_000,
  );
});
