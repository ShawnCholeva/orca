# Worker Permission Modes — Phase 3 (Codex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Codex to parity with Claude on worker permission modes — Auto-run / Ask-in-chat via Codex's native `PermissionRequest` hook through the **same** daemon decision flow — with "Always allow" hidden for Codex (no native per-command rule), and migrate Codex's shadow turn-capture from pane-poll to hooks.

**Architecture:** Codex plugs into the existing provider seam + daemon route (no drift). Phase adds: a Codex `workerHookConfig`, a provider `supportsPermissionPersistence` capability surfaced as `PendingApproval.canRemember` (gates the "Always allow" button), and `CodexShadowProvider.captureMode` → `hook`.

**Tech Stack:** TypeScript, Fastify, Vitest, Codex CLI (hooks.json + features.hooks). Spec: `docs/superpowers/specs/2026-06-04-worker-permission-modes-phase3-codex-design.md`.

**No-drift rule:** Do NOT change the shared `/v1/agent-hooks/permission` route, `onPermissionRequest` decision logic, `PermissionApprovalStore`, the mode toggle, or Claude's behavior. Any Codex-specific shaping lives in the Codex hook command, never the shared route. After this phase, Claude must render + behave exactly as before.

---

## Key facts (verified)

- Provider seam: `ShadowProvider` (`apps/daemon/src/orchestrator-llm/providers/types.ts`) with `workerHookConfig`, `permissionRule`, `writePermissionRule`, `captureMode`, `turnParser`, `hookConfig`. `CodexShadowProvider` (`codex.ts`) currently: `hookConfig` writes `.codex/config.toml` (`[features]\nhooks = true`) + `.codex/hooks.json` (Stop/StopFailure command hooks curling `/v1/shadow-hooks/stop`); `captureMode` returns `{kind:"pane-poll",intervalMs:1000}`; `permissionRule`/`writePermissionRule` are no-ops.
- Claude worker hooks: `buildAgentHookSettings` (`apps/daemon/src/agent-hooks/hook-settings.ts`) includes a `PermissionRequest` HTTP hook → `permissionHookUrl(port,sid)` = `/v1/agent-hooks/permission?sessionId=…`. The daemon route returns `{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"|"deny"}}}`.
- Capture: `shadow-session.ts` `ask()` sets up pane-polling ONLY when `captureMode().kind === "pane-poll"`; hook-based providers rely on their Stop hook POSTing `last_assistant_message` to `/v1/shadow-hooks/stop` → `resolvePending(goalId,{text,failure})`, which runs `turnParser`. Codex's existing Stop hook already curls `/v1/shadow-hooks/stop` with `--data-binary @-` (pipes the hook stdin, which includes `last_assistant_message`).
- `onPermissionRequest` (`server.ts`) posts the `pendingApproval` message; it resolves the session adapter via `SELECT adapter_id FROM sessions WHERE id=?` and `resolveShadowProvider` is imported.
- `PendingApproval` contract: `packages/contracts/src/index.ts` (strict object: approvalId, sessionId, toolName, summary, detail?).
- Desktop card: `apps/desktop/src/orchestrator/PermissionApprovalCard.tsx` renders Allow / Always allow / Deny.
- Test cmds: daemon `cd apps/daemon && pnpm vitest run <p>`; contracts `cd packages/contracts && pnpm vitest run`; desktop `cd apps/desktop && pnpm vitest run <p>`. Rebuild contracts (`cd packages/contracts && pnpm build`) after contract changes; never stage dist/tsbuildinfo. Known pre-existing failures (ignore, add none): daemon (startTail, context-migration-0006×2, suggested-orchestration, /private/tmp symlink); desktop (stepResult fixtures + api.test.ts).

---

## Task 1: Spike — verify Codex hooks against a live CLI

**This is an investigation task. It produces findings (recorded in a notes file) that Tasks 2 and 5 depend on. No production code.** Use a real Codex CLI (`codex`, or `$ORCA_CODEX_BIN`). If no Codex CLI is available in the environment, STOP and report BLOCKED — Tasks 2 and 5 must not be guessed.

**Files:** Create `docs/superpowers/notes/2026-06-04-codex-hooks-spike.md`.

- [ ] **Step 1: Hook discovery for a worker.** Determine how to make a Codex process load a *private* hooks config without writing into the repo workspace. Test candidates in order: (a) `CODEX_HOME=<dir>` with `<dir>/config.toml` + `<dir>/hooks.json`; (b) a project `.codex/` in the cwd. Run a trivial Codex invocation with a `Stop` hook that writes a marker file; confirm which mechanism fires it. Record the working mechanism + exact file paths + any required spawn env/args.

