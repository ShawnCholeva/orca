#!/usr/bin/env node
// M4-001 feasibility spike: import node-pty, spawn a trivial PTY, observe
// output, exit cleanly. Scratch script — its only job is to prove the native
// dependency works on the local target before M4-002 begins. Delete after
// findings are recorded if desired; the findings note is the artifact that
// stays.

import { spawn } from "node-pty";

const SENTINEL = "orca-pty-ok";

const pty = spawn("/bin/sh", ["-c", `echo ${SENTINEL} && exit 0`], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let observed = "";
pty.onData((data) => {
  observed += data;
  process.stdout.write(data);
});

const exitInfo = await new Promise((resolve) => {
  pty.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
});

const sawSentinel = observed.includes(SENTINEL);
if (!sawSentinel) {
  console.error(
    `[m4-001-spike] FAIL: sentinel "${SENTINEL}" not observed in output`
  );
  process.exit(1);
}
if (exitInfo.exitCode !== 0) {
  console.error(
    `[m4-001-spike] FAIL: exitCode=${exitInfo.exitCode} signal=${exitInfo.signal ?? "none"}`
  );
  process.exit(1);
}

console.log(
  `[m4-001-spike] OK: sentinel observed, exitCode=0, signal=${exitInfo.signal ?? "none"}`
);
process.exit(0);
