# Daemon as an Independent Service with Resolved Addressing

**Date:** 2026-06-20
**Status:** Design approved, pending spec review

## Problem

Goals get silently stuck, and multiple daemon processes accumulate on the user's
machine. Both trace to one root cause: **the daemon is treated as ephemeral and
per-launch, and its address + auth token are frozen into worker artifacts at
spawn time.**

Concretely, observed in the field:

- A worker (proposal step of the "Workspaces Tab v2" goal) finished its turn, but
  its Claude Code **Stop hook** got `ECONNREFUSED` and the completion signal was
  lost. The workflow run stayed `active` forever with no retry and no
  user-visible error — the failure was only visible inside the worker's tmux
  pane. The goal appeared "stuck" after the user answered a pending question.
- Three daemon instances were live at once: the current one, a six-day-old orphan
  reparented to PID 1 (still holding its port), and a half-dead `tsx watch`
  supervisor whose node child had died.

### Why it happens (evidence-backed)

1. **New random port + new token every launch.** `pick_free_port()` in
   `apps/desktop/src-tauri/src/lib.rs` binds `127.0.0.1:0` and a fresh UUID token
   is generated per launch (`lib.rs:155`). Nothing checks for or reuses an
   existing daemon, so instances stack, each on its own port.
2. **Cleanup only on graceful exit.** `shutdown_daemon` SIGTERMs the process
   group, but only on Tauri's `RunEvent::Exit` — never on crash, force-quit,
   terminal close, or a Rust-side rebuild during `tauri dev`. Orphaned node
   daemons survive and keep their ports.
3. **Workers bake the address + token into hook URLs at spawn time.**
   `buildAgentHookSettings` (`apps/daemon/src/agent-hooks/hook-settings.ts`) emits
   `type:"http"` hooks with `http://127.0.0.1:<port>/...` and
   `Authorization: Bearer <token>`. When the daemon restarts on a new port/token,
   every in-flight worker's hooks point at a dead address — `ECONNREFUSED` (or a
   stale-token 401) — and the completion is silently dropped.

The port-staleness and the daemon accumulation are the same disease seen from two
angles.

## Decisions (from brainstorming)

- **Daemon identity/lifecycle:** singleton at a stable, discoverable address.
- **Addressing + auth:** workers resolve `{url, token}` at hook fire-time from a
  discovery file — they bake only the immutable `kind` + `sessionId`. This is the
  forward-compatible **remote seam**.
- **Server future is on the roadmap:** the discovery file + resolver indirection
  is the seam where a remote endpoint + token refresh later plug in, with no
  worker changes. We build only the local resolver now (no remote machinery yet).
- **Lifecycle ownership:** the daemon is an **independent local service** that
  outlives the desktop. The desktop is a client that adopts the running daemon
  (spawning one only if none is healthy).

A consequence: because the token is resolved at fire-time, **nothing bakes the
token anymore**, so it can keep rotating per launch (leak containment) without
breaking hooks. The "fixed vs rotating token" tension dissolves — we keep
rotating.

## Architecture

```
Desktop (Tauri) = client ──adopt-or-spawn──▶ ~/.orca/daemon.json (discovery file)
        ▲ adopts / respawns if unhealthy            { url, token, pid, ... }
        │                                                     │ written atomically
   HTTP (url+token from file)                                 ▼
        └───────────────────────────────────────▶ orca-daemon (independent service)
                                                     - singleton via daemon.lock
   agent worker (claude-code)                        - drains hook spool on startup
        │ command hook: orca-hook <kind> <sid>                ▲
        ▼                                                     │ POST /v1/agent-hooks/<kind>
   resolver (orca-hook) ── reads daemon.json ──▶ deliver ─────┘
        └─ on failure (non-interactive) → ~/.orca/hook-spool/<uuid>.json
                                           (daemon drains on next startup)
```

Four moving parts: the **discovery file** (source of truth for address+auth and
the remote seam), the **resolver** (`orca-hook`, resolves + proxies at fire-time),
the **independent daemon** (singleton, stable, survives desktop close), and the
**hook spool** (turns lost completions into at-least-once delivery).