- [ ] **Step 2: PermissionRequest I/O.** Configure a `PermissionRequest` command hook that pipes its stdin to a local script logging the JSON, and returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}` on stdout. Trigger a tool call that needs approval. Record: (a) the exact stdin field names Codex sends (tool name / input / id keys), (b) whether returning the daemon's response shape on stdout is accepted (deny actually blocks), (c) the timeout default.

- [ ] **Step 3: Stop-hook capture content.** With a `Stop` hook logging its stdin, run a Codex turn that emits the orchestrator action block. Record whether `last_assistant_message` contains the structured `orca:step-complete` / `• {json}` action block (so `extractCodexPaneAction`/`extractActionBlock` can parse it from the hook), or whether the action block only appears in the TUI pane (→ retain pane fallback for parsing).

- [ ] **Step 4: Write findings + commit**

Record Steps 1–3 conclusions (the chosen discovery mechanism + exact paths/env, the stdin field mapping, the response-shape verdict, the capture verdict) in the notes file.
```bash
git add docs/superpowers/notes/2026-06-04-codex-hooks-spike.md
git commit -m "docs: Codex hooks spike findings (Phase 3)"
```
End commits with:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## Task 2: Codex `workerHookConfig` (PermissionRequest hook)

**Depends on Task 1 findings (discovery mechanism + stdin field mapping + response-shape).**

**Files:** Modify `apps/daemon/src/orchestrator-llm/providers/codex.ts`; Test: `apps/daemon/src/orchestrator-llm/providers/worker-hook-config.test.ts` (extend the existing Claude case).

- [ ] **Step 1: Write the failing test** — add a Codex case asserting `resolveShadowProvider("codex").workerHookConfig({goalId,sessionId,port,authToken,configDir})` returns files including a `config.toml` (with `features` hooks enabled), a `hooks.json` containing Stop/StopFailure AND a `PermissionRequest` hook whose command targets `/v1/agent-hooks/permission?sessionId=<sid>` with the bearer token, plus the spawn args/env that Task 1 determined are needed for discovery. Assert the exact file relPaths + that the PermissionRequest command string contains `permission?sessionId=` and the token. (Mirror the structure of the existing Claude assertion in this file.)

- [ ] **Step 2: Run, verify FAIL** — `cd apps/daemon && pnpm vitest run src/orchestrator-llm/providers/worker-hook-config.test.ts -t "codex"`.

- [ ] **Step 3: Implement `CodexShadowProvider.workerHookConfig`.** Build on the existing `buildCodexHookSettings` (its Stop/StopFailure curl pattern) — add a `PermissionRequest` command hook that pipes stdin to the daemon and emits the response. Skeleton (fill the discovery + field-mapping specifics from Task 1):

```ts
  workerHookConfig(args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) {
    const permUrl = `http://127.0.0.1:${args.port}/v1/agent-hooks/permission?sessionId=${encodeURIComponent(args.sessionId)}`;
    // curl pipes the hook's stdin to the daemon and emits the decision JSON on stdout.
    const permCommand = [
      "curl", "-fsS", "-X", "POST",
      "-H", shellArg(`Authorization: Bearer ${args.authToken}`),
      "-H", shellArg("Content-Type: application/json"),
      "--data-binary", "@-",
      shellArg(permUrl),
    ].join(" ");
    const hooks = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: /* existing stop curl */ }] }],
        StopFailure: [{ hooks: [{ type: "command", command: /* existing stop?failure=1 curl */ }] }],
        PermissionRequest: [{ hooks: [{ type: "command", command: permCommand }] }],
      },
    };
    return {
      files: [
        { relPath: /* per Task 1 */ "config.toml", contents: "[features]\nhooks = true\n" },
        { relPath: /* per Task 1 */ "hooks.json", contents: JSON.stringify(hooks, null, 2) },
      ],
      spawnArgs: [], // or per Task 1
      env: { /* e.g. CODEX_HOME: args.configDir — per Task 1 */ },
    };
  }
