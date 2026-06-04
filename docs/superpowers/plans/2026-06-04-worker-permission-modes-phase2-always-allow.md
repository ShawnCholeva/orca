# Worker Permission Modes — Phase 2 ("Always Allow", Claude) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `remember: true` ("Always allow") persist an approval as a native Claude permission rule in the workspace's `.claude/settings.local.json`, matching what Claude Code's own "don't ask again" writes (program-prefix for Bash, exact path/domain for structured tools), so the action is never re-prompted again.

**Architecture:** The held approval record gains the raw `toolInput`. The provider seam gains a pure `permissionRule(toolName, toolInput)` and a `writePermissionRule(workspacePath, rule)` (Claude implements; Codex/Antigravity no-op). The answer route, on `allow` + `remember`, best-effort derives + writes the rule. The desktop card gains an "Always allow" button.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, node:fs, Vitest; React + @testing-library/react. Spec: `docs/superpowers/specs/2026-06-04-worker-permission-modes-phase2-always-allow-design.md`.

**Correctness priority:** writes go to the user's persistent, project-local config. Best-effort and non-fatal (a failure never blocks the agent); **never clobber** a malformed `settings.local.json`; dedupe; preserve existing content.

---

## Key facts (verified)

- `onPermissionRequest` (`apps/daemon/src/server.ts:1113-1125`) receives `payload.toolInput` and records `{ toolUseId, sessionId, goalId, toolName, summary }` — it does **not** currently store `toolInput`.
- `PermissionApprovalStore` (`apps/daemon/src/workflows/orchestrator/permission-approvals.ts`): `RecordApprovalInput` and `PendingPermissionApproval` (lines 3-29). `record()` spreads `...input` into the pending entry, so adding a field to both interfaces + passing it in `record({...})` is enough.
- Answer route (`apps/daemon/src/server.ts:1205-1215`): captures `const pending = permissionApprovals.get(approvalId)` at line 1209 **before** `resolveDecision` at 1211, so `pending.toolName`/`pending.toolInput`/`pending.sessionId` are available for the remember logic. `parsed.data` has `decision` and `remember`.
- `resolveShadowProvider` + `type ShadowAdapterId` are already imported in `server.ts` (Phase 1A). Adapter for a session: `SELECT adapter_id FROM sessions WHERE id = ?`. Workspace path for a goal: `SELECT w.path AS path FROM workspaces w WHERE w.goal_id = ? ORDER BY w.attached_at ASC LIMIT 1` (used at server.ts:563).
- Provider seam: `ShadowProvider` interface (`apps/daemon/src/orchestrator-llm/providers/types.ts`); implementations `claude.ts`, `codex.ts`, `antigravity.ts`. Phase 1A added `workerHookConfig` to all three — mirror that for the two new methods.
- Desktop card: `apps/desktop/src/orchestrator/PermissionApprovalCard.tsx` has `decide(decision)` calling `submitPermissionDecision(goalId, pending.approvalId, decision)`; `submitPermissionDecision(goalId, approvalId, decision, remember=false)` already accepts `remember`.
- Test commands: daemon `cd apps/daemon && pnpm vitest run <path>`; desktop `cd apps/desktop && pnpm vitest run <path>`. Daemon has 5 known pre-existing failures (startTail flake, 2× context migration 0006, suggested-orchestration, /private/tmp symlink); desktop has pre-existing `stepResult` tsc/test failures (ArtifactsList/StepTimeline/WorkflowBanner/api.test.ts). Ignore those; introduce none new. If a contract type seems missing in daemon/desktop, `cd packages/contracts && pnpm build` (do not stage dist/tsbuildinfo).

---

