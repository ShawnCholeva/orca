#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const storeDir = join(root, ".orca", "paper-index");
const stateFile = join(storeDir, "server.json");
const logFile = join(storeDir, "server.log");
const py = join(here, ".venv", "bin", "python");
const port = process.env.ORCA_PAPER_PORT || "8787";

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (await healthy()) return;
  if (!existsSync(py)) return; // setup not run yet
  const out = openSync(logFile, "a");
  const child = spawn(py, [join(here, "server.py")], {
    cwd: here,
    env: { ...process.env, ORCA_PAPER_PORT: port },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(stateFile, JSON.stringify({ pid: child.pid, port }));
}

main().finally(() => process.exit(0));
