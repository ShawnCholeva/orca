# Worker Permission Modes — Phase 3: Codex (parity + capture migration)

**Date:** 2026-06-04
**Branch:** feat/worker-permission-modes (continues Phases 1A/1B/2)
**Status:** Design approved — pending spec review

## Context

Phases 1A/1B/2 delivered per-goal Auto-run / Ask-in-chat worker permission modes
**for Claude**, end-to-end, routed through a consolidated provider seam
(`ShadowProvider`) and a provider-agnostic daemon decision flow. Phase 3 brings
**Codex** to parity through that **same** system, and migrates Codex's shadow
turn-capture off pane-polling onto hooks ("Codex should use hooks like the
others").

**Hard constraint — no drift from Claude.** Codex must use the identical
daemon route, decision flow, store, mode toggle, chat card, and contract types.
The only differences are (a) the one the user chose — Codex has **no native
per-command "remember"**, so "Always allow" is hidden for Codex (Allow/Deny only)
— and (b) provider-legitimate internals (Codex's hook-file format and its capture
mode). No bespoke Codex permission path.

## What is shared and UNCHANGED (must not drift)

These already exist from Phases 1A/1B/2 and are reused verbatim for Codex:
`POST /v1/agent-hooks/permission` route; `onPermissionRequest` (auto→allow,
ask→relay+hold+deny-on-timeout, safe-deny on unknown); `PermissionApprovalStore`;
the `pendingApproval` chat message + `PermissionApprovalCard`; the per-goal mode
field + `PUT /v1/goals/:goalId/worker-permission-mode` toggle; the answer route;
the `WorkerSessionManager` → `workerHookConfig` seam. Codex plugs into all of it.

## Goals

- **Codex Auto-run / Ask-in-chat** via Codex's native `PermissionRequest` hook →
  the existing daemon route. Identical behavior to Claude.
- **Capability gating:** "Always allow" is shown only for providers that can
  persist a per-command rule. Claude → shown (unchanged). Codex → hidden.
- **Codex capture migration:** `CodexShadowProvider.captureMode()` from
  `pane-poll` to `hook`, delivering finished-turn text via the Stop hook's
  `last_assistant_message`.

## Non-Goals

- Codex per-command "remember" / native allowlist (Codex's approval model is
  global `approval_policy`, no per-command rule — `permissionRule` /
  `writePermissionRule` stay the no-ops they already are for Codex).
- Antigravity (Phase 4).
- Any change to Claude's behavior. (Claude must render and behave exactly as it
  does today after this phase.)

## Research basis (and remaining spikes)

Confirmed (Phase 1 research + Codex docs): Codex supports `hooks.json` +
`features.hooks` with a `PermissionRequest` event that fires only when approval
is needed; command-type handlers (no HTTP); 600 s timeout, blocks the turn;
decision output `{ hookSpecificOutput: { hookEventName: "PermissionRequest",
decision: { behavior: "allow" | "deny" } } }`. Codex's Stop hook stdin includes
`last_assistant_message`. Config lives in `~/.codex/config.toml` or project
`.codex/config.toml`; `CODEX_HOME` sets the state/log dir.

**Spikes to resolve during implementation (do not guess — verify against a real
Codex CLI):**
1. **Worker hook discovery:** how to point a Codex *worker* at private hook
   config without dirtying the repo workspace — `CODEX_HOME` vs writing a private
   `.codex/`. Mirror however the existing `CodexShadowProvider.hookConfig` shadow
   path already makes Codex load `.codex/config.toml` + `.codex/hooks.json`.
2. **Response-shape compatibility:** confirm Codex's `PermissionRequest` command
   hook accepts the daemon route's existing `{hookSpecificOutput:{…decision:
   {behavior}}}` JSON emitted on the curl's stdout. If Codex needs a different
   envelope, shape it **in the Codex hook command** (e.g. a tiny relay), NOT by
   changing the shared route (no drift).
3. **Capture action-block:** confirm Codex's Stop-hook `last_assistant_message`
   contains the structured `orca:step-complete` / `• {json}` action block that
   `extractCodexPaneAction` currently scrapes from the pane. If it does not,
   keep a pane fallback for *parsing* while still using the hook for
   turn-completion signaling.

## Design

### A. Codex worker permission hook

`CodexShadowProvider.workerHookConfig({ goalId, sessionId, port, authToken,
configDir })` returns the files + spawn args/env to run a Codex worker with:
- `config.toml` enabling `features.hooks`, plus `hooks.json` with:
  - `Stop` / `StopFailure` command hooks → the existing
    `/v1/agent-hooks/stop` relay (same as the shadow Codex integration).
  - a **`PermissionRequest`** command hook → `curl -fsS -X POST
    -H 'Authorization: Bearer <token>' --data-binary @-
    http://127.0.0.1:<port>/v1/agent-hooks/permission?sessionId=<id>`, which pipes
    the hook's stdin to the daemon and emits the daemon's decision JSON on stdout.