```
If Task 1 found Codex's `PermissionRequest` stdin uses different field names than the route reads (`tool_name`/`tool_input`/`tool_use_id`), insert a tiny inline relay (a `node -e` or shell `jq` step) in `permCommand` that remaps before curling — **do not change the shared route**. Reuse the file's existing `shellArg` helper.

- [ ] **Step 4: Run, verify PASS** — `cd apps/daemon && pnpm vitest run src/orchestrator-llm/providers/worker-hook-config.test.ts` and `pnpm tsc --noEmit`.

- [ ] **Step 5: Commit**
```bash
git add apps/daemon/src/orchestrator-llm/providers/codex.ts apps/daemon/src/orchestrator-llm/providers/worker-hook-config.test.ts
git commit -m "feat(daemon): Codex worker PermissionRequest hook (parity with Claude)"
```

---

## Task 3: Capability flag + `canRemember` (daemon + contract)

**Files:** `packages/contracts/src/index.ts`; `apps/daemon/src/orchestrator-llm/providers/types.ts`, `claude.ts`, `codex.ts`, `antigravity.ts`; `apps/daemon/src/server.ts` (`onPermissionRequest`). Tests: contracts test, provider test, `server.permission-flow.test.ts`.

- [ ] **Step 1: Failing tests.**
  - Contract: extend the worker-permission-modes contract test — `PendingApproval` accepts optional `canRemember: boolean` and round-trips.
  - Provider: a test asserting `resolveShadowProvider("claude-code").supportsPermissionPersistence === true` and `codex`/`antigravity` === `false`.
  - Integration (`server.permission-flow.test.ts`): for an ask-mode goal on a **claude-code** session, the posted `pendingApproval.canRemember === true`; on a **codex** session, `=== false`. (Reuse `insertSessionWithWorkspace` with `adapterId`.)

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Add the capability** — in `types.ts` add `readonly supportsPermissionPersistence: boolean;` to `ShadowProvider`. Set `= true` in `ClaudeShadowProvider`, `= false` in `CodexShadowProvider` and `AntigravityShadowProvider`.

- [ ] **Step 4: Contract** — add `canRemember: z.boolean().optional()` to `PendingApproval` in `packages/contracts/src/index.ts` (keep `.strict()`); rebuild contracts (`cd packages/contracts && pnpm build`).

- [ ] **Step 5: Daemon sets it** — in `server.ts` `onPermissionRequest`, when building the `pendingApproval` payload for `insertMessageWithEvent`, add `canRemember`. Resolve the provider for the session's adapter (the function already has `sessionId`; query `adapter_id` and `resolveShadowProvider`), e.g.:
```ts
        const adapterId = (db.prepare("SELECT adapter_id FROM sessions WHERE id = ?").get(sessionId) as { adapter_id: string } | undefined)?.adapter_id ?? "claude-code";
        const canRemember = resolveShadowProvider(adapterId as ShadowAdapterId).supportsPermissionPersistence;
