# Agent-Input Transport — node-pty heuristic vs tmux-backed worker sessions

**Date:** 2026-05-30
**Status:** DECIDED → Option B (tmux-backed worker sessions). See "Decision" below.
**Author:** debugging session (dispatch-chain fixes d042a60 / 539ceaf / 590930c)

## Decision (2026-05-30)

**Option B**, and cheaper than first estimated, because **worker agents are headless by
design** in the orchestrator-mediated model — confirmed against
`2026-05-28-orchestrator-mediated-workflows-design.md`:

- L16: the orchestrator-LLM is the *sole conversational partner* in the chat surface.
- L34: the per-step agent *receives messages from orchestrator-LLM* (not the user).
- L370 (deferred non-goal): the agent PTY view is only a *read-only debug drawer*,
  explicitly deferred.

So there is **no interactive user terminal** on a worker. The "embedded-terminal
native-feel / bidirectional input / resize / control-vs-UI race" costs below apply to
the OLD per-step-terminal model and to manually-created sessions — **not** to
orchestrator-dispatched workers. A worker is therefore just a *second headless tmux
session* alongside the shadow, reusing `orchestrator-llm/shadow-session.ts` wholesale
(fixed geometry `-x 220 -y 50`, `capture-pane` readiness, `paste-buffer`+`send-keys`
submit). Open questions 2 (resize) and 4 (control/UI race) are moot. If the read-only
debug drawer is built later, it streams from `tmux pipe-pane` → output store.

Revised blast radius: a new tmux-backed worker launcher (mirroring the shadow spawn) +
routing initial/forward/revise delivery through tmux send-keys + reconcile/reattach of
surviving tmux worker sessions. The desktop and the node-pty session runtime for
*manual* sessions are untouched.

**UI impact confirmed ~nil (2026-05-30).** The primary surface is the orchestrator
shell (`App.tsx` default mode: Goals rail + Orchestrator/Reasoning/Workflows tabs); the
user operates **chat-only** and never sees worker sessions. `SessionsPanel` (which lists
node-pty sessions) lives in `GoalDetailView`, a *secondary "detail" mode* reached only
via an explicit "Goal Details" button — confirmed not used in practice; all sessions are
spawned headless by the orchestrator. So moving workers to headless tmux changes nothing
in the real workflow; it only means a tmux worker won't appear in that opt-in node-pty
session list (the deferred read-only debug drawer, L370). Manual session creation via
`CreateSessionDialog` is likewise unused. Conclusion: no meaningful UI migration cost.

**Scope addition (cleanup): remove the Sessions panel from Goal Details.** Once workers
are headless tmux, `SessionsPanel` lists only node-pty sessions that no longer exist in
normal use — it becomes dead/misleading UI. Remove `<SessionsPanel>` from
`GoalDetailView` (`apps/desktop/src/goal-detail/GoalDetailView.tsx`). Decide per-task
whether to also delete the now-orphaned components (`SessionsPanel`, `SessionTerminalView`,
`useSessionStream`, `CreateSessionDialog`, related tests) or keep them dormant for the
future read-only debug drawer (L370). The daemon session HTTP/WS routes and the node-pty
runtime stay (manual-session API + the future drawer may reuse them); this is a
UI-surface removal, not a backend removal. Folded into the implementation plan.

---

## Problem

The orchestrator must deliver text to a worker agent's interactive TUI and have it
**submit**: (1) the composed step objective on launch, (2) forwarded user chat
messages (`forward_to_agent`), (3) revise feedback (`revise_step`).

Today worker sessions run under **node-pty** and delivery writes raw bytes to the
pty (`getHandle().write(...)`). This is unreliable:

- **Initial delivery** (`deliver-initial-prompt.ts`) works only via heuristics: poll
  the cumulative output stream for an input-box pattern, wait a fixed *settle* (the
  box appears before MCP/hooks finish; mid-init keystrokes are dropped), bracketed-paste
  the multi-line prompt, then Enter. Verified working but timing-fragile.
- **`forward_to_agent` / `revise_step`** still do a plain `write(text + "\n")` with
  none of that. Observed failure (2026-05-30, goal `d0b8af9d`): a forwarded message
  arrived while the agent was mid-turn; claude buffered it in the input box and never
  submitted it. The message is stuck on screen, unsubmitted.

Root limitation: **node-pty exposes only a cumulative byte stream — no screen
capture.** We cannot deterministically read "is the agent idle at `❯` or busy", nor
confirm a submit landed. Every gate is a time/quiescence heuristic.

## Current architecture (relevant facts)

- `apps/daemon/src/pty/manager.ts` is the **only** file allowed to import `node-pty`,
  behind the `PtyManager` interface (`start() -> { handle, events }`). Clean boundary.
- `SessionRuntime.start` spawns the pty; `pty.onData` → `broadcastOutput` (WS) +
  persist to `session_output_chunks`. Input: `handle.write`. Resize: `handle.resize`.
- The **embedded terminal is a raw-byte passthrough**: the desktop (`SessionTerminalView`,
  xterm) renders the agent's native TUI bytes directly over WS. This *is* the
  "native terminal feel" MVP requirement.
- node-pty children **die with the daemon**; `reconcileSessionsOnBoot` marks stale
  sessions terminal and boot-resume **always respawns** (reattach is a documented no-op).