## Task 1: Store `toolInput` on the approval record

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/permission-approvals.ts`, `apps/daemon/src/server.ts:1122-1125`
- Test: `apps/daemon/src/workflows/orchestrator/permission-approvals.test.ts`

- [ ] **Step 1: Write the failing test** — add to `permission-approvals.test.ts`:

```ts
it("stores and returns the raw toolInput for later rule derivation", () => {
  const store = new PermissionApprovalStore(() => "x");
  store.record({ toolUseId: "t", sessionId: "s", goalId: "g", toolName: "Bash", summary: "rm -rf build", toolInput: { command: "rm -rf build" } });
  expect(store.get("x")?.toolInput).toEqual({ command: "rm -rf build" });
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd apps/daemon && pnpm vitest run src/workflows/orchestrator/permission-approvals.test.ts -t "toolInput"` → FAIL (type error / undefined).

- [ ] **Step 3: Add the field** — in `permission-approvals.ts`, add `toolInput: unknown;` to BOTH `PendingPermissionApproval` (after `summary`) and `RecordApprovalInput` (after `summary`). No other change (record spreads `...input`).

- [ ] **Step 4: Pass it from the hook** — in `apps/daemon/src/server.ts`, update the `permissionApprovals.record({...})` call (line 1122-1125) to include `toolInput`:

```ts
      const { approvalId, answered, isNew } = permissionApprovals.record({
        toolUseId: payload.toolUseId, sessionId, goalId,
        toolName: payload.toolName, summary, toolInput: payload.toolInput,
      });
```

- [ ] **Step 5: Run, verify PASS** — `cd apps/daemon && pnpm vitest run src/workflows/orchestrator/permission-approvals.test.ts` → PASS. `cd apps/daemon && pnpm tsc --noEmit` → no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/permission-approvals.ts apps/daemon/src/workflows/orchestrator/permission-approvals.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): store toolInput on held permission approvals"
```
End every commit in this plan with:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## Task 2: Provider `permissionRule` + `writePermissionRule` (Claude)

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/providers/types.ts`, `claude.ts`, `codex.ts`, `antigravity.ts`
- Test: `apps/daemon/src/orchestrator-llm/providers/permission-rule.test.ts` (create)

- [ ] **Step 1: Write the failing tests** — create `apps/daemon/src/orchestrator-llm/providers/permission-rule.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShadowProvider } from "./registry.js";

const claude = resolveShadowProvider("claude-code");

describe("permissionRule (claude)", () => {
  it("Bash → program prefix from the first token", () => {
    expect(claude.permissionRule("Bash", { command: "rm -rf build" })).toBe("Bash(rm:*)");
    expect(claude.permissionRule("Bash", { command: "  npm   test " })).toBe("Bash(npm:*)");
  });
  it("Bash with empty command → null", () => {
    expect(claude.permissionRule("Bash", { command: "   " })).toBeNull();
    expect(claude.permissionRule("Bash", {})).toBeNull();
  });
  it("Read/Edit/Write → exact file path", () => {
    expect(claude.permissionRule("Read", { file_path: "/p/a.ts" })).toBe("Read(/p/a.ts)");
    expect(claude.permissionRule("Edit", { file_path: "/p/b.ts" })).toBe("Edit(/p/b.ts)");
    expect(claude.permissionRule("Write", { file_path: "/p/c.ts" })).toBe("Write(/p/c.ts)");
  });
  it("NotebookEdit → notebook_path", () => {
    expect(claude.permissionRule("NotebookEdit", { notebook_path: "/p/n.ipynb" })).toBe("NotebookEdit(/p/n.ipynb)");
  });
  it("WebFetch → domain from url; unparseable → null", () => {
    expect(claude.permissionRule("WebFetch", { url: "https://api.github.com/x" })).toBe("WebFetch(domain:api.github.com)");
    expect(claude.permissionRule("WebFetch", { url: "not a url" })).toBeNull();
  });
  it("unknown tool / missing path → null", () => {
    expect(claude.permissionRule("Glob", { pattern: "**" })).toBeNull();
    expect(claude.permissionRule("Read", {})).toBeNull();
  });
  it("codex and antigravity return null (no writer yet)", () => {
    for (const id of ["codex", "antigravity"] as const) {
      expect(resolveShadowProvider(id).permissionRule("Bash", { command: "ls" })).toBeNull();
    }
  });
});

describe("writePermissionRule (claude)", () => {
  let ws: string;
  afterEach(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

  it("creates .claude/settings.local.json and adds the rule", () => {
    ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
    claude.writePermissionRule(ws, "Bash(rm:*)");
    const file = join(ws, ".claude", "settings.local.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).permissions.allow).toContain("Bash(rm:*)");
  });

  it("merges into existing allow, dedupes, and preserves other keys", () => {
    ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
    mkdirSync(join(ws, ".claude"), { recursive: true });
    const file = join(ws, ".claude", "settings.local.json");
    writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, model: "x" }), "utf8");
    claude.writePermissionRule(ws, "Bash(rm:*)");
    claude.writePermissionRule(ws, "Bash(rm:*)"); // dedupe
    const json = JSON.parse(readFileSync(file, "utf8"));
    expect(json.permissions.allow).toEqual(["Bash(ls:*)", "Bash(rm:*)"]);
    expect(json.model).toBe("x");
  });

  it("skips the write (never clobbers) when the file is malformed JSON", () => {
    ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
    mkdirSync(join(ws, ".claude"), { recursive: true });
    const file = join(ws, ".claude", "settings.local.json");
    writeFileSync(file, "{ not json", "utf8");
    claude.writePermissionRule(ws, "Bash(rm:*)");
    expect(readFileSync(file, "utf8")).toBe("{ not json"); // untouched
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd apps/daemon && pnpm vitest run src/orchestrator-llm/providers/permission-rule.test.ts` → FAIL (methods missing).

- [ ] **Step 3: Add the interface methods** — in `apps/daemon/src/orchestrator-llm/providers/types.ts`, add to `ShadowProvider` (after `workerHookConfig`):

```ts
  /** Native permission rule string for an "always allow" of this tool call, or null if not persistable. */
  permissionRule(toolName: string, toolInput: unknown): string | null;
  /** Persist a permission rule into the workspace's native config (best-effort). No-op if unsupported. */
  writePermissionRule(workspacePath: string, rule: string): void;
```

- [ ] **Step 4: Implement in `claude.ts`** — add imports `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";` (and `join` if not already imported), then add the methods to `ClaudeShadowProvider`:

```ts
  permissionRule(toolName: string, toolInput: unknown): string | null {
    const input = (toolInput ?? {}) as Record<string, unknown>;
    if (toolName === "Bash") {
      const cmd = typeof input.command === "string" ? input.command.trim() : "";
      const firstToken = cmd.split(/\s+/)[0] ?? "";
      return firstToken ? `Bash(${firstToken}:*)` : null;
    }
    if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
      const p = typeof input.file_path === "string" ? input.file_path : "";
      return p ? `${toolName}(${p})` : null;
    }
    if (toolName === "NotebookEdit") {
      const p = typeof input.notebook_path === "string" ? input.notebook_path : "";
      return p ? `NotebookEdit(${p})` : null;
    }
    if (toolName === "WebFetch") {
      const url = typeof input.url === "string" ? input.url : "";
      try {
        const host = new URL(url).host;
        return host ? `WebFetch(domain:${host})` : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  writePermissionRule(workspacePath: string, rule: string): void {
    const dir = join(workspacePath, ".claude");
    const file = join(dir, "settings.local.json");
    let json: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
      } catch {
        return; // malformed — never clobber the user's file
      }
    }
    const permissions = (typeof json.permissions === "object" && json.permissions !== null)
      ? (json.permissions as Record<string, unknown>)
      : {};
    const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
    if (allow.includes(rule)) return; // dedupe
    allow.push(rule);
    permissions.allow = allow;
    json.permissions = permissions;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  }
```

- [ ] **Step 5: No-op in `codex.ts` and `antigravity.ts`** — add to each:

```ts
  permissionRule(_toolName: string, _toolInput: unknown): string | null {
    return null;
  }
  writePermissionRule(_workspacePath: string, _rule: string): void {
    // No native permission-rule writer for this provider yet (future phase).
  }
```

- [ ] **Step 6: Run, verify PASS** — `cd apps/daemon && pnpm vitest run src/orchestrator-llm/providers/permission-rule.test.ts` → PASS. `cd apps/daemon && pnpm tsc --noEmit` → no new errors (adding interface methods forces all 3 providers; the no-ops satisfy that).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/types.ts apps/daemon/src/orchestrator-llm/providers/claude.ts apps/daemon/src/orchestrator-llm/providers/codex.ts apps/daemon/src/orchestrator-llm/providers/antigravity.ts apps/daemon/src/orchestrator-llm/providers/permission-rule.test.ts
git commit -m "feat(daemon): Claude permission-rule derivation + settings.local.json writer"
```

---

## Task 3: Wire `remember` into the answer route

**Files:**
- Modify: `apps/daemon/src/server.ts:1205-1215`
- Test: `apps/daemon/src/server.permission-flow.test.ts`

- [ ] **Step 1: Write the failing integration tests** — add to `apps/daemon/src/server.permission-flow.test.ts` (reuse its `buildTestServer`/`seedGoal`/`seedSession` harness; you also need a workspace row for the goal — add a `seedWorkspace(db, { goalId, path })` helper or raw insert into `workspaces` matching its schema; read the schema if unsure). The write target is `<workspacePath>/.claude/settings.local.json`, so seed the workspace `path` to a fresh tmp dir.

```ts
it("remember+allow writes the native rule into the workspace settings", async () => {
  const { app, db } = await buildTestServer();
  const ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
  seedGoal(db, { id: "g1", workerPermissionMode: "ask" });
  seedSession(db, { id: "s1", goalId: "g1", adapterId: "claude-code" });
  seedWorkspace(db, { goalId: "g1", path: ws });

  const hookPromise = app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "t1" } });
  await vi.waitFor(() => expect(listOrchestratorMessagesByGoal(db, "g1").some((m) => m.pendingApproval)).toBe(true));
  const approvalId = listOrchestratorMessagesByGoal(db, "g1").find((m) => m.pendingApproval)!.pendingApproval!.approvalId;

  await app.inject({ method: "POST", url: `/v1/goals/g1/permission-approvals/${approvalId}`, payload: { decision: "allow", remember: true } });
  await hookPromise;

  const settings = JSON.parse(readFileSync(join(ws, ".claude", "settings.local.json"), "utf8"));
  expect(settings.permissions.allow).toContain("Bash(rm:*)");
  rmSync(ws, { recursive: true, force: true });
});

it("remember+deny writes nothing", async () => {
  const { app, db } = await buildTestServer();
  const ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
  seedGoal(db, { id: "g1", workerPermissionMode: "ask" });
  seedSession(db, { id: "s1", goalId: "g1", adapterId: "claude-code" });
  seedWorkspace(db, { goalId: "g1", path: ws });
  const hookPromise = app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "t1" } });
  await vi.waitFor(() => expect(listOrchestratorMessagesByGoal(db, "g1").some((m) => m.pendingApproval)).toBe(true));
  const approvalId = listOrchestratorMessagesByGoal(db, "g1").find((m) => m.pendingApproval)!.pendingApproval!.approvalId;
  await app.inject({ method: "POST", url: `/v1/goals/g1/permission-approvals/${approvalId}`, payload: { decision: "deny", remember: true } });
  await hookPromise;
  expect(existsSync(join(ws, ".claude", "settings.local.json"))).toBe(false);
  rmSync(ws, { recursive: true, force: true });
});

