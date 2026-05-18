#!/usr/bin/env node
// M4-001 node-pty feasibility spike (see notes/m4-001-pty-feasibility.md).

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
