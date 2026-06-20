import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listSpool } from "./discovery/spool.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const tsxBin = join(__dirname, "../node_modules/.bin/tsx");

describe("hook subcommand (spools when no daemon)", () => {
  it("exits 0 and spools a stop hook when discovery file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-hookcmd-"));
    try {
      // run via tsx so the .ts entry executes
      execFileSync(
        tsxBin,
        [join(__dirname, "index.ts"), "hook", "/v1/agent-hooks/stop?sessionId=s1", "--spool"],
        { input: "{}", env: { ...process.env, ORCA_DATA_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] },
      );
      expect(listSpool(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