- spawn args/env that make Codex load this private config (spike #1).

The daemon route is unchanged; it already resolves the session's goal + mode and
returns the decision. (The hook command must map the Codex hook's stdin field
names to whatever the route reads — the route currently reads `tool_name`,
`tool_input`, `tool_use_id`; if Codex's PermissionRequest stdin uses different
keys, the curl/relay maps them — spike #2 — without touching the route.)

### B. "Always allow" capability gating (cross-provider, no Claude drift)

- Add a provider capability: `supportsPermissionPersistence: boolean` on
  `ShadowProvider` — Claude `true`; Codex `false`; Antigravity `false` (its real
  value lands in Phase 4).
- Add `canRemember?: boolean` to the `PendingApproval` contract. When the daemon
  posts the approval message (in `onPermissionRequest`), it sets
  `canRemember = resolveProvider(<session adapter>).supportsPermissionPersistence`.
- `PermissionApprovalCard` renders the "Always allow" button **only when
  `pending.canRemember !== false`** (so Claude — `true` or, defensively, absent —
  still shows it; Codex — `false` — hides it). Allow/Deny unchanged for both.
- Codex `permissionRule` / `writePermissionRule` remain no-ops (already true).

This is the single user-facing provider difference, and it is exactly the one the
user authorized.

### C. Codex shadow capture migration (pane-poll → hook)

- `CodexShadowProvider.captureMode()` returns `{ kind: "hook" }` (was
  `{ kind: "pane-poll", intervalMs: 1000 }`).
- The Codex shadow Stop hook delivers `last_assistant_message` to the daemon's
  shadow capture path (mirror how `ClaudeShadowProvider`'s shadow stop relay feeds
  `resolvePending`). The existing `shadow-hooks` stop route consumes it.
- `turnParser` keeps `extractActionBlock` first; retain `extractCodexPaneAction`
  as a fallback **only if** spike #3 shows the action block isn't in
  `last_assistant_message`.
- Keep `beforeSubmit` (the model-switch-prompt dismissal) — unrelated to capture.

## Error handling

- Unchanged shared paths keep their Phase 1 behavior (safe-deny on unknown/timeout).
- Codex hook/curl failure → the daemon route is not reached; Codex falls back to
  its own approval flow. Mitigate by the same long timeout the Claude hook uses.
- Capture migration: if a turn produces no `last_assistant_message` (StopFailure),
  the existing StopFailure path applies; the pane fallback (if retained) covers
  parsing gaps.

## Testing

- **Codex `workerHookConfig` (unit):** returns `config.toml` + `hooks.json`
  containing Stop/StopFailure and a `PermissionRequest` hook pointing at
  `/v1/agent-hooks/permission` with the session id + bearer; plus the spawn
  args/env for private-config discovery. Table-driven beside the Claude case.
- **Capability flag (unit):** `supportsPermissionPersistence` is `true` for Claude,
  `false` for Codex/Antigravity.
- **Contract:** `PendingApproval.canRemember` optional boolean round-trips.
- **Daemon (integration):** for an ask-mode goal on a Codex session, the posted
  `pendingApproval` has `canRemember === false`; for a Claude session, `true`. The
  permission decision flow (allow/deny/timeout) behaves identically regardless of
  provider (reuse the existing permission-flow tests, parameterized by adapter).
- **Desktop:** card hides "Always allow" when `canRemember === false`, shows it
  when `true`/absent; Allow/Deny present in both.
- **Capture (unit/integration):** Codex `captureMode()` is `hook`; a Stop-hook
  payload with `last_assistant_message` is parsed into the turn action (via
  `extractActionBlock`, or the documented fallback).

## Tradeoffs accepted

- Codex "Always allow" is unavailable by design (no native per-command rule);
  the per-goal Auto-run toggle is the "stop asking" path for Codex.
- The capture migration broadens Phase 3 into the shadow path, but it is required
  to meet the "uniformly hook-based" goal and is isolated to `CodexShadowProvider`.
- Three real spikes (hook discovery, response-shape, action-block) are resolved
  against a live Codex CLI during implementation; each has a defined fallback that
  does not compromise the no-drift constraint (any Codex-specific shaping happens
  in the Codex hook command, never in the shared route).