it("remember with an unmapped tool succeeds and writes nothing", async () => {
  const { app, db } = await buildTestServer();
  const ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
  seedGoal(db, { id: "g1", workerPermissionMode: "ask" });
  seedSession(db, { id: "s1", goalId: "g1", adapterId: "claude-code" });
  seedWorkspace(db, { goalId: "g1", path: ws });
  const hookPromise = app.inject({ method: "POST", url: "/v1/agent-hooks/permission?sessionId=s1",
    payload: { tool_name: "Glob", tool_input: { pattern: "**" }, tool_use_id: "t1" } });
  await vi.waitFor(() => expect(listOrchestratorMessagesByGoal(db, "g1").some((m) => m.pendingApproval)).toBe(true));
  const approvalId = listOrchestratorMessagesByGoal(db, "g1").find((m) => m.pendingApproval)!.pendingApproval!.approvalId;
  const res = await app.inject({ method: "POST", url: `/v1/goals/g1/permission-approvals/${approvalId}`, payload: { decision: "allow", remember: true } });
  await hookPromise;
  expect(res.statusCode).toBe(200);
  expect(existsSync(join(ws, ".claude", "settings.local.json"))).toBe(false);
  rmSync(ws, { recursive: true, force: true });
});
```

Add the needed imports to the test file: `mkdtempSync, rmSync, readFileSync, existsSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `listOrchestratorMessagesByGoal` if not already imported.

