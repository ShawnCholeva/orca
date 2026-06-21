#!/usr/bin/env node
// Stop any running Orca dev daemon so the desktop spawns a FRESH one instead of
// adopting the old instance. The desktop adopts a healthy daemon on launch and
// deliberately never kills it on exit (lib.rs), and the dev daemon runs detached
// via `tsx watch` (setsid) — so the old code outlives app restarts unless we kill
// it here. SIGTERM is graceful: the daemon drains and releases its lock.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const dataDir = process.env.ORCA_DATA_DIR ?? join(homedir(), ".orca");

// 1. SIGTERM the daemon recorded in the discovery/lock files (graceful: releases lock).
const seen = new Set();
for (const file of ["daemon.json", "daemon.lock"]) {
  try {
    const raw = readFileSync(join(dataDir, file), "utf8").trim();
    const pid = file.endsWith(".json") ? JSON.parse(raw).pid : Number.parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0 && !seen.has(pid)) {
      seen.add(pid);
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[kill-daemon] SIGTERM -> pid ${pid}`);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* file missing or unreadable */
  }
}

// 2. Reap the detached dev wrappers (tsx watch / pnpm dev) so they don't respawn it.
if (process.platform !== "win32") {
  for (const pattern of ["tsx watch src/index.ts", "@orca/daemon dev"]) {
    try {
      execFileSync("pkill", ["-f", pattern]);
      console.log(`[kill-daemon] pkill -f "${pattern}"`);
    } catch {
      /* no matching process */
    }
  }
}

// 3. Clear lock + discovery so the next daemon starts clean even if a kill was partial.
for (const file of ["daemon.lock", "daemon.json"]) {
  rmSync(join(dataDir, file), { force: true });
}
console.log("[kill-daemon] cleared lock + discovery");
