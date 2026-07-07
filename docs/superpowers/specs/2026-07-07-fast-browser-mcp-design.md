# Fast Browser MCP — an in-page runtime that collapses N actions into one round-trip

**Date:** 2026-07-07
**Status:** Design — approved in session
**Scope:** A general-purpose browser-automation MCP server that replaces the Playwright MCP server for agent-driven browser interaction. New standalone package `packages/fast-browser-mcp/` (`@orca/fast-browser-mcp`). Not Orca-specific, though the primary consumer is driving the Orca app via `pnpm dev:browser`.

---

## 1. Problem

The agent drives web apps through the **Playwright MCP server**, and its dominant pain is **per-action wall-clock latency**. Two costs stack on *every single call*:

1. The MCP server auto-generates a full accessibility-tree snapshot **after each action**.
2. Playwright's actionability pipeline (wait-for-stable / -visible / -enabled, scroll-into-view, receives-events) runs **before each action**.

The structural problem underneath both: **every action crosses the process boundary** — agent → tool → browser → back. A 6-step flow (navigate → click → type → click → wait → read) is 6 sequential round-trips, each a separate agent turn. Even raw CDP would not fix this; it only makes each of the 6 crossings marginally cheaper.

The insight that reframes the design: don't build a faster pipe to the browser — **move the interaction loop into the page** so N actions cost **one** round-trip instead of N.

## 2. Goals / Non-goals

**Goals**
- Remove Playwright entirely. Use CDP only as a hair-thin transport (~4 methods).
- **Eval-first interface**: the agent's primary tool is `run(program)` — it sends a short JS program that executes entirely in-page and returns one compact result.
- **One round-trip per flow**: "fill form + submit + read" is a single `run` call executed at DOM speed.
- **No auto-snapshot, ever**: seeing the page is on-demand (`$read()` digest) and compact; screenshots only when explicitly requested.
- **Event-driven settling**: waits resolve the instant the DOM settles (`MutationObserver`), not via polled recheck loops.
- Delivered as a **custom MCP server** holding a warm CDP connection between calls.
- **Launches its own isolated Chromium** (temp profile), not the user's real browser.
- Prove the latency win with a benchmark (old 6-action path vs one `run` program).

**Non-goals (explicit, v1)**
- Multi-tab / multi-target management (single active page only).
- Trusted CDP-`Input.dispatch*` events (synthetic in-page events only; seam left).
- File upload/download, network mocking/interception.
- Visual-regression or accessibility-tree fidelity — this is an interaction tool, not a snapshot tool.
- Attaching to an existing browser session (dedicated Chromium only).

## 3. Architecture

A stdio MCP server that owns a persistent Chromium + one CDP page connection, exposing a small tool set. Helper primitives live *inside the page*, injected once.

```
Agent ──MCP(stdio)──▶ fast-browser-mcp ──CDP(ws, warm)──▶ Chromium page
                                                              └─ __fb stdlib (injected once)
```

Package conventions mirror `packages/contracts/`: `type: module`, TypeScript → tsc → `dist`, vitest for tests.

### 3.1 `src/index.ts` — MCP server

Registers tools via `@modelcontextprotocol/sdk`. Lazily launches the browser on first tool call. No auto-snapshot on any tool.

- **`navigate(url)`** — CDP `Page.navigate` + await load; returns a compact `$read()` digest.
- **`run(program)`** — *the core.* Wraps the agent's JS string in an async IIFE and issues **one** CDP `Runtime.evaluate({ awaitPromise: true, returnByValue: true })` against the page context (where `__fb` is present). Returns `{ ok, value, error? }`.
- **`screenshot(opts?)`** — CDP `Page.captureScreenshot`, returned as an image, on demand only.
- **`close()`** — kill Chromium.

### 3.2 `src/browser.ts` — launcher

Use **`chrome-launcher`** (light, well-scoped) to find/launch Chrome with `--remote-debugging-port` + a temp `--user-data-dir` (isolated from the user's real browser). Headed by default (the human can watch, matching today's setup); `--headless` via env flag. Discover the page target's `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json`.

### 3.3 `src/cdp.ts` — minimal CDP client

