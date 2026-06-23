# Paper RAG Query Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user submits a substantive build request, reformulate it via `claude -p` into a sharper agent-harness search query before the paper-RAG retrieval, so injected passages target the right sub-area.

**Architecture:** Add a `rewrite.mjs` helper (pure `isSubstantive` gate + `rewriteQuery` that shells out to `claude -p --model haiku`). Wire it into `query-hook.mjs` between reading the prompt and the existing search `fetch`. The user's message to Claude is never altered — only the hidden retrieval query changes. All failures fall back to the raw prompt.

**Tech Stack:** Node.js ESM (`.mjs`), `node:child_process`, the `claude` CLI (headless `-p` mode).

## Global Constraints

- Retrieval must never break: every rewrite failure path (binary missing, nonzero exit, timeout, empty output) falls back to using the raw prompt as the query.
- The user's prompt to the model is never modified; only the internal search query changes.
- The nested `claude -p` invocation must not re-trigger this hook: spawn it with `ORCA_PAPER_REWRITING=1` and no-op the hook when that env var is set.
- Rewrite timeout: ~4000ms. Rewrite model: `haiku`. Substantive gate: ≥ 7 whitespace-delimited words.
- Diagnostics go to **stderr** only (stdout is injected into model context); gated behind `ORCA_PAPER_DEBUG=1`.
- Match existing `scripts/paper-rag` style (small focused ESM modules, no test framework — manual verification via `echo '{...}' | node ...`).

---

### Task 1: `rewrite.mjs` — substantive gate + claude -p rewrite

**Files:**
- Create: `scripts/paper-rag/rewrite.mjs`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `isSubstantive(prompt: string): boolean` — true when trimmed prompt has ≥ 7 words.
  - `rewriteQuery(prompt: string): Promise<string|null>` — resolves to the rewritten query, or `null` on any failure/timeout/empty output.

- [ ] **Step 1: Create the module**

```js
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
```

- [ ] **Step 2: Verify the gate logic**

Run:
```bash
node --input-type=module -e "import('./scripts/paper-rag/rewrite.mjs').then(m => { console.log('long:', m.isSubstantive('i want to build a retry mechanism for agents')); console.log('short:', m.isSubstantive('run it')); })"
```
Expected:
```
long: true
short: false
```

- [ ] **Step 3: Verify the rewrite produces a query (requires logged-in `claude`)**

Run:
```bash
node --input-type=module -e "import('./scripts/paper-rag/rewrite.mjs').then(async m => { const q = await m.rewriteQuery('i want to build a thing that retries failed agent steps'); console.log(JSON.stringify(q)); })"
```
Expected: a non-null string of harness-design keywords printed within ~4s (e.g. `"agent harness failure recovery, retry policies, plan-execute-verify, error feedback control"`). If `claude` is unavailable it prints `null` — that is the correct fallback signal, not a failure of this step.

- [ ] **Step 4: Commit**

```bash
git add scripts/paper-rag/rewrite.mjs
git commit -m "feat(paper-rag): add substantive gate and claude -p query rewrite

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire rewrite into `query-hook.mjs`

**Files:**
- Modify: `scripts/paper-rag/query-hook.mjs`

**Interfaces:**
- Consumes: `isSubstantive`, `rewriteQuery` from `./rewrite.mjs` (Task 1).
- Produces: no new exports; changes the hook's runtime behavior.

- [ ] **Step 1: Add the import**

At the top of `scripts/paper-rag/query-hook.mjs`, below the existing `const` declarations (after the `WORD_CAP` line), add:

```js
import { isSubstantive, rewriteQuery } from "./rewrite.mjs";
```

- [ ] **Step 2: Add the recursion guard and query-derivation step**

In `query-hook.mjs`, replace the start of `main()` — from the `async function main() {` line through the existing `if (!prompt) return;` line — with:

```js
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
```

- [ ] **Step 3: Use the derived query in the search request**

In the same file, change the search `fetch` body from `query: prompt` to `query`:

```js
      body: JSON.stringify({ query, k: 3 }),
```

(The rest of `main()` — the `fetch`, `MAX_DIST` filter, `clampWords`, and stdout write — is unchanged.)

- [ ] **Step 4: Verify trivial prompts skip the rewrite (instant)**

Run:
```bash
echo '{"prompt":"run it"}' | ORCA_PAPER_DEBUG=1 node scripts/paper-rag/query-hook.mjs
```
Expected on stderr: `rewrite skipped (short prompt)`. Returns immediately (no multi-second pause).

- [ ] **Step 5: Verify the recursion guard no-ops**

Run:
```bash
echo '{"prompt":"a long substantive build request about designing agent harnesses"}' | ORCA_PAPER_REWRITING=1 node scripts/paper-rag/query-hook.mjs
```
Expected: exits immediately, prints nothing on stdout or stderr.

- [ ] **Step 6: Verify the end-to-end rewrite path (requires logged-in `claude` + running server)**

Ensure the server is up, then run:
```bash
node scripts/paper-rag/ensure-server.mjs
echo '{"prompt":"i want to build a thing that retries failed agent steps"}' | ORCA_PAPER_DEBUG=1 node scripts/paper-rag/query-hook.mjs
```
Expected:
- stderr shows `rewrote: "<harness-design query>"` (or `rewrite failed, using raw prompt` if `claude` is unavailable — still valid, retrieval proceeds on the raw prompt).
- stdout shows the `Relevant passages from the *Code as Agent Harness* paper …` block with passages targeting the retry/repair/verification sub-area.

- [ ] **Step 7: Commit**

```bash
git add scripts/paper-rag/query-hook.mjs
git commit -m "feat(paper-rag): rewrite substantive prompts before retrieval

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Rewrite changes internal query only → Task 2 Step 3 (`query` var; user prompt untouched). ✓
- `claude -p --model haiku` backend → Task 1 Step 1. ✓
- Gate on substance (≥7 words) → Task 1 (`isSubstantive`), used in Task 2 Step 2. ✓
- ~4s timeout + fallback to raw prompt on all failure modes → Task 1 (`REWRITE_TIMEOUT_MS`, `finish(null)` on error/close/timeout) + Task 2 (`if (rewritten) … else` keeps `query = prompt`). ✓
- Recursion guard `ORCA_PAPER_REWRITING=1` → set in Task 1 spawn env, checked in Task 2 Step 2. ✓
- Temp-dir cwd isolation → Task 1 (`cwd: tmpdir()`). ✓
- `ORCA_PAPER_DEBUG=1` stderr diagnostics (rewrote / skipped / failed) → Task 2 Step 2. ✓
- Manual testing, no automated harness → verification steps use `echo | node`. ✓
- No changes to server.py/search.py/ingest.py/ensure-server.mjs/settings.json → only `rewrite.mjs` (new) and `query-hook.mjs` touched. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type consistency:** `isSubstantive`/`rewriteQuery` names and signatures match between Task 1 (definitions) and Task 2 (import + calls). `query` variable consistent across Task 2 steps 2–3. ✓
