// scripts/paper-rag/rewrite.mjs
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const REWRITE_TIMEOUT_MS = 4000;
const MIN_WORDS = 7;

const INSTRUCTION = `Rewrite the developer's build request below into a concise \
keyword/phrase search query for retrieving passages from a survey on designing \
agent harnesses. Emphasize the relevant harness sub-area (planning, memory/context \
engineering, tool use, plan-execute-verify control, verification, multi-agent \
orchestration). Output ONLY the query text — no preamble, no quotes, no explanation.

Build request:
`;

export function isSubstantive(prompt) {
  return prompt.trim().split(/\s+/).filter(Boolean).length >= MIN_WORDS;
}

export function rewriteQuery(prompt) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--model", "haiku"], {
      cwd: tmpdir(), // avoid loading the project's CLAUDE.md / hooks
      env: { ...process.env, ORCA_PAPER_REWRITING: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });

    let out = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), REWRITE_TIMEOUT_MS);

    child.on("error", () => finish(null)); // e.g. claude not on PATH
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => {
      const text = out.trim();
      finish(code === 0 && text ? text : null);
    });

    child.stdin.on("error", () => {});
    child.stdin.write(INSTRUCTION + prompt);
    child.stdin.end();
  });
}