## Components

Each unit: what it does / how it's used / what it depends on.

### 1. Discovery file — `~/.orca/daemon.json` (mode `0600`)

```jsonc
{ "version": 1, "url": "http://127.0.0.1:8787", "token": "<uuid>",
  "pid": 12345, "startedAt": "<ISO>", "protocol": "http" }
```

- **Does:** single source of truth for "where + how to auth." Written atomically
  (temp + rename) on daemon startup; best-effort removed on graceful stop.
- **Used by:** resolver and desktop, read-only. "Stale" = pid dead **or**
  `/healthz` identity check fails.
- **Depends on:** nothing. `url`/`protocol` are the remote seam.

### 2. Singleton guard — `~/.orca/daemon.lock`

- **Does:** guarantees one daemon. On startup: acquire an exclusive lock
  (`O_EXCL`/flock). If an existing `daemon.json` pid is alive **and** healthy,
  log and `exit(0)` (let the client adopt). Otherwise bind the port (reuse the
  previous port if free, else OS-assign) and write `daemon.json`.
- **Depends on:** config `dataDir`, discovery file.

### 3. Resolver — `orca-hook <kind> <sessionId>`

`kind` ∈ `stop | stop-failure | tool-use | permission | elicit`.

- **Does:** reads hook JSON from stdin, reads `{url,token}` from `daemon.json`,
  `POST`s to `<url>/v1/agent-hooks/<kind>?sessionId=<sid>` with
  `Authorization: Bearer <token>`, and **relays the response** (stdout + exit
  code) so permission/elicit decisions reach the agent.
- **Failure policy:** non-interactive (`stop`, `tool-use`) → write payload to the
  spool, exit 0 (never block the agent). Interactive (`permission`, `elicit`) →
  fail-safe **deny** (a needed response cannot be spooled).
- **Depends on:** discovery file only — zero baked port/token.
- **Runtime:** a zero-dependency Node script (`orca-hook.mjs`) invoked via node
  (ships with the daemon). Prod-SEA packaging of the script/node availability is a
  plan detail to confirm. Must be cross-platform (macOS/Windows).

### 4. Hook-settings builders

`apps/daemon/src/agent-hooks/hook-settings.ts` and
`apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts` (the only two places
that bake hook URLs).

- **Change:** emit `{ type:"command", command:"<orca-hook> <kind> <sid>",
  timeout }` instead of `{ type:"http", url, headers }`. The `*HookUrl(port,…)`
  helpers collapse into a single arg-builder. **Port and token leave the baked
  output entirely.**
- **Depends on:** resolver invocation path.

### 5. Desktop adopt-or-spawn — `apps/desktop/src-tauri/src/lib.rs`

- **Change:** `setup()` reads `daemon.json`; if healthy, **adopt** (use its
  url+token). Else spawn the daemon **detached** (own session, *not* the app's
  process group; stdio → `~/.orca/daemon.log`), poll until healthy, then adopt.
  **Remove the `RunEvent::Exit` kill** — the daemon is a service now.
  `get_daemon_endpoint` returns the adopted endpoint. Add a client-triggered
  re-adopt/respawn when health is lost mid-use.
- **Depends on:** discovery file, daemon binary (prod) / dev command.

### 6. Spool drain — daemon startup (`apps/daemon/src/index.ts`)

- **Does:** after binding + writing the discovery file, read
  `~/.orca/hook-spool/*.json` (oldest first), feed each through the **same
  internal handler** as its `/v1/agent-hooks/<kind>` route (`onResponseDone`,
  etc.), delete on success; failures age out by `attempts`/age cap.
- **Depends on:** existing agent-hooks handlers (reused, not duplicated).

### 7. Stop path + dev story

- `orca-daemon --stop` reads the pid from `daemon.json` and SIGTERMs; graceful
  shutdown removes the discovery file + releases the lock.
- **Dev:** the daemon runs standalone (its own `tsx watch` terminal/tmux, matching
  the existing `daemon-terminal` convention); the desktop adopts it.

## Data flows

