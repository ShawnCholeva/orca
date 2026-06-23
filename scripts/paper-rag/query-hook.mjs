#!/usr/bin/env node
const port = process.env.ORCA_PAPER_PORT || "8787";
const MAX_DIST = Number(process.env.ORCA_PAPER_MAX_DIST || "1.3");
const WORD_CAP = 150;

import { isSubstantive, rewriteQuery } from "./rewrite.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 500);
  });
}

function clampWords(text, n) {
  const words = text.split(/\s+/);
  return words.length <= n ? text : words.slice(0, n).join(" ") + " …";
}

async function main() {
  // Recursion guard: the nested `claude -p` rewrite runs this hook again in its
  // own session; bail immediately so it can't trigger itself.
  if (process.env.ORCA_PAPER_REWRITING) return;

  let prompt = "";
  try {
    prompt = (JSON.parse(await readStdin()).prompt || "").trim();
  } catch {
    return;
  }
  if (!prompt) return;

  const debug = !!process.env.ORCA_PAPER_DEBUG;
  let query = prompt;
  if (isSubstantive(prompt)) {
    const rewritten = await rewriteQuery(prompt);
    if (rewritten) {
      query = rewritten;
      if (debug) process.stderr.write(`rewrote: ${JSON.stringify(query)}\n`);
    } else if (debug) {
      process.stderr.write("rewrite failed, using raw prompt\n");
    }
  } else if (debug) {
    process.stderr.write("rewrite skipped (short prompt)\n");
  }

  let results = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, k: 3 }),
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return;
    results = (await res.json()).results || [];
  } catch {
    return;
  }

  const strong = results.filter((r) => r.distance <= MAX_DIST).slice(0, 3);
  if (strong.length === 0) return;

  const lines = strong.map(
    (r) => `- (p.${r.page}) ${clampWords(r.text, WORD_CAP)}`
  );
  process.stdout.write(
    "Relevant passages from the *Code as Agent Harness* paper " +
      "(auto-retrieved; consider whether they suggest a better approach):\n" +
      lines.join("\n") +
      "\n"
  );
}

main().finally(() => process.exit(0));