A tiny JSON-RPC-over-WebSocket client on `ws`. Only methods used: `Page.navigate`, `Page.addScriptToEvaluateOnNewDocument`, `Runtime.evaluate`, `Page.captureScreenshot` (plus a seam for `Input.dispatch*`). Single active page/tab for v1. Detects ws close → marks the browser dead so the next tool call relaunches.

### 3.4 `src/runtime.js` — the in-page stdlib (injected)

Shipped as a raw string/asset injected verbatim. Registered via `Page.addScriptToEvaluateOnNewDocument` (present on every navigation) **and** eval'd into the current page on connect (so it works before the first navigation). Exposes global `__fb`:

- `$(sel)` / `$$(sel)` — CSS plus `text=` / `role=` shorthand resolution.
- `$click(sel)` — resolve → `scrollIntoViewIfNeeded` → visible/enabled check → dispatch pointer/mouse events (synthetic by default).
- `$type(sel, text)` / `$fill(sel, value)` — focus, set value, dispatch `input` / `change`; contenteditable handled.
- `$waitFor(selOrPredicate, { timeout })` — **`MutationObserver`-based**; resolves the instant the DOM settles. Rejects on timeout naming what it waited for. This is the real latency win on dynamic content.
- `$read(rootSel?)` — **compact** digest: interactive elements (tag, role, accessible name/text, `data-testid`, visible/enabled) + a short visible-text outline + url/title. Size-capped with a truncation note.

This module is the actionability layer that replaces Playwright's — deliberately *minimal*. A `{ trusted: true }` path routing clicks through CDP `Input.dispatch*` for apps needing real trusted events is **designed-in as a seam but deferred** from v1.

## 4. Data flow (one round-trip)

`run(program)` → server wraps `program` in an async IIFE → **one** `Runtime.evaluate` → Chrome runs all `__fb` ops in-page (synchronous / awaited locally) → serialized return value → compact JSON back to the agent. N actions, one boundary crossing.

## 5. Error handling

- CDP eval exception → structured `{ ok: false, error: { message, stack } }`. Never throws away the session; the agent fixes its JS and retries.
- Helper failures (`no element for <sel>`, `$waitFor` timeout naming its target) surface as clear in-page errors inside that structured error.
- Chromium crash / ws disconnect → detected; the next tool call auto-relaunches or returns "browser closed, retry".
- Program-size and result-size caps keep round-trips compact.

## 6. Dependencies

`@modelcontextprotocol/sdk`, `ws`, `chrome-launcher`. Dev: `typescript`, `vitest`.

## 7. Files to create

- `packages/fast-browser-mcp/package.json` — mirror `packages/contracts/package.json` (name `@orca/fast-browser-mcp`, `bin` for the stdio server, build / typecheck / test scripts).
- `packages/fast-browser-mcp/tsconfig.json` — mirror `packages/contracts/tsconfig.json`.
- `packages/fast-browser-mcp/src/{index,browser,cdp}.ts` and `src/runtime.js`.
- `packages/fast-browser-mcp/test/` — vitest specs (§8).
- `packages/fast-browser-mcp/README.md`, plus a note in `CLAUDE.md`'s "Driving the app in a browser" section on registering/using it alongside (or instead of) Playwright MCP.

## 8. Verification

1. **Unit:** `cdp.ts` connects to a launched headless Chromium and round-trips `Runtime.evaluate('1+1')`.
2. **Integration:** load a fixture HTML with a form; one `run` program does `$fill` × N + `$click` submit + `return $read()`; assert the digest reflects the submitted state — verifying multi-step-in-one-call.
3. **Benchmark (the point):** a fixture with a 6-step flow, timed (a) as 6 sequential Playwright-MCP-style actions vs (b) one `run` program; assert/report the wall-clock delta to confirm the per-action-latency win.
4. **Manual end-to-end:** `pnpm build`, register the server in Claude Code (`claude mcp add`), start `pnpm dev:browser`, and drive a real Orca multi-step flow (open settings → change supervision mode → read state) in a single `run` call; confirm it's one fast round-trip.

## 9. Open follow-ups (post-v1)

- Trusted CDP-`Input` events for apps that reject synthetic clicks.
- Multi-tab / target management.
- Attach-to-existing-browser mode for logged-in sessions.
