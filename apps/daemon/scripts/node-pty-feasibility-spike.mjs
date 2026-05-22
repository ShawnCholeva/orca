#!/usr/bin/env node
// node-pty feasibility spike for validating local PTY support.

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

if (!observed.includes(SENTINEL)) {
  console.error(
    `[node-pty-spike] FAIL: sentinel "${SENTINEL}" not observed in output`
  );
  process.exit(1);
}
if (exitInfo.exitCode !== 0) {
  console.error(
    `[node-pty-spike] FAIL: exitCode=${exitInfo.exitCode} signal=${exitInfo.signal ?? "none"}`
  );
  process.exit(1);
}

console.log(
  `[node-pty-spike] OK: sentinel observed, exitCode=0, signal=${exitInfo.signal ?? "none"}`
);
process.exit(0);