- [ ] **Step 2: Run, verify FAIL** — the remember+allow test fails (no settings file written).

- [ ] **Step 3: Implement the wiring** — in `apps/daemon/src/server.ts`, replace the answer route's Phase-1 NOTE line (line 1213: `// NOTE: parsed.data.remember ... not yet acted on.`) with the best-effort remember-write, placed AFTER the `if (!ok)` 409 check and BEFORE `return { ok: true }`:

```ts
    if (parsed.data.decision === "allow" && parsed.data.remember) {
      try {
        const adapterId = (db.prepare("SELECT adapter_id FROM sessions WHERE id = ?").get(pending.sessionId) as { adapter_id: string } | undefined)?.adapter_id ?? "claude-code";
        const provider = resolveShadowProvider(adapterId as ShadowAdapterId);
        const rule = provider.permissionRule(pending.toolName, pending.toolInput);
        if (rule) {
          const wsRow = db.prepare("SELECT w.path AS path FROM workspaces w WHERE w.goal_id = ? ORDER BY w.attached_at ASC LIMIT 1").get(goalId) as { path: string } | undefined;
          if (wsRow) provider.writePermissionRule(wsRow.path, rule);
        }
      } catch (err) {
        console.warn("[permission] always-allow rule write failed", err);
      }
    }
```