- The **orchestrator shadow session already uses tmux** (`orchestrator-llm/shadow-session.ts`):
  `tmux new-session -d`, readiness via `capture-pane -p` + regex, submit via
  `load-buffer`/`paste-buffer -p` + `send-keys Enter`. Proven reliable; it is headless
  (no UI).

## Option A — node-pty + quiescence heuristic (contained)

Keep worker sessions on node-pty. Generalize the initial-delivery mechanism to the
forward/revise path: before submitting, **wait for output quiescence** (no new chunks
for ~1.5 s ⇒ agent likely idle), then bracketed-paste + settle + Enter. Route
`forward_to_agent` / `revise_step` through this instead of plain write.

- **Pros:** small, localized to the orchestrator delivery module + server wiring;
  embedded terminal, runtime, reconcile untouched; no new runtime dependency.
- **Cons:** still heuristic. Quiescence ≠ idle (an agent pausing mid-thought reads as
  idle → paste at the wrong moment). Submit is unconfirmable. Perpetuates the timing
  hacks. Does **not** fix respawn-on-restart.

## Option B — tmux-backed worker sessions (proven, bigger)

Run worker claude **inside tmux** (as the shadow does), but keep the UI by having
node-pty spawn `tmux attach -t <name>` instead of `claude` directly. Two channels on
one tmux session:

- **UI channel:** node-pty attaches → same byte stream to xterm. Native feel preserved.
- **Control channel:** orchestrator drives the *same* tmux session out-of-band via
  `capture-pane -p` (deterministic readiness/idle: see `❯` vs spinner/"esc to interrupt")
  and `paste-buffer` + `send-keys Enter` (robust submit) — reusing the shadow helpers.

- **Pros:** deterministic readiness/idle + robust submit; one consistent transport with
  the shadow; eliminates the heuristic class entirely. **Bonus:** tmux sessions
  **survive daemon restart** → reattach becomes real, fixing the current respawn-only
  limitation (`reattach` no-op) and losing less agent state on reload.
- **Cons:** real refactor of the session runtime: wrap launch in tmux; reattach path;
  resize → tmux `resize-window` + client resize; reconcile/resume reworked to detect &
  reattach surviving tmux sessions. **Hard tmux dependency for all worker sessions**
  (today only the shadow needs it) — a packaging concern for the shipped app (sidecar /
  bundling, cf. M4 sidecar-packaging notes). Control channel races slightly with the
  attached client's redraw (minor; capture-pane is authoritative).

## Verified mechanics (2026-05-30 spikes)

- **Auth: reuse the shadow pattern, do NOT set `CLAUDE_CONFIG_DIR`.** Inheriting `HOME`
  gives claude real `~/.claude` creds. Setting `CLAUDE_CONFIG_DIR` to a private dir
  relocates the whole config (incl. auth) → claude has no creds and won't start (spike
  failed exactly this way).
- **Worker hooks: `claude --settings <private-file>`.** Worker cwd must be the workspace,
  so the shadow's project-local-`.claude` trick would pollute the repo. `--settings`
  (confirmed in `claude --help`: "load additional settings") layers a daemon-private
  hook file on top of real `~/.claude`, repo-safe.
- **`tmux pipe-pane -o -t <name> 'cat >> <file>'`** streams pane bytes to a file
  (verified). Daemon tails it into the output store.
- **`tmux -e KEY=VAL`** env injection works (tmux 3.4) for the worker's sanitized env.
- **Spike harness limitation:** claude renders a blank pane when spawned via tmux from
  inside the Claude Code Bash tool (TERM/TTY artifact; affects plain claude too, not
  `--settings`). Hook-firing via `--settings` is therefore validated at the first real
  daemon-spawned worker, not a standalone spike.

## Reliability vs cost

| | Option A (node-pty heuristic) | Option B (tmux worker) |
|---|---|---|
| Readiness/idle detection | heuristic (quiescence) | deterministic (capture-pane) |
| Submit confirmation | none | inspect pane after send-keys |
| Consistency w/ shadow | divergent | unified |
| Survives daemon restart | no (respawn) | yes (reattach) |
| Embedded-terminal impact | none | moderate (attach/resize) |
| New runtime dependency | none | tmux (all sessions) |
| Blast radius | delivery module + wiring | session runtime + reconcile + delivery |

## Recommendation

**Option B**, if we accept tmux as a shipped runtime dependency. The shadow already
proves the mechanism, it removes the heuristic class we keep patching, unifies both
transports, and as a bonus makes restart-survival real. The cost is a bounded
session-runtime refactor concentrated in the daemon; the desktop terminal stays a
byte-passthrough over an attached pty.

Take **Option A** only if the tmux packaging dependency is unacceptable for the shipped
app, accepting permanent heuristic delivery.

## Open questions

1. **Packaging:** is tmux acceptable as a bundled/sidecar dependency for the desktop
   app, or must the shipped product avoid it? (Decisive between A and B.)
2. **Resize semantics:** one tmux client (the UI) per session — `resize-window` on
   resize, or fixed geometry like the shadow's `-x 220 -y 50`?
3. **Reattach scope:** reattach only active-run worker sessions, or all live sessions,
   on boot? Interaction with `reconcileSessionsOnBoot`.
4. **Control/UI race:** is out-of-band `send-keys` while a UI client is attached safe in
   practice (user typing vs orchestrator submitting concurrently)? Likely need a
   "who's driving" guard during orchestrator turns.
5. **Idempotency of submit:** after `send-keys Enter`, confirm via `capture-pane` that
   the input box cleared; retry-once policy if not.
