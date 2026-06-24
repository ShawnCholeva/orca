# Governed Axis — Deferred Work / Follow-ups

Companion to `2026-06-23-governed-axis.md`. The Governed axis shipped to `main` (merges `af378b1` + `0f0179b`) as **Tasks 1–8 + 10**. This file tracks what was deliberately deferred, with enough context to resume without re-recon.

Status legend: 🔴 blocked-on-external-info · 🟡 deferred-by-decision · ⚪ intentional non-change

---

## 🔴 1. Task 9 — Antigravity `PermissionRequest` hook (the one OPEN coverage gap)

**Why deferred:** verified NEEDS_CONTEXT — the antigravity (`agy`) CLI hook wire format is undocumented and unverifiable in-repo. Guessing risked shipping a non-functional gate (false containment).

**Impact (important):** the governed gate is hook-driven (`onPermissionRequest` → `/v1/agent-hooks/permission`). With no hook wired, an **antigravity worker spawns ungated** — no risk classification, no `tool_gate` transition, no safety floor. It **fails open**. claude-code and codex ARE fully gated; nothing else in the branch assumes antigravity is gated. If antigravity workers are run in `automated` mode before this is closed, that is an ungoverned path.

**What's needed from a human / the `agy` source (the 4 unknowns):**
1. The permission hook **event name** antigravity exposes (`PermissionRequest`? `PreToolUse`? a `request-review` location? — repo docs contradict each other).
2. The **hook-file JSON shape** for a permission hook, and the on-disk path/filename `agy` reads. (Antigravity's only existing hook — the shadow `Stop` relay — uses `{ "<name>": { Stop: [{type,command,timeout}] } }`, which is DIFFERENT from Codex's `{ hooks: { PermissionRequest: [...] } }`, so Codex is NOT a safe template for the shape.)
3. The **discovery mechanism**: how `agy` is told to load hooks (env var / CLI flag / cwd convention). Codex uses `CODEX_HOME` env + `--dangerously-bypass-hook-trust` + `config.toml`; Claude uses `--settings`. Antigravity's `launch()` returns **bin-only** (no args/env), and no test ever launches `agy` (tests invoke the relay script directly), so there is NO in-repo proof `agy` reads `.agents/hooks.json` at all.
4. The **stdout decision schema** `agy` expects from the hook (and any native allow-list format for persistence).

**Recon already done (don't repeat):**
- Codex template: `apps/daemon/src/orchestrator-llm/providers/codex.ts` — `workerHookConfig` (~50-73) + `buildCodexWorkerHookSettings` (~161-202). Wires `Stop`/`StopFailure`/`PermissionRequest` to `/v1/agent-hooks/permission?sessionId=...` with a 1800s timeout; returns `{ files:[{relPath,contents}], copyFiles?, spawnArgs, env? }` (type at `adapters/types.ts`-adjacent `types.ts:64-75` for the ShadowProvider).
- Antigravity stub: `apps/daemon/src/orchestrator-llm/providers/antigravity.ts` — `workerHookConfig` (~40-42) returns `{ files: [], spawnArgs: [] }`; `permissionRule`/`writePermissionRule` (~44-50) are no-ops; `supportsPermissionPersistence = false` (~19); existing `buildAntigravityHookSettings` (~90-102) wires only the shadow `Stop` relay (`.agents/hooks.json` + `.agents/orca-stop-hook.cjs`).
- **Export name gotcha:** the plan's draft Task 9 test imports a non-existent `antigravityShadowProvider`. The real export is the **class** `AntigravityShadowProvider` (`antigravity.ts:15`); instantiate `new AntigravityShadowProvider()` or use `resolveShadowProvider("antigravity")`.
- There is **no** shared `hook-settings.ts` helper (plan refs one that doesn't exist); Codex and antigravity each inline their builders.
- Existing test: `apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts` (tests launch/captureMode/Stop-relay only). `worker-hook-config.test.ts:69` currently asserts antigravity returns the empty stub — that assertion must flip when Task 9 lands.

**Resume:** once the 4 unknowns are answered, implement `workerHookConfig` to wire the permission hook (mirroring Codex's resolver wiring but in antigravity's own file format/discovery mechanism), flip the `worker-hook-config.test.ts` assertion, add a test that the produced config references the permission resolver, keep `permissionRule`/`writePermissionRule` no-ops (document that always-allow won't persist for antigravity until a native allow-list format exists).

---

## 🟡 2. Unify the global supervision setting as "default for future goals" (D-DRAIN follow-ups)

Decision this run: the in-goal `operating_mode` flip is goal-scoped; the global setting was left as-is for back-compat. Two pieces were explicitly deferred:

**2a. New-goal default from the global orchestrator setting.** Today `migrations/0041` hardcodes the `operating_mode` column DEFAULT to `'human_review'`, and goal creation doesn't read the global setting. Wire goal-creation (`createGoal`) so a new goal inherits its `operating_mode` from the global orchestrator-tab setting (the "default for future goals" model the user described).

**2b. `/v1/settings` global flip → default-only (stop draining existing goals).** Today the global supervision flip to `unsupervised` still calls `continueAllPausedSteps()` with **no goalId** → it drains parked steps for EVERY goal, including goals set to `human_review` (`confirmStep` does not re-check mode). For the "global = default only" model, the global flip should NOT force-confirm existing goals' parked steps. (The goal-scoped drain on the per-goal flip already exists and is correct — `continueAllPausedSteps(db, now, opts, goalId)`.)

Both are in `apps/daemon/src/server.ts` (`/v1/settings` route + `/v1/goals/:goalId` create path) and `apps/daemon/src/workflows/orchestrator/service.ts`.

---

## 🟡 3. Smaller hardening / polish (low priority)

- **`gate_approval_counts` retention / unbounded growth:** the table grows one row per `(goal_id, action_class)`; consider cleanup on goal archive (no current reaper). Low concern.
- **Coverage:** a route-level test for the `canRemember` advertise + the relaxation `GoalDecision` (module-level tests exist; the resolve-route wiring is covered only by inspection + the new throw-test). Add if touching that route again.

---

## ⚪ 4. Intentional non-changes (documented so they're not "fixed" by mistake)

- **`classify.ts` `\bnc\b` over-match:** the network pattern matches a bare `nc` token, which over-escalates benign uses. Left as-is — it errs in the **fail-safe** direction (over-escalation, not under), consistent with the safety-floor intent. Only tighten if false-positive escalations become a real annoyance, and carefully.
- **`operator:agent:claude-code` double-namespaced risk label (Task 8):** `riskLabels: ["operator:" + chosen.id]` where `chosen.id` is already `agent:`-prefixed. This is **intentional** per the plan's "minimal wiring proof, don't invent a taxonomy" — producer (`service.ts`/`human-review.ts`) and the test matcher use the identical expression, so it's self-consistent. Only revisit if/when a real risk taxonomy for workflow operators is defined (then change producer + matcher together).
- **`autonomyLevel`** column: superseded by `operating_mode`, deliberately NOT removed (SQLite column drops are messy; it's already inert). Documented non-removal.

---

## Done this run (NOT outstanding — listed to avoid re-doing)

Accountability writes try/catch hardening, `http-surface` + `human-review` test-timeout stabilization, the stale `z.record` contracts comment, the `continueAllPausedSteps` goalId doc, `sandbox.test.ts` reference-identity assertion, and gate-decision/permission-gate coverage locks were all completed in the hardening+polish batch (`0f0179b`).