(`pending` is the object captured at line 1209 before `resolveDecision`; `resolveShadowProvider` and `ShadowAdapterId` are already imported.)

- [ ] **Step 4: Run, verify PASS** — `cd apps/daemon && pnpm vitest run src/server.permission-flow.test.ts` → PASS (existing + 3 new). `cd apps/daemon && pnpm tsc --noEmit` → no new errors.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.permission-flow.test.ts
git commit -m "feat(daemon): write native permission rule on always-allow (best-effort)"
```

---

## Task 4: Desktop "Always allow" button

**Files:**
- Modify: `apps/desktop/src/orchestrator/PermissionApprovalCard.tsx`
- Test: `apps/desktop/src/orchestrator/PermissionApprovalCard.test.tsx`
- Modify (style): `apps/desktop/src/orchestrator/orca-chat.css`

- [ ] **Step 1: Write the failing test** — add to `PermissionApprovalCard.test.tsx`:

```tsx
it("calls submitPermissionDecision with allow + remember=true when Always allow is clicked", async () => {
  const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
  render(<PermissionApprovalCard goalId="g1" pending={pending} />);
  fireEvent.click(screen.getByText("Always allow"));
  await waitFor(() => {
    expect(submitPermissionDecisionMock).toHaveBeenCalledWith("g1", "a1", "allow", true);
  });
});

