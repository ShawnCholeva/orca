# Orchestrator Shadow-Session Hook Transport — Design

**Date:** 2026-05-29
**Status:** Approved design, pre-implementation.
**Scope:** Replace the orchestrator-LLM shadow-session transport. The shipped implementation drove an interactive `claude` PTY and **scraped stdout** for a fenced JSON block; that does not work (a TUI emits ANSI redraws, not JSON) — every orchestrator turn hung for 60s then 500'd, and orphaned `claude` processes leaked. This design replaces stdout-scraping with **Stop/StopFailure hook capture**, and makes the chat reply **sync or async based on the orchestrator adapter's execution mode**.
**Supersedes (in part):** the transport/capture mechanics of `docs/superpowers/plans/2026-05-29-orchestrator-shadow-session-wiring.md` (the `ShadowSessionManager.ask` stdout-poll). The surrounding pieces (`OrchestratorLlmClient`, `OrchestratorMediator`, `buildContext`, `composePrompt`, `sentinel.extractActionBlock`, the chat usecase shell) are retained and re-pointed.

## Context

Orca's orchestrator-LLM is the user-selected model that mediates the chat surface and judges step completion (see `docs/superpowers/specs/2026-05-28-orchestrator-mediated-workflows-design.md`). For Claude on a Pro/Max subscription the design requires **interactive Claude Code** (subscription auth, no `ANTHROPIC_API_KEY`); `claude -p` and the Agent SDK are billed differently (see "Billing context" below).

The first implementation attempted interactive-but-scraped-stdout, which is the wrong capture mechanism. Verification spikes (2026-05-29) proved the correct mechanism:

- **`CLAUDE_CONFIG_DIR` relocation loses login** → cannot isolate via a private config dir; must use a **project `.claude/settings.local.json`** with the default `~/.claude` auth.
- A **`Stop` hook fires in both `-p` and interactive mode**, and its stdin JSON payload contains **`session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `last_assistant_message`** (the full response text). So the daemon receives the response directly — no transcript parsing needed in the common case.
- A daemon can **drive an interactive `claude` PTY**: write `prompt + \r` to submit; answer the folder-trust prompt with `\r`. `StopFailure` exists for failure-stops.
- Claude Code supports a native **`http` hook type** (`{"type":"http","url":"…"}`) — the hook can POST the daemon directly, no shell/curl.

## Billing context (why interactive, not -p/SDK)

Effective **2026-06-15**, Claude Agent SDK and `claude -p` usage "no longer counts toward your Claude plan's usage limits"; instead a separate monthly credit applies (Pro = **$20/mo**), **priority-drain then standard API rates** (i.e. metered, then pay-as-you-go). **Interactive Claude Code remains on the flat subscription** (rate-limited, not dollar-metered). So an interactive shadow session is the only programmatic path that rides the flat Pro plan. `one_shot` providers (OpenAI/Gemini via SDK, or `claude -p` if ever enabled) are the metered paths and are used synchronously.

## Goals

- Claude orchestrator turns run as a **persistent interactive `claude` session per goal**, on the flat subscription, with responses captured via **Stop/StopFailure hooks** — never by scraping stdout.
- Chat send is **non-blocking for shadow_session** (async, streamed via SSE) and **synchronous for one_shot** providers.
- No 500s on the chat path; no orphaned/leaked `claude` processes.
- Reuse the existing `OrchestratorLlmClient` / `OrchestratorMediator` / `buildContext` / `composePrompt` / `sentinel` layer unchanged.

## Non-Goals

- Changing the orchestrator's reasoning, prompts, or `OrchestratorAction` contract (only the transport + sync/async dispatch change).
- Implementing the Agent SDK transport (interactive subscription is preferred; SDK is a possible future `one_shot`-style provider).
- Enriching `buildContextFromDb` with active-run step/agent-turn context (still a documented follow-up from the prior plan).
- Multi-workspace selection for the per-step agent (unrelated).

## Concepts

- **Shadow session**: a persistent interactive `claude` PTY, one per goal, that the daemon drives. Runs in a **daemon-private dir** (`~/.orca/shadow/<goalId>/`), not the user's repo (the orchestrator-LLM only reasons; it never edits files).
- **Stop / StopFailure hooks**: Claude Code hooks installed in the shadow dir's `.claude/settings.local.json`; on each response they POST the daemon with `last_assistant_message`.
- **Pending resolver**: a per-goal promise the daemon registers when it writes a prompt to the PTY; the hook POST resolves it.
- **Execution mode** (`adapter_execution_modes`): `shadow_session` (claude, default, async) or `one_shot` (openai/gemini/`-p`, sync).

## Architecture

### Transport selection

The chat reply and the mediator both call `OrchestratorLlmClient.request(...)`. The **chat response contract** branches on the goal's orchestrator adapter mode (`stepDispatch.resolveMode(adapterId)` / `adapter_execution_modes`):

```
resolveMode(orchestratorAdapterId):
  one_shot       → SYNCHRONOUS: provider.complete (SDK) → reply returned in the POST: {message, reply}
  shadow_session → ASYNC:       enqueue prompt to the goal's shadow PTY → return {message, reply: null};
                                the Stop hook later delivers the reply → daemon posts the orchestrator
                                message → existing orchestrator.message.created SSE updates the UI.
