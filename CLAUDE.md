# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## What Is Orca

Orca is a **local-first desktop application for multi-agent AI orchestration**. It coordinates multiple AI agent sessions (Claude Code, opencode, Codex, shell) around long-running engineering Goals by preserving operational reasoning, managing shared context, and enabling progression from supervised to autonomous execution (Levels 4 and 5).

## Orientation docs (consult to stay aligned)

Three durable docs sit at the repo root. Read the relevant one **before non-trivial work** so changes align with how Orca actually works and where it's headed:

- **ORCA.md** — the durable **present**: what Orca is, why it's shaped this way, and where things live (the daemon subsystem map, the workflow model, the harness axes). **Consult before touching any subsystem** to match existing patterns and intent. When the code and ORCA.md disagree about *today*, the code wins — fix ORCA.md.
- **FUTURE_ARCHITECTURE.md** — the **destination**: the end-state Orca steers toward (daemon as a standalone server, the control-plane/execution-plane split + Runner Protocol, multi-tenant SaaS tiers, the learning loop). **Consult before any architectural or design decision** — new seams, abstractions, storage/identity choices, or cross-subsystem changes — to confirm the work moves toward, or at least does not preclude, the end-state spine. Flag in your response when a proposed change conflicts with it.
- **FUTURE_WORK.md** — the sequenced **path** (substrate-up phases 0→5). Consult to see whether a task is already planned and where it fits.

Rule of thumb: ORCA.md answers *"how does this work today?"*; FUTURE_ARCHITECTURE.md answers *"is this the right direction?"*; FUTURE_WORK.md answers *"when/where does this land?"*.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Shadow session interactions

Below you will find relevant files based on the provider building on in Orca.

- Always prefer to utilize hooks instead of parsing the shadow workers/sessions

### Claude

Hooks: https://code.claude.com/docs/en/hooks

### Codex

Hooks: https://developers.openai.com/codex/hooks

## Debugging daemon

There is a live daemon running in a tmux session named daemon-terminal if you need to interact with the logs directly

## Driving the app in a browser (Claude interaction)

The desktop frontend is a normal web app: in Tauri it gets the daemon URL+token
via the `get_daemon_endpoint` IPC call (and re-fetches on daemon restart). In a
plain browser `isTauri()` is false, so instead of baking a token we run the dev
server as a **live proxy** to the daemon. All app data flows over HTTP/WS, so the
full product works in a browser (you only lose the custom titlebar buttons and
homedir path expansion).

- **Run it:** `pnpm dev:browser` (works from the repo root or `apps/desktop`) —
  `apps/desktop/scripts/dev-browser.mjs` picks a free port, then starts Vite with
  `ORCA_BROWSER_PROXY=1`. `vite.config.ts` proxies `/v1` (HTTP + WS) to the daemon,
  reading `~/.orca/daemon.json` (or `$ORCA_DATA_DIR/daemon.json`) **live per
  request** and injecting auth (`Authorization` header for HTTP, `?token=` for WS).
  Hits the **real** daemon, no mocks. It prints the Local URL on startup.
- **Why a proxy:** the daemon's port + token are ephemeral and change on every
  restart. The browser talks only to its own origin (no token in the client, no
  CORS), and a daemon restart is picked up with **no reload** — the proxy re-reads
  the discovery record live (target URL refreshed on a 1s interval; token per
  request). Baking `VITE_ORCA_TOKEN` would go stale and cause a WS reconnect loop
  (`socket.close(1008)`); that's the failure this design avoids.
- **Ports:** with no `--port`, it scans from 5173 up (binding `localhost`, so a
  stray `pnpm dev` won't collide) and pins the first free one strictly; the dev
  origin is passed to the app as `VITE_ORCA_BASE_URL` so the WS targets the proxy.
  Pass `--port <n>` to choose one; other args pass through to Vite.
- **Direct (non-proxy) fallback:** the daemon's CORS allowlist (`server.ts`) also
  permits any loopback origin (`localhost`/`127.0.0.1`/`[::1]:*`) plus the tauri
  origins, so hitting the daemon cross-origin works too — but prefer the proxy,
  which also solves the stale-token problem.
- **Claude drives it:** the **Playwright MCP server** is registered at local
  scope (headed). Use its `mcp__playwright__*` tools to navigate/click/type/
  screenshot the running app turn-by-turn. Tools load at session start, so a new
  registration needs a Claude Code restart (or `/mcp` reconnect).
- **macOS note:** Tauri's own WebDriver (`tauri-driver`) does not support macOS
  WKWebView, so this browser-mode path — not WebDriver — is how to automate the UI.
- **npm cache gotcha:** `~/.npm/_cacache` has root-owned entries (from a past
  `sudo npm`) that break `npx`. The MCP server works around it with
  `npm_config_cache=~/.npm-claude`; the real fix is `sudo chown -R $(whoami) ~/.npm`.

## Context Assembly (Token Efficiency)

Context injected into agent sessions is assembled selectively:
- **Always included:** objective, current task, role, hard constraints, confirmed decisions, success criteria
- **Conditionally included:** sibling session summaries, architecture notes, risks, open questions
- **Always excluded:** stale logs, irrelevant discussion, raw transcripts

## Paper Auto-RAG ("Code as Agent Harness")

The paper `agent-harness.pdf` is indexed in a local ChromaDB store
(`.orca/paper-index/`). A `UserPromptSubmit` hook auto-injects the most relevant
passages into context each turn, so Claude can cross-reference the paper for
better approaches. A `SessionStart` hook keeps a warm query server running.

- Prerequisite: place `agent-harness.pdf` (arXiv 2605.18747) at the repo root before indexing — it is not committed to the repo.
- First-time setup: `pnpm run paper:setup` then `pnpm run paper:index`
- Rebuild the index: `pnpm run paper:index`
- Manual query: `scripts/paper-rag/.venv/bin/python scripts/paper-rag/query.py "<question>"`

Retrieval sharpens each query with local pseudo-relevance feedback (`search.py`):
it searches once with the raw prompt, mines the most frequent contentful terms
from the top hits, appends them, and re-searches. This pulls a vague request
toward the right harness sub-area with no LLM call. The bibliography is excluded
at index time (`ingest.py` stops at the "References" page) so citation noise never
pollutes retrieval or expansion.

Retrieval is silent when nothing is strongly relevant. Tune the distance cutoff
with `ORCA_PAPER_MAX_DIST` (default 1.2); change the port with `ORCA_PAPER_PORT`.
Set `ORCA_PAPER_DEBUG=1` to print the expanded query to stderr — on the
`query.py` CLI it prints directly; for the hook, set it when launching the server
(`pnpm run paper:serve`) and the line lands in `.orca/paper-index/server.log`.