it("Allow sends remember=false (or omitted)", async () => {
  const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
  render(<PermissionApprovalCard goalId="g1" pending={pending} />);
  fireEvent.click(screen.getByText("Allow"));
  await waitFor(() => {
    const call = submitPermissionDecisionMock.mock.calls[0];
    expect(call[0]).toBe("g1"); expect(call[1]).toBe("a1"); expect(call[2]).toBe("allow");
    expect(call[3] ?? false).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd apps/desktop && pnpm vitest run src/orchestrator/PermissionApprovalCard.test.tsx -t "Always allow"` → FAIL (no such button).

- [ ] **Step 3: Implement** — in `PermissionApprovalCard.tsx`, change `decide` to accept `remember` and pass it through, and add the third button.

Change the `decide` signature + call:
```tsx
  async function decide(decision: "allow" | "deny", remember = false) {
    setSubmitting(true);
    setError(null);
    try {
      await submitPermissionDecision(goalId, pending.approvalId, decision, remember);
      setDecided(decision);
    } catch {
      setError("That decision could not be submitted — the request may have expired.");
    } finally {
      setSubmitting(false);
    }
  }
```

In the actions block, add the "Always allow" button after the Allow button (before Deny):
```tsx
        <button type="button" className="orca-chat-approval-always" disabled={locked} onClick={() => void decide("allow", true)}>
          Always allow
        </button>
```

The existing Allow button stays `onClick={() => void decide("allow")}` (remember defaults false).

- [ ] **Step 4: Run, verify PASS** — `cd apps/desktop && pnpm vitest run src/orchestrator/PermissionApprovalCard.test.tsx` → PASS (existing 5 + 2 new). The earlier "calls ... with allow" test asserts `toHaveBeenCalledWith("g1","a1","allow")` — with the new 4-arg signature, that test now receives a 4th arg `false`. Update that existing assertion to `toHaveBeenCalledWith("g1", "a1", "allow", false)` and the deny one to `("g1","a1","deny",false)`.

- [ ] **Step 5: Add a style** — append to `apps/desktop/src/orchestrator/orca-chat.css`:

```css
.orca-chat-approval-always { font-size: 12px; padding: 3px 12px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.2); background: transparent; color: inherit; cursor: pointer; }
.orca-chat-approval-always:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 6: Typecheck + commit** — `cd apps/desktop && pnpm tsc --noEmit` → only pre-existing stepResult errors.

```bash
git add apps/desktop/src/orchestrator/PermissionApprovalCard.tsx apps/desktop/src/orchestrator/PermissionApprovalCard.test.tsx apps/desktop/src/orchestrator/orca-chat.css
git commit -m "feat(desktop): Always allow button on the permission approval card"
```

---

## Final Verification

- [ ] **Daemon gates:** `cd apps/daemon && pnpm vitest run src/workflows/orchestrator/permission-approvals.test.ts src/orchestrator-llm/providers/permission-rule.test.ts src/server.permission-flow.test.ts && pnpm tsc --noEmit` → PASS / no new errors.
- [ ] **Desktop gates:** `cd apps/desktop && pnpm vitest run src/orchestrator/PermissionApprovalCard.test.tsx && pnpm tsc --noEmit` → PASS / only pre-existing stepResult errors.
- [ ] **Manual smoke:** Ask-in-chat goal, real workspace. Trigger a non-allowlisted Bash command → card shows Allow / Always allow / Deny. Click **Always allow** → agent proceeds AND `<workspace>/.claude/settings.local.json` gains `Bash(<prog>:*)`. Run the same program again → no card (allowed by native eval before the hook fires).

## Spec coverage check

- Store `toolInput` → Task 1.
- `permissionRule` (Bash prefix, path, domain, null) → Task 2.
- `writePermissionRule` (create/merge/dedupe/preserve/skip-malformed) → Task 2.
- Answer-route best-effort wiring (allow+remember only; non-fatal) → Task 3.
- "Always allow" button → Task 4.
- Codex/Antigravity no-op → Task 2. Deny never persists → Task 3 test. Unknown tool allow-once → Task 3 test.
