# Codex hooks spike — live-CLI findings (Phase 3)

**Date:** 2026-06-04
**CLI:** `codex-cli 0.136.0` at `/usr/local/bin/codex` (auth: ChatGPT login, copied `auth.json` into scratch `CODEX_HOME`).
**Method:** All experiments in scratch temp dirs, never the repo workspace. Hooks wrote to local marker files. Interactive Codex driven via `tmux` (the same launch path Orca's `CodexShadowProvider` uses), not the daemon.

Each finding is tagged **LIVE-VERIFIED** (observed against codex 0.136.0) or **UNVERIFIED (doc-assumption)** (from https://developers.openai.com/codex/hooks, not empirically confirmed).

---

## Step 1 — Hook discovery for a worker

**Verdict (LIVE-VERIFIED): Use `CODEX_HOME=<dir>` with `<dir>/config.toml` + `<dir>/hooks.json`. Candidate (a) works.**

What was tested and confirmed:

- Set `CODEX_HOME=<scratchdir>` (a private dir, NOT in the repo workspace). Codex loads `<CODEX_HOME>/config.toml` and `<CODEX_HOME>/hooks.json` from there. `codex doctor` confirmed `CODEX_HOME`, `config.toml loaded`, `config.toml parse ok`, and `auth file` all resolve under the scratch dir.
- `config.toml` must contain:
  ```toml
  [features]
  hooks = true
  ```
  (The `hooks` feature is `stable` and already defaults to `true` per `codex features list`, but setting it explicitly matches the existing provider and is harmless.)
- `hooks.json` (the SAME JSON shape the current `buildCodexHookSettings` emits) at `<CODEX_HOME>/hooks.json` is discovered and its hooks fire. Confirmed by a `Stop` hook and a `SessionStart` hook both writing marker files during a real turn.

**CRITICAL gotcha (LIVE-VERIFIED): hooks fire ONLY in the interactive TUI, NOT under `codex exec`.**

- Running `codex exec ... "prompt"` with the identical `CODEX_HOME`/`hooks.json` produced a correct turn (model answered) but fired **zero** hooks — not `Stop`, not `SessionStart`, not `UserPromptSubmit`. Tried both `hooks.json` and inline `[[hooks.Stop]]` TOML; neither fired under `exec`.
- The same config fired hooks reliably in the **interactive** `codex` TUI (launched in tmux, exactly how Orca runs shadow sessions). So this is fine for Orca (it uses the TUI), but Task 2/5 must NOT try to validate hooks via `codex exec`.

**Exact spawn recipe for a worker-private hook config (what Task 2 must use):**

- Create a private dir, e.g. `<configDir>` (the `workerHookConfig` already receives a `configDir` arg).
- Write `<configDir>/config.toml` = `"[features]\nhooks = true\n"`.
- Write `<configDir>/hooks.json` = the JSON settings object `{ "hooks": { ... } }`.
- Copy/symlink the user's `~/.codex/auth.json` into `<configDir>/auth.json` so the worker stays authenticated (CODEX_HOME fully relocates auth too).
- Spawn codex (interactive) with env `CODEX_HOME=<configDir>`. In Orca this is a tmux env var (`tmux new-session -e CODEX_HOME=<configDir> ... codex ...`). No `.codex/` is written into the repo workspace.
- Hook trust: a newly-written `hooks.json` is untrusted. In interactive use the user is prompted to trust hooks via `/hooks`. For unattended worker spawns, pass `--dangerously-bypass-hook-trust` (used throughout this spike; emits a warning banner but runs the hooks without review). Alternatively persist trust ahead of time — NOT explored here.
- Candidate (b) — a project `.codex/` in cwd — was NOT separately needed; it is what the current `hookConfig` writes into the workspace. The whole point of `CODEX_HOME` is to keep the worker config private (out of the repo). Candidate (a) is the chosen mechanism.

**Live-verified env/args summary for Task 2:**
- env: `CODEX_HOME=<private configDir>` (and `auth.json` present inside it)
- files: `<configDir>/config.toml`, `<configDir>/hooks.json`
- spawn arg: `--dangerously-bypass-hook-trust` (for unattended worker)
- launch path: interactive `codex` (TUI), NOT `codex exec`

---

## Step 2 — PermissionRequest I/O

**All LIVE-VERIFIED** (deny AND allow round-trips observed). Triggered by launching interactive codex with `-a on-request -s read-only` and prompting it to run `echo ... > /tmp/file`, which forces an escalation/approval.

### (a) Exact stdin field names Codex sends (LIVE-VERIFIED)

Full payload observed for `hook_event_name: "PermissionRequest"`:

```json
{
  "session_id": "019e9433-...",
  "turn_id": "019e9433-...",
  "transcript_path": "<CODEX_HOME>/sessions/.../rollout-...jsonl",
  "cwd": "/private/tmp/codex-work...",
  "hook_event_name": "PermissionRequest",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "tool_name": "Bash",
  "tool_input": {
    "command": "echo orca-spike-marker > /tmp/orca-spike-touch.txt",
    "description": "Do you want to allow writing the marker file to /tmp as requested?"
  }
}
```

Field mapping for Task 2:
- **tool name key:** `tool_name` (value `"Bash"` for shell; expect `apply_patch` / `mcp__<server>__<tool>` for others).
- **tool input key:** `tool_input` (object; for Bash: `{ command, description }`. `description` is a model-supplied string, not always present).
- **call id key:** **NONE present in the live payload.** The docs claim a `tool_use_id` field, but it was **absent** in codex 0.136.0's actual PermissionRequest stdin. `turn_id` and `session_id` are present and can correlate the request to the turn/session. **Task 2 must not rely on a `tool_use_id`.**

### (b) Daemon response shape accepted on stdout? (LIVE-VERIFIED — YES, accepted as-is)

Returning this on the hook's stdout **actually blocked** the command:
```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"orca-spike-denied"}}}
```
- TUI showed `• PermissionRequest hook (blocked)` and `feedback: orca-spike-denied`; the model reported "the escalation request was rejected"; the target file was **NOT** created. So `behavior:"deny"` truly blocks.
- The `decision.message` string surfaced to the model as `feedback:`.
- The mirror test with `{"...","decision":{"behavior":"allow"}}` **permitted** the command — the file WAS written. So allow round-trips too.
- **Verdict:** the `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message"?}}}` shape is the exact, accepted contract. The hook command must emit THIS shape on stdout. If the daemon's HTTP endpoint returns a different JSON, the worker hook script must remap the daemon response into this exact envelope before writing it to stdout (the daemon's internal shape was not asserted to match 1:1 — Task 2 should map daemon decision -> this envelope explicitly).

### (c) Timeout default

- **UNVERIFIED (doc-assumption):** docs state the default hook timeout is **600 seconds** when unspecified.
- **LIVE-VERIFIED:** a per-hook `"timeout": 30` (seconds) field in `hooks.json` was accepted and the hook ran normally within it. So the `timeout` key is real and honored at the per-hook level; only the *default value* (600s) is doc-sourced. For Orca's PermissionRequest hook, set an explicit short-ish `timeout` rather than relying on the default.

---

## Step 3 — Stop-hook capture content

**Verdict (LIVE-VERIFIED): YES — `last_assistant_message` in the Stop hook payload contains the full structured action block verbatim, including the ` ```orca:action ` fences and inner JSON. The pane-poll fallback is NOT required to parse the action block.**

Evidence — a `Stop` hook logging stdin after a turn where the model emitted a fenced action block produced:

```json
{
  "session_id": "019e9431-...",
  "turn_id": "019e9432-...",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "Stop",
  "model": "gpt-5.5",
  "permission_mode": "default",
  "stop_hook_active": false,
  "last_assistant_message": "```orca:action\n{\"kind\":\"answer_user_directly\",\"body\":\"done\"}\n```"
}
```

- The decoded `last_assistant_message` value is exactly: `` ```orca:action\n{"kind":"answer_user_directly","body":"done"}\n``` `` (real newlines between fence and JSON).
- Feeding that string to the existing `extractActionBlock` (`apps/daemon/src/orchestrator-llm/sentinel.ts`, which scans for ` ```orca:action ... ``` ` and returns the trimmed inner JSON) would return `{"kind":"answer_user_directly","body":"done"}`. So the Stop-hook payload alone is sufficient for the orchestrator action-block parse.
- Plain prose turns: `last_assistant_message` = the plain text (e.g. `"PONG"`), no `•` bullet — the `•` is TUI rendering only and never appears in the hook payload.

**Implication for Task 5 (capture migration pane-poll -> hook):**
- The `Stop` hook's `last_assistant_message` is a reliable source for the action block. The current `turnParser.parseAction` first tries `extractActionBlock(turnText)`; passing `last_assistant_message` as `turnText` will work for properly-fenced blocks.
- `extractCodexPaneAction` (the `• {json}` pane-scraper) is NOT needed when consuming the hook payload, because the hook gives the clean assistant message (no `•` prefix). Retain it only if a non-hook/pane path still exists, but the hook path does not need it.
- Note: the daemon already has a `Stop` -> `/v1/shadow-hooks/stop` route that reads `last_assistant_message` (see `apps/daemon/src/shadow-hooks/routes.ts`), so the plumbing to receive this field server-side already exists.

---

## Summary table

| Spike | Verdict | Status |
|-------|---------|--------|
| 1. Discovery | `CODEX_HOME=<dir>` + `<dir>/config.toml` (`[features].hooks=true`) + `<dir>/hooks.json`; interactive TUI only (NOT `codex exec`); spawn with `--dangerously-bypass-hook-trust`; copy `auth.json` into the dir | LIVE-VERIFIED |
| 2a. PermissionRequest stdin keys | `tool_name`, `tool_input{command,description}`; NO `tool_use_id`; plus `turn_id`/`session_id` for correlation | LIVE-VERIFIED |
| 2b. Response shape | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"\|"deny","message"?}}}` accepted as-is; deny blocks, allow permits; `message`->`feedback` | LIVE-VERIFIED |
| 2c. Timeout | per-hook `timeout` (seconds) honored; default 600s | timeout key LIVE-VERIFIED; 600s default UNVERIFIED (doc) |
| 3. Stop capture | `last_assistant_message` carries the full ` ```orca:action ... ``` ` block; `extractActionBlock` parses it; pane fallback not needed | LIVE-VERIFIED |
