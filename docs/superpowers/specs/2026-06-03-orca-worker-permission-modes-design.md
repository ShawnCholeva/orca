# Orca Worker Tool-Permission Modes

**Date:** 2026-06-03
**Branch:** (new — to be created at implementation time; not the chat-startup-feedback branch)
**Status:** Design — pending user review

## Problem

When a workflow step's agent (a "worker" — a Claude Code / Codex / Antigravity
CLI running in an unattended background tmux pane) runs a tool that requires
permission and that tool is **not** already on the workspace's native allow-list,
the CLI shows a native interactive permission prompt in its pane. Nobody is
watching that pane, so the agent blocks there forever. It never reaches its
Stop hook, so the daemon never paraphrases anything into the Orca chat, and the
chat sits on the "starting…" indicator indefinitely.

**Evidence (goal `209d98d0`, "Check result of Step 1"):** the worker
(`orca-worker-24b23c90`) received its prompt, ran allow-listed commands
(`git grep`, file reads — auto-approved via the inherited `~/.claude`
allow-list), then hit `find … -exec …` which is **not** allow-listed → native
prompt → wedged. `orchestrator_messages` for that goal: **0 rows**. Run + step
still `active`.

Root cause: workers are spawned with no permission handling for tools outside
the native allow-list. `apps/daemon/src/adapters/claude-code.ts` returns
`args: []` and `WorkerSessionManager` writes a hook settings file containing only
`Stop`, `StopFailure`, and `PreToolUse` matched on `AskUserQuestion`. There is no
catch-all permission gate, so any not-yet-approved tool deadlocks the worker.

A secondary structural problem surfaced while diagnosing this: the **worker**
launch path is Claude-specific and bypasses the consolidated provider system the
**shadow** sessions use (see Architecture §1).

## Goals

- Per-goal choice between two worker permission modes, **toggleable live in the
  Orca chat** and honored at the agent's next tool call:
  - **Auto-run** — workers run their tools without asking; never deadlocks.
  - **Ask-in-chat** — when a worker hits a tool that isn't already approved
    natively, an Allow / Deny / Always-allow card appears in the Orca chat and
    the worker waits for the decision.
- **Respect each CLI's existing native approvals** — already-approved tools run
  silently in both modes; only residual (would-otherwise-prompt) actions surface.
- **All three providers** (Claude Code, Codex, Antigravity) go through **one
  consolidated provider abstraction** — no provider gets a bespoke worker path.
