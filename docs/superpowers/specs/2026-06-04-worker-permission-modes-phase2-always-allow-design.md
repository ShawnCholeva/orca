# Worker Permission Modes — Phase 2: "Always Allow" (Claude)

**Date:** 2026-06-04
**Branch:** feat/worker-permission-modes (continues Phases 1A/1B)
**Status:** Design approved — pending spec review

## Context

Phases 1A (daemon) and 1B (desktop UI) are implemented and committed on this
branch — **not yet merged to `main`** — delivering per-goal Auto-run / Ask-in-chat
worker permission modes for Claude, end-to-end. In Ask-in-chat, a residual
tool-permission request is relayed
to the Orca chat as an **Allow / Deny** card; the answer route already accepts a
`remember: boolean` on `SubmitPermissionDecisionRequest` but **ignores it**.

Phase 2 makes `remember` act: an **"Always allow"** action persists the approval
as a **native** Claude permission rule in the workspace's
`.claude/settings.local.json`, so the same action is never re-prompted again — in
Orca or the bare Claude CLI.

## Goal

- Add an "Always allow" path that writes a native Claude permission rule matching
  what Claude Code's own "Yes, and don't ask again" would write, so behavior is
  identical whether the rule was added via Orca or the bare CLI.
- Granularity = **program prefix** (the native CLI's behavior): Bash →
  `Bash(<first-token>:*)`; structured tools → exact path/domain.

## Non-Goals

- Codex / Antigravity native-config writers (their phases; their provider methods
  no-op for now).
- Persisting **deny** decisions (only `allow` + `remember` writes a rule).
- Replicating Claude's full internal prefix heuristic — Orca uses a simple,
  predictable first-token prefix for Bash.
- A per-click scope chooser ("allow once / exact / program") — the per-goal
  Auto-run toggle already covers blanket trust; YAGNI.
- Any new contract/schema (the `remember` field already exists).

## Design

### 1. Store the tool input for rule derivation (daemon)

`onPermissionRequest` (server.ts) currently records
`{ toolUseId, sessionId, goalId, toolName, summary }` in `PermissionApprovalStore`.
The truncated `summary` is for display, not reliable for building a rule. Add the
raw structured `toolInput` (the hook payload's `tool_input`, already received by
`onPermissionRequest`) to the stored approval record
(`RecordApprovalInput` / `PendingPermissionApproval` gain `toolInput: unknown`).
The card payload (`pendingApproval`) is unchanged — `toolInput` stays daemon-side.

### 2. Rule derivation — provider-owned, pure, testable

Add to the provider seam (`ShadowProvider`, consistent with the consolidation
principle) a pure method:

```ts
permissionRule(toolName: string, toolInput: unknown): string | null;
```

**Claude implementation:**
- `Bash` with a non-empty `command` → `Bash(<firstToken>:*)`, where `firstToken`
  is the first whitespace-delimited word of the trimmed command (the program).
  Empty/whitespace command → `null`.
- `Read` | `Edit` | `Write` | `NotebookEdit` with a string `file_path` →
  `<toolName>(<file_path>)`. Missing path → `null`.
- `WebFetch` with a parseable `url` → `WebFetch(domain:<host>)` (host via URL
  parse). Unparseable → `null`.
- Anything else → `null` (allow once, persist nothing).

**Codex / Antigravity:** return `null` for now (their writers land in their phases).

### 3. Native-config writer — provider-owned

Add to the provider seam:

```ts
writePermissionRule(workspacePath: string, rule: string): void;
```

**Claude implementation** writes to `<workspacePath>/.claude/settings.local.json`:
- Read the file if present; parse JSON. **If parsing fails, skip the write** (do
  not clobber the user's file) and let the caller treat it as a non-fatal miss.
- Ensure `permissions.allow` is an array; **append `rule` only if not already
  present** (dedupe).
- Create `<workspacePath>/.claude/` and the file if missing (mkdir recursive).
- Write back pretty-printed JSON, preserving all other keys/content.

**Codex / Antigravity:** no-op for now.

(Keeping `permissionRule` pure and separate from `writePermissionRule` makes rule
derivation unit-testable without filesystem.)

### 4. Wire into the answer route (daemon)

In `POST /v1/goals/:goalId/permission-approvals/:approvalId`, after the decision
is resolved and **only when** `decision === "allow"` and `remember === true`:
1. Read the pending approval's `toolName` + `toolInput` (captured before
   `resolveDecision` consumes the entry — read it first).
2. Resolve the session's adapter → provider; resolve the goal's workspace path
   (first workspace, as `workerSpawn` does:
   `SELECT w.path FROM workspaces w WHERE w.goal_id = ? ORDER BY w.attached_at ASC LIMIT 1`).
3. `rule = provider.permissionRule(toolName, toolInput)`; if `rule`, call
   `provider.writePermissionRule(workspacePath, rule)`.
4. **All of this is best-effort and non-fatal:** any failure (no workspace,
   `rule === null`, fs/JSON error) is caught and logged; the answer route still
   returns success because the one-time allow already happened.

Note: because Claude consults `settings.local.json` *before* our `PermissionRequest`
hook fires (native eval → then the hook), once `Bash(rm:*)` is written, future
`rm` calls are allowed at the native step and never reach our hook or the chat —
exactly the intended "never ask again."

### 5. Desktop — "Always allow" button

`PermissionApprovalCard` gains a third action **"Always allow"** that calls
`submitPermissionDecision(goalId, pending.approvalId, "allow", true)`. The
existing **Allow** sends `remember` defaulted to `false`; **Deny** unchanged. All
three lock + show the decided status after click, as today.

## Data flow

1. Ask-in-chat residual request → chat shows Allow / Deny / Always allow.
2. User clicks **Always allow** → POST `{ decision: "allow", remember: true }`.
3. Answer route resolves the held hook → "allow" (agent proceeds) → best-effort
   writes `Bash(<prog>:*)` (or path/domain rule) to the workspace's
   `.claude/settings.local.json`.
4. Future matching calls are auto-allowed by Claude's native eval — no hook, no
   card.

## Error handling

- `rule === null` (unmapped/empty) → allow once, no write, no error surfaced.
- No workspace for goal → allow once, no write, logged.
- `settings.local.json` malformed → skip write (never clobber), logged.
- fs error (perms) → allow once, logged; not surfaced as a decision failure.

## Testing

- **`permissionRule` (unit):** Bash first-token (`rm -rf build` → `Bash(rm:*)`),
  multi-word program first token, empty command → null; Read/Edit/Write path →
  `Read(/p)`; missing path → null; WebFetch url → `WebFetch(domain:host)`;
  unparseable url → null; unknown tool → null.
- **`writePermissionRule` (unit):** creates dir+file; appends to existing
  `permissions.allow`; dedupes; preserves other keys; skips on malformed JSON
  (existing content untouched).
- **Answer route (integration):** `remember:true`+allow writes the derived rule to
  the goal's workspace settings; `remember:true`+deny writes nothing; `remember`
  with an unmapped tool → 200, no write; missing workspace → 200, no write.
- **Desktop:** the "Always allow" button calls `submitPermissionDecision` with
  `("g","a","allow",true)`; Allow still sends `remember` false/absent.

## Tradeoffs accepted

- Program-prefix breadth (approving one `rm` allows all `rm`) — deliberately
  matches the native CLI; the per-goal Auto-run toggle and hand-editing
  `settings.local.json` remain the escape hatches.
- The write targets the workspace's project-local, git-ignored
  `settings.local.json` (not user-global) — scoped to where the work happens.
- Best-effort writes: a persistence failure never blocks the agent; worst case the
  user is asked again next time.