```

The mediator path (`onAgentResponseDone`, agent-response judgement) is always async by nature for shadow_session (it already posts via the message-insert + SSE path; it does not return to an HTTP caller).

### Shadow session (claude interactive)

Per goal:

1. **Daemon-private dir** `~/.orca/shadow/<goalId>/` (created if absent), containing `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop":        [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:<daemonPort>/v1/orchestrator-hooks/stop?goalId=<goalId>" } ] } ],
    "StopFailure": [ { "hooks": [ { "type": "http", "url": "http://127.0.0.1:<daemonPort>/v1/orchestrator-hooks/stop?goalId=<goalId>&failure=1" } ] } ]
  }
}
```

`<daemonPort>` is the daemon's bound port (known at server start). `goalId` in the query is the correlation key.

> Implementation note: if the native `http` hook type does not POST the hook's stdin JSON as the request body in this CLI version, fall back to a `command` hook running a tiny bundled script that reads stdin JSON and POSTs it (the spike used a `command` hook and confirmed the payload). The plan MUST verify the `http` body shape first and choose accordingly.

2. **Spawn** a persistent interactive `claude` PTY (no `-p`) with `cwd = ~/.orca/shadow/<goalId>/`, default `~/.claude` auth (subscription), and a **no-tools / restricted permission posture** (the orchestrator only reasons + emits JSON — it must not edit files). Pre-trust the dir (write the trusted-folder marker) or detect+answer the folder-trust prompt on first boot (mirror the M9 hidden-worker driver's ready/permission detection in `orchestration-transport/hidden-worker/drivers/claude.ts`).

3. **Readiness gate**: before spawning, `ClaudeCodeAdapter.checkAuth()`; if not logged in / not installed, do **not** spawn — surface a clear "sign in to Claude Code" system/chat message.

### `ask(goalId, prompt)` (replaces stdout-poll)

```
ensure shadow session for goalId (auto-spawn if absent; readiness-gated)
serialize per goal (FIFO; one outstanding prompt at a time)
register a pending resolver for goalId (with a timeout, default 120s)
write prompt + "\r" to the PTY
return the resolver's promise
```

The resolver is settled by the hook endpoint (success → resolve with text; `failure=1` → reject) or by the timeout (reject + kill/respawn the session).

### Hook endpoint

`POST /v1/orchestrator-hooks/stop?goalId=<goalId>[&failure=1]`

- Body (from the hook): `{ session_id, transcript_path, last_assistant_message, hook_event_name, ... }`.
- Handler: `ShadowSessionManager.resolvePending(goalId, { failure, text: last_assistant_message })`.
  - Success: `extractActionBlock(last_assistant_message)` (orchestrator wraps its JSON action in ```` ```orca:action ````); if no block, apply the no-parseable-action policy (below).
  - `failure=1`: reject the pending resolver with a failure.
- **Unknown goalId or no pending resolver** → `200` no-op (drop). This makes stray/duplicate Stop POSTs harmless.

### Response parsing

`extractActionBlock` (existing `sentinel.ts`) runs on `last_assistant_message` (clean hook text, not scraped stdout). The orchestrator system prompt already appends `SENTINEL_INSTRUCTION`. No-parseable-action handling: one re-prompt nudge to the same session ("emit only the fenced ```orca:action JSON block"); if still none → graceful escalation (async: post an orchestrator escalation message; sync one_shot path keeps the existing 409 provider-unavailable mapping).

## Data flow (shadow chat turn)

```
user clicks Send
  → POST /v1/goals/:id/orchestrator-messages
      inserts user message (orchestrator.message.created → SSE: message appears)
      resolveMode == shadow_session → returns { message, reply: null }   (composer frees; "thinking" shown)
      (background) ask(goalId, prompt): ensure PTY, write prompt+\r, register resolver
  → claude responds → Stop hook → POST /v1/orchestrator-hooks/stop?goalId
      extractActionBlock(last_assistant_message) → resolve pending resolver
  → mediator applies the OrchestratorAction (answer_user_directly / forward_to_agent / …)
      → posts orchestrator message (orchestrator.message.created → SSE: reply appears, "thinking" clears)
```