- Make the worker session system **uniformly hook-based**, including migrating
  Codex turn-capture off pane-polling onto hooks (it's the only pane-poller).
- "Always allow" persists the decision into the workspace's **native** CLI
  config so it never re-prompts again — in Orca or the bare CLI.

## Non-Goals

- No change to the orchestrator **shadow** session's purpose or its turn-parsing
  (other than the Codex capture-mode migration described later).
- No autonomy-level wiring. The existing `goal.autonomyLevel` field stays unused
  for behavior; this feature uses a dedicated mode field instead.
- No Orca-maintained permission allow-list / permission-rule evaluation. We rely
  entirely on each CLI's native residual-permission event, so we never reimplement
  or import permission rules. (This was the "Strategy A" alternative; the research
  spike made it unnecessary — see §2.)
- No change to how the initial step prompt is delivered.

## Research Spike Findings

All three CLIs expose a **residual-only** permission hook — one that fires *only*
when the CLI would otherwise show an interactive prompt, i.e. **after** its own
allow-list has been consulted. This is the linchpin: subscribing to that event
lets us intercept exactly the actions that would deadlock, while already-approved
actions run untouched. No pane-parsing, no rule reimplementation.

| Capability | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Residual-only permission hook | `PermissionRequest` — fires when the prompt would show | `PermissionRequest` — "only when about to ask for approval, respecting sandbox/approval config" | `PreToolUse` under `request-review` mode |
| Decision output shape | `hookSpecificOutput.decision.behavior = "allow"\|"deny"` (+`updatedInput`) | `hookSpecificOutput.decision.behavior = "allow"\|"deny"` | stdout JSON `permissionDecision = "allow"\|"deny"\|"ask"` |
| Hook handler type | HTTP (Bearer + per-hook `timeout`) **or** command | command only (default 600 s; blocks the turn while deciding) | command (script reading JSON stdin, writing JSON stdout) |
| Turn-capture today in Orca | hook | **pane-poll** (to be migrated → hook) | hook |
| Stop hook carries turn text | yes (`last_assistant_message`) | yes (`last_assistant_message`) | yes (relay script) |
| Native bypass flag (fallback, not used) | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` |

Notes / validation items carried into implementation:
- **Claude fallthrough:** if our hook fails to return a decision within its
  timeout, Claude treats it as a non-blocking error and *continues* — which lands
  on the native prompt → deadlock. So the daemon MUST always return an explicit
  decision before the hook timeout (see §5, timeout handling).
- **Codex hook reliability:** Orca currently pane-polls Codex for *capture*
  despite Codex having hooks, so Codex's hook behavior in this tmux setup needs a
  validation pass when we wire its `PermissionRequest`.
- **Antigravity `request-review` edge:** a public report notes
  `PreToolHookResult` overwrite misbehaving under `toolPermission=request-review`;
  validate during the Antigravity phase.

Sources: Codex hooks (`developers.openai.com/codex/hooks`), Codex approvals
(`developers.openai.com/codex/agent-approvals-security`), Claude Code hooks
(`code.claude.com/docs/en/hooks`), Antigravity hooks
(`antigravity.google/docs/hooks`), Antigravity CLI usage
(`antigravity.google/docs/cli-using`).

## Architecture

### 1. Consolidate the worker launch path onto the provider abstraction

Today, shadow sessions resolve a `ShadowProvider` from
`orchestrator-llm/providers/registry.ts` and `shadow-session.ts` writes
`provider.hookConfig().files` uniformly across providers. Workers do **not** use
this — `WorkerSessionManager` hardcodes Claude's `buildAgentHookSettings` +
`--settings`.

Extend the consolidated provider abstraction to own **worker** hook injection,
then refactor the worker launcher to consume it:

- Add a worker hook-config method to the provider (generalize `ShadowProvider`
  into a shared `AgentProvider`, or add `workerHookConfig({ goalId, sessionId,
  port, authToken })` alongside `hookConfig()`). It returns the files to write
  **and** any spawn arguments / env the launcher must apply, because providers
  differ in how hooks are injected:
  - Claude: a private settings file + `--settings <path>` (keeps the workspace
    clean — the current repo-safe approach).
  - Codex: `.codex/config.toml` (`[features] hooks = true`) + `.codex/hooks.json`
    (placed under a private `CODEX_HOME`, not the repo).
  - Antigravity: `.agents/hooks.json` + a node relay script (placed under a
    private agents dir).
- `WorkerSessionManager.spawn` writes `provider.workerHookConfig(...).files` and
  applies its spawn args/env, instead of calling `buildAgentHookSettings`
  directly. The provider is resolved from the registry by the session's
  `adapter_id`.

This makes workers provider-aware and is the seam every later provider plugs
into. It is a standalone improvement (workers stop being Claude-only) independent
of the permission feature.

### 2. One permission gate per provider → the daemon

Each provider's `workerHookConfig` includes a **catch-all residual-permission
hook** (Claude/Codex `PermissionRequest`; Antigravity `PreToolUse` under
`request-review`) that calls the daemon at a single endpoint
`POST /v1/agent-hooks/permission?sessionId=<id>`:

- Claude: an HTTP hook with `Authorization: Bearer <token>` and a long `timeout`.
- Codex/Antigravity: a command/relay hook that `curl`s the same endpoint with the
  hook's stdin JSON piped (`--data-binary @-`), mirroring the existing Codex Stop
  hook and Antigravity relay script.

The endpoint is provider-agnostic in its logic; only the **response JSON shape**
is mapped per provider by a small per-provider serializer (the provider owns it).

### 3. Decision flow

`POST /v1/agent-hooks/permission`:
1. Resolve `goal_id` from the session row (as the elicit route already does).
2. Read `goal.worker_permission_mode`.
3. **`auto`** → return `allow` immediately (shaped per provider).
4. **`ask`** →
   a. Record a pending approval in an in-memory store (reusing the
      `WorkerQuestionStore` pattern: dedupe by tool-use id, hold a `resolve`).
   b. Post an `orchestrator` chat message carrying a `pendingApproval` payload
      (the chat renders the approval card).
   c. Await the user's decision or the hold timeout (§5), then return the shaped
      `allow`/`deny`.

This reuses the exact hold-open + chat-message + answer-route machinery already
built for `AskUserQuestion` elicitation (`worker-questions.ts`, the
`/worker-questions/:id/answer` route, `WorkerQuestionForm` in the UI).

## Data Model

### Contracts (`packages/contracts/src`)

- `Goal` gains `workerPermissionMode: z.enum(["ask", "auto"]).default("ask")`.
- `OrchestratorChatMessage` gains an optional `pendingApproval`:
  ```ts
  pendingApproval: z.object({
    approvalId: z.string(),
    sessionId: z.string(),
    toolName: z.string(),           // e.g. "Bash"
    summary: z.string(),            // one-line human description, e.g. the command
    detail: z.string().optional(),  // full command / args, for an expandable view
  }).optional()
  ```
- New request schema for answering: `SubmitPermissionDecisionRequest`:
  ```ts
  z.object({ decision: z.enum(["allow", "deny"]), remember: z.boolean().default(false) })
  ```
- New SSE event payloads (mirroring the existing orchestrator/message events) so
  the UI refreshes when an approval is posted, resolved, or the mode changes.

### Database (`apps/daemon/src/migrations.ts`, `goals.ts`)

- Migration: `ALTER TABLE goals ADD COLUMN worker_permission_mode TEXT NOT NULL
  DEFAULT 'ask';`
- `goals.ts` row mapping reads/writes `worker_permission_mode` ↔
  `workerPermissionMode`.

Pending approvals are **in-memory only** (like worker questions) — they are tied
to a live held hook connection, so they do not survive a daemon restart (the hook
would have timed out anyway).

## Daemon Components

- **Provider abstraction + registry** (`orchestrator-llm/providers/*`): add
  `workerHookConfig(...)` and a `shapePermissionResponse(decision)` per provider.
- **`WorkerSessionManager`** (`workflows/orchestrator/worker-session.ts`):
  consume `workerHookConfig` from the registry; drop the hardcoded
  `buildAgentHookSettings`.
- **`PermissionApprovalStore`**: a near-clone of `WorkerQuestionStore` (record /
  get / resolve, dedupe by tool-use id).
- **`/v1/agent-hooks/permission`** route (`agent-hooks/routes.ts`): the decision
  flow in Architecture §3.
- **`/v1/goals/:goalId/permission-approvals/:approvalId`** answer route: validates
  goal scope (as the worker-question answer route does), resolves the held hook
  with allow/deny, and on `remember:true` invokes the provider's native-config
  writer.
- **Native-config writers** (per provider, in the provider implementation):
  append the approved rule to the workspace's native config — Claude
  `.claude/settings.local.json` `permissions.allow` (`Bash(<cmd>:*)`,
  `Read(<path>)`, …); Codex/Antigravity equivalents.
- **Mode toggle**: extend the goal-update path (or a dedicated
  `PUT /v1/goals/:goalId/worker-permission-mode`) to set the column and emit an
  SSE event. The mode is read fresh on every permission-hook call, so a live
  toggle is honored at the agent's next tool call with no respawn.

## Desktop UI (`apps/desktop/src/orchestrator/OrcaChat.tsx`)

- **Mode toggle**: a small segmented control ("Auto-run / Ask-in-chat") in the
  chat header bound to `goal.workerPermissionMode`, calling the toggle endpoint;
  reflects live via SSE.
- **Approval card**: rendered for messages whose `pendingApproval` is set —
  shows `toolName` + `summary` (with an expandable `detail`), and **Allow**,
  **Deny**, **Always allow** buttons that POST the decision route. Modeled on the
  existing `WorkerQuestionForm` (submitting/disabled/expired states included).

## Timeout & Error Handling

- The held approval resolves on user action, or — per the chosen policy ("keep
  waiting long, then deny") — after a long hold window set just under the hook's
  own timeout (Claude: configurable, set high e.g. 1800 s; Codex: 600 s max). On
  expiry the daemon returns an explicit **deny** with a reason, never a silent
  allow. Returning a decision before the hook timeout is mandatory for Claude to
  avoid the fallthrough-to-native-prompt deadlock (Research §).
- Unknown session / missing goal → return `allow` with a logged warning is
  **unsafe**; instead return `deny` with a reason ("Orca could not resolve this
  session"), matching the safe-by-default posture. (The existing elicit route
  returns a permissive reason for questions; permissions invert that default.)
- Duplicate hook fire (same tool-use id) reuses the existing pending approval and
  does not post a second card (the `WorkerQuestionStore` dedupe pattern).
- Native-config write failure on "Always allow" → still honor the one-time allow;
  surface a non-blocking note that the rule could not be persisted.

## Per-Provider Implementation Notes

- **Claude Code:** `PermissionRequest` HTTP hook, matcher `"*"`; response
  `{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior}}}`.
  Native-config writer → `.claude/settings.local.json` `permissions.allow`.
- **Codex:** `PermissionRequest` command hook curling the endpoint; response
  shaped to Codex's `decision.behavior`. **Also migrate capture pane-poll → hook**
  (see "Codex Capture Migration"). Native-config writer → Codex approval/allow config.
- **Antigravity:** `PreToolUse` command hook (node relay) under `request-review`;
  stdout `permissionDecision`. Native-config writer → Antigravity allow-list.
  Validate the `request-review` overwrite edge.

## Codex Capture Migration (pane-poll → hook)

Codex's Stop hook stdin includes `last_assistant_message`, like Claude. Migrate
`CodexShadowProvider.captureMode()` from `{kind:"pane-poll"}` to `{kind:"hook"}`,
have its Stop hook POST the `last_assistant_message` (as Claude's shadow stop
relay does), and route capture through the hook path in `shadow-session.ts`.
**Validation item:** confirm `last_assistant_message` reliably contains the
structured action block that `extractCodexPaneAction` currently scrapes from the
pane; if the action block is rendered only in the TUI and not in the message
text, keep a pane fallback for parsing while still using the hook for
turn-completion signaling. Keep `beforeSubmit` (the model-switch-prompt
dismissal) — that's unrelated to capture.

## Testing

- **Contracts:** schema round-trips for the new `Goal` field, `pendingApproval`,
  and `SubmitPermissionDecisionRequest`.
- **Daemon (unit):** `/permission` returns `allow` in `auto` mode without posting
  a message; in `ask` mode records an approval, posts a `pendingApproval`
  message, and resolves `allow`/`deny` when the answer route is called; denies on
  timeout; dedupes duplicate tool-use ids; denies on unknown session.
  Per-provider response shaping. Native-config writer appends the expected rule.
- **Daemon (provider seam):** `WorkerSessionManager` writes the files/args from
  `workerHookConfig` for each provider id (table-driven).
- **Codex capture:** turn text harvested via the Stop hook path; action block
  parsed from `last_assistant_message` (or the documented fallback).
- **Desktop:** the mode toggle renders the goal's current mode and calls the
  endpoint; the approval card renders from a `pendingApproval` message and posts
  the decision; "Always allow" sends `remember:true`.

## Phased Delivery

Each phase is its own implementation plan and produces working, testable software.

1. **Seam + Claude core.** Provider abstraction owns worker hook config;
   `WorkerSessionManager` consumes it; `goal.worker_permission_mode` + migration;
   Claude `PermissionRequest` hook; `/permission` endpoint + relay + answer route;
   mode toggle UI + Allow/Deny approval card. *Outcome: the deadlock is gone on
   Claude and the live per-goal toggle works.*
2. **Always-allow (Claude).** The `remember` path + Claude native-config writer.
3. **Codex.** Codex `workerHookConfig` + `PermissionRequest` shaping + native
   writer, **plus** the capture pane-poll→hook migration (see "Codex Capture Migration").
4. **Antigravity.** Antigravity `workerHookConfig` + `PreToolUse` shaping + native
   writer; validate the `request-review` edge.

## Tradeoffs Accepted

- Pending approvals are in-memory; a daemon restart drops them (acceptable — the
  hook connection dies on restart regardless).
- A permission round-trip to the daemon per *residual* tool call (not per tool
  call — already-approved actions never reach the hook), so the overhead is
  bounded to genuinely-new actions.
- "Safe by default": unknown session and timeout both **deny**. This can stall an
  agent that's left unattended in Ask-in-chat mode — by design; Auto-run is the
  unattended-friendly mode.
- The Codex capture migration broadens scope slightly into the shadow path, but
  it is required to meet the "uniformly hook-based" goal and is isolated to phase 3.