```
and include `canRemember` in the `pendingApproval: { approvalId, sessionId, toolName, summary, canRemember }`.

- [ ] **Step 6: Run, verify PASS** — the 3 suites + `pnpm tsc --noEmit` (daemon) clean; `cd packages/contracts && pnpm vitest run` green.

- [ ] **Step 7: Commit**
```bash
git add packages/contracts/src/index.ts apps/daemon/src/orchestrator-llm/providers/types.ts apps/daemon/src/orchestrator-llm/providers/claude.ts apps/daemon/src/orchestrator-llm/providers/codex.ts apps/daemon/src/orchestrator-llm/providers/antigravity.ts apps/daemon/src/server.ts apps/daemon/src/server.permission-flow.test.ts packages/contracts/src/__tests__/worker-permission-modes.test.ts apps/daemon/src/orchestrator-llm/providers/*.test.ts
git commit -m "feat: provider permission-persistence capability surfaced as pendingApproval.canRemember"
```

---

## Task 4: Desktop — hide "Always allow" when `canRemember === false`

**Files:** `apps/desktop/src/orchestrator/PermissionApprovalCard.tsx`; Test: `PermissionApprovalCard.test.tsx`.

- [ ] **Step 1: Failing tests** — add:
```tsx
it("hides Always allow when the provider cannot persist (canRemember false)", async () => {
  const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
  render(<PermissionApprovalCard goalId="g1" pending={{ ...pending, canRemember: false }} />);
  expect(screen.getByText("Allow")).toBeInTheDocument();
  expect(screen.getByText("Deny")).toBeInTheDocument();
  expect(screen.queryByText("Always allow")).toBeNull();
});

it("shows Always allow when canRemember is true or absent (Claude unchanged)", async () => {
  const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
  const { rerender } = render(<PermissionApprovalCard goalId="g1" pending={{ ...pending, canRemember: true }} />);
  expect(screen.getByText("Always allow")).toBeInTheDocument();
  rerender(<PermissionApprovalCard goalId="g1" pending={pending} />); // absent
  expect(screen.getByText("Always allow")).toBeInTheDocument();
});
```
(`pending` in this file has no `canRemember`, representing the absent/Claude-default case.)

- [ ] **Step 2: Run, verify FAIL** (the hide test fails — button still shows).

- [ ] **Step 3: Implement** — wrap the "Always allow" button in `{pending.canRemember !== false && (…)}`:
```tsx
        {pending.canRemember !== false && (
          <button type="button" className="orca-chat-approval-always" disabled={locked} onClick={() => void decide("allow", true)}>
            Always allow
          </button>
        )}
```

- [ ] **Step 4: Run, verify PASS** — `cd apps/desktop && pnpm vitest run src/orchestrator/PermissionApprovalCard.test.tsx`; `pnpm tsc --noEmit` (only pre-existing stepResult errors).

- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/orchestrator/PermissionApprovalCard.tsx apps/desktop/src/orchestrator/PermissionApprovalCard.test.tsx
git commit -m "feat(desktop): hide Always allow for providers that can't persist (Codex)"
```

---

## Task 5: Codex shadow capture migration (pane-poll → hook)

**Depends on Task 1 Step 3 finding (action-block in `last_assistant_message`?).**

**Files:** `apps/daemon/src/orchestrator-llm/providers/codex.ts`; Test: a codex provider/shadow test.

- [ ] **Step 1: Failing test** — assert `resolveShadowProvider("codex").captureMode()` returns `{ kind: "hook" }` (not pane-poll). If Task 1 Step 3 showed `last_assistant_message` carries the action block, also assert `turnParser().parseAction(<sample last_assistant_message with the block>)` returns the action.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — change `CodexShadowProvider.captureMode()` to `return { kind: "hook" };`. Confirm the Codex Stop hook (from `hookConfig`, the shadow path) already POSTs the hook stdin (incl. `last_assistant_message`) to `/v1/shadow-hooks/stop` — it does (existing curl `--data-binary @-`); verify the shadow-hooks stop route extracts `last_assistant_message` as the turn text and calls `resolvePending` (mirror how the Claude shadow stop is handled — read `apps/daemon/src/shadow-hooks/routes.ts`; if Codex needs the same extraction Claude gets, it's already shared). Keep `turnParser` with `extractActionBlock` first; **only if** Task 1 Step 3 showed the block is NOT in `last_assistant_message`, keep `extractCodexPaneAction` as a documented fallback (and leave a minimal pane re-read for parsing). Keep `beforeSubmit`.

- [ ] **Step 4: Run, verify PASS** — the new test + `cd apps/daemon && pnpm vitest run src/orchestrator-llm/` + `pnpm tsc --noEmit`. Confirm existing Codex shadow tests still pass (if any assert pane-poll behavior, update them to the hook path).

- [ ] **Step 5: Commit**
```bash
git add apps/daemon/src/orchestrator-llm/providers/codex.ts <codex test file>
git commit -m "feat(daemon): Codex shadow capture via hooks (no more pane-polling)"
```

---

## Final Verification

- [ ] `cd packages/contracts && pnpm vitest run` → green.
- [ ] `cd apps/daemon && pnpm vitest run && pnpm tsc --noEmit` → green except the known pre-existing failures; no new ones.
- [ ] `cd apps/desktop && pnpm vitest run src/orchestrator/ && pnpm tsc --noEmit` → green except pre-existing stepResult.
- [ ] **No-drift check:** the shared `/v1/agent-hooks/permission` route, `onPermissionRequest` decision logic, and the Claude `workerHookConfig`/card behavior are unchanged by this phase (diff them). A Claude goal still shows Allow / Always allow / Deny and persists rules exactly as in Phase 2.
- [ ] **Manual smoke (Codex):** a Codex-operator goal in Ask-in-chat → a non-allowlisted tool surfaces an Allow / Deny card (NO "Always allow"); Allow proceeds; Auto-run toggle runs free. Shadow Codex turns are captured (chat updates) without pane-polling.

## Spec coverage check

- Codex Auto-run/Ask-in-chat via PermissionRequest hook → Tasks 1, 2.
- Capability gating (Codex = Allow/Deny only; Claude unchanged) → Tasks 3, 4.
- Capture migration → Tasks 1(step 3), 5.
- No drift → enforced per task (shared route/flow untouched; Codex shaping in the hook command) + final no-drift check.
- Spikes resolved against a live Codex CLI → Task 1 (gates 2 & 5; BLOCKED if no CLI).