## Lifecycle

- **Spawn**: on demand (first `ask` for a goal). No boot-time resume spawn (that caused the leak).
- **Idle timeout**: kill the persistent session after N minutes idle; next `ask` auto-respawns.
- **Terminate**: on terminal run events (`workflow.run.completed|failed|cancelled|blocked`) and on goal archive (existing wiring retained).
- **Daemon restart**: PTYs die; sessions respawn lazily on next `ask`. No storm.
- **Wedge recovery**: a resolver timeout kills + respawns that goal's session.

## Failure handling

| Failure | Behavior |
|---|---|
| Stop hook never arrives (hang/crash) | resolver timeout (~120s) → reject → "orchestrator unavailable" message; kill + respawn session |
| `StopFailure` hook fires | reject pending resolver → escalate as failure |
| `last_assistant_message` has no `orca:action` block | one re-prompt nudge; still none → graceful escalation (async msg) / 409 (sync); never 500 |
| Claude not installed / not logged in | readiness gate before spawn → clear "sign in" message; no spawn, no hang |
| Folder-trust / permission prompt | pre-trust dir or detect+answer; orchestrator runs no-tools to minimize prompts |
| Unknown goalId / stray Stop POST | endpoint 200 no-op (dropped) |
| PTY exits unexpectedly | session removed; next `ask` auto-respawns |

## Components / files

**Daemon:**
- `apps/daemon/src/orchestrator-llm/shadow-session.ts` — **rewrite `ask`**: remove stdout polling; add per-goal daemon-private dir, hook-settings install, interactive spawn (no `-p`, no-tools, trust handling), readiness gate, FIFO `ask` writing `prompt+\r` + registering a pending resolver, `resolvePending(goalId, {failure,text})`, idle timeout, terminate.
- `apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts` (new) — builds `.claude/settings.local.json` content (Stop + StopFailure hooks, goalId+port URL); chooses `http` vs `command` hook per the verified payload behavior.
- `apps/daemon/src/orchestrator-hooks/routes.ts` (new) — `POST /v1/orchestrator-hooks/stop`; parse body + query; call `resolvePending`.
- `apps/daemon/src/orchestrator-chat/usecases.ts` — branch on `resolveMode(orchestratorAdapter)`: one_shot → sync SDK `complete`; shadow_session → insert message, `reply:null`, fire background `ask` whose resolved action posts the orchestrator message.
- `apps/daemon/src/server.ts` — register the hook endpoint wired to the shared `ShadowSessionManager`; provide the daemon port to the hook-URL builder; remove boot-resume shadow spawn; keep terminate-on-terminal/archive.

**Desktop:**
- `apps/desktop/src/orchestrator/OrcaChat.tsx` — per-goal "thinking" indicator while an async turn is in flight; clears on the next `orchestrator.message.created` SSE for the goal. (Send already returns immediately for `reply:null`.)

**Unchanged:** `shadow-llm-client.ts`, `mediator.ts`, `prompts.ts`, `build-context.ts`, `sentinel.ts`.

## Testing

- **ShadowSessionManager** (FakePty + simulated hook): `ask` resolves with the extracted action when `resolvePending` is called; resolver timeout → reject + session killed; `StopFailure` → reject; idle timeout kills; terminate kills + removes; auto-respawn on `ask` after exit.
- **Hook endpoint**: POST with goalId + `last_assistant_message` → resolves the correct pending resolver; `failure=1` → rejects; unknown goalId → 200 no-op.
- **Chat usecase**: one_shot mode → synchronous reply (SDK); shadow_session mode → `{message, reply:null}` and a background `ask` whose resolution posts an orchestrator message (assert the message-insert/SSE path fires).
- **Sentinel reuse**: `extractActionBlock` on `last_assistant_message` containing prose around the fenced block.
- **Readiness**: spawn attempted when not logged in → clear error, no hang, no PTY.
- **Integration** (fake pty + simulated hook POST): `mediator.invoke` resolves end-to-end via the hook path.

## Open questions (resolve at plan time)

- **Native `http` hook body shape** — confirm the CLI POSTs the hook stdin JSON as the request body; if not, use a `command` hook with a tiny stdin→POST script (spike-verified path). The plan's first task verifies this.
- **No-tools / restricted spawn flags** — exact `claude` flags or settings to disable tool use and suppress permission prompts for the orchestrator session (it only emits text). Confirm against Claude Code settings docs.
- **Folder pre-trust mechanism** — write the trusted-folder marker into `~/.claude` for the daemon-private dir vs detect+answer the prompt. Pick one in the plan.
- **Idle-timeout duration** — default (e.g. 10 min) to balance warm-session speed vs idle process cost.
