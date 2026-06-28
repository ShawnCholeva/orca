#!/usr/bin/env node
// Serves the frontend in browser mode behind a live proxy to the Orca daemon.
//
// The Tauri shell hands the frontend the daemon URL + token via the
// `get_daemon_endpoint` IPC call and re-fetches it whenever the daemon restarts.
// A baked-in token can't do that, so instead of injecting VITE_ORCA_TOKEN we run
// the dev server with ORCA_BROWSER_PROXY=1 and let vite.config proxy /v1 (HTTP +
// WS) to the daemon, reading ~/.orca/daemon.json *live* per request and injecting
// auth. The browser talks only to its own origin — no token in the client, no
// CORS, and a daemon restart (new ephemeral port + token) is picked up with no
// reload. See CLAUDE.md "Driving the app in a browser".
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Probe by binding "localhost" the same way vite does, so a listener on either
// IPv4 or IPv6 loopback (a stray `pnpm dev`) registers as in-use.
function freePort(start) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", () =>
      start < 5273 ? resolve(freePort(start + 1)) : reject(new Error("no free port in 5173-5273")),
    );
    srv.listen(start, "localhost", () => srv.close(() => resolve(start)));
  });
}

const recordPath = process.env.ORCA_DATA_DIR
  ? join(process.env.ORCA_DATA_DIR, "daemon.json")
  : join(homedir(), ".orca", "daemon.json");

try {
  const rec = JSON.parse(readFileSync(recordPath, "utf8"));
  console.log(`[dev:browser] proxying /v1 -> ${rec.url} (live; survives daemon restarts)`);
} catch {
  console.log(`[dev:browser] no daemon record at ${recordPath} yet — the proxy reads it live, so start the daemon any time`);
}

// Honor an explicit --port; otherwise pick the first free port from 5173 up. We
// need a known port to set the dev origin (VITE_ORCA_BASE_URL) the WS uses.
const passthrough = process.argv.slice(2);
const portFlag = passthrough.indexOf("--port");
const port = portFlag === -1 ? await freePort(5173) : Number(passthrough[portFlag + 1]);

const viteBin = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "vite");
const args = portFlag === -1 ? ["--port", String(port), "--strictPort", ...passthrough] : passthrough;

console.log(`[dev:browser] open http://localhost:${port}`);

const child = spawn(viteBin, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ORCA_BROWSER_PROXY: "1",
    // Same-origin: REST + WS go to the dev server, which proxies to the daemon.
    VITE_ORCA_BASE_URL: `http://localhost:${port}`,
    VITE_ORCA_TOKEN: "",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