**A. Desktop startup — adopt-or-spawn**

```
read daemon.json
 ├─ healthy (pid alive + /healthz identity ok) → ADOPT {url,token}     [warm]
 └─ missing/stale → spawn daemon DETACHED (log→daemon.log)
        → poll daemon.json until healthy (~10s) → ADOPT                [cold]
```

**B. Daemon startup**

```
acquire daemon.lock (O_EXCL)
 ├─ held by live+healthy daemon → log, exit(0)
 └─ acquired → bind port (reuse prev if free else OS-assign)
        → write daemon.json atomically (token = fresh UUID)
        → drain hook-spool/* through agent-hooks handlers
        → serve
```

**C. Normal hook fire**

```
agent finishes → command hook: orca-hook stop <sid>
  resolver reads daemon.json → POST /v1/agent-hooks/stop?sessionId=<sid> (Bearer)
  → onResponseDone → mediator judges → workflow advances → relay 200 to agent
```

**D. Hook fire while daemon briefly down**

```
orca-hook stop <sid> → connect refused
 ├─ non-interactive → spool payload, exit 0 → next startup drains → completion lands ✅
 └─ interactive     → fail-safe deny
```

**E. Token rotation across restart** (the case broken today)

```
daemon restarts → new token in daemon.json
worker hook unchanged ("orca-hook stop <sid>")
next fire → resolver reads NEW token → auth succeeds ✅
```

The worker artifact never goes stale: it carries no address and no token, only
`kind` + `sessionId`, both immutable for the worker's life.

## Edge cases

| Case | Handling |
|---|---|
| Spawn race | `daemon.lock` `O_EXCL`; loser `exit(0)`; clients poll + adopt the winner. |
| Stale file, pid reused | `/healthz` returns `{service:"orca-daemon", pid}`; mismatch ⇒ stale ⇒ respawn. |
| Preferred port taken | Bind fails ⇒ OS-assign ⇒ write to discovery file; clients resolve via file. |
| Daemon crash mid-session | Live agents spool; desktop health probe fails ⇒ re-adopt/respawn ⇒ drain. |
| Interactive hook while down | Fail-safe deny; agent can retry. No data loss. |
| Spool growth / poison | `enqueuedAt` + `attempts`; cap by count/age; drop after N failed drains. |
| Dev hot-reload | Dying child releases lock + removes file on SIGTERM; new child re-acquires; gap covered by spool. |
| Existing in-flight workers | Not retrofitted (claude-code already loaded their hooks); age out. Current stuck goal handled by separate manual re-fire. |
| Windows | `O_EXCL` lock + detached spawn (new process group); cross-platform Node resolver; prod-SEA must resolve Node — flagged for plan. |
| Multiple windows (future) | Independent daemon is naturally shared; adopt handles it. |

## Error-handling principles

- The resolver **never blocks an agent** on non-interactive kinds (spool + exit 0).
- Spool drain **reuses existing hook handlers** so behavior cannot drift.
- All `~/.orca` writes are atomic and `0600`/`0700`.

## Testing

- **Regression e2e (write first):** "agent completes while daemon is restarting"
  ⇒ assert the step run advances after restart via spool drain. This is the
  stuck-goal repro turned into a guard.
- **Unit:** discovery read/write/atomicity + staleness; resolver per-kind
  (deliver / relay / spool / fail-safe) against a mock; spool ordering + age-out;
  builder emits command hooks with **no port/token** present.
- **Integration:** singleton lock (two starts → one serves); resolver↔real
  loopback daemon for every kind; kill-daemon → fire-stop → assert spool file →
  restart → assert drain advances the workflow.
- **Desktop:** adopt path (healthy file ⇒ no spawn), cold path (spawn detached ⇒
  adopt), no-kill-on-exit.

## Out of scope

- Remote daemon implementation (only the seam is built now).
- Retrofitting already-running workers.
- Unsticking the current "Workspaces Tab v2" goal (separate manual re-fire,
  pending the user's go-ahead).
- Auto-stop / idle shutdown of the daemon (explicit stop + OS logout only).
```
