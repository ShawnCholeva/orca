# Brainstorm Phase 3: Done Persistence + Spec Confirmation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Done step persists the design as a markdown spec under `.orca/specs/`, the user reviews/adjusts it before the step completes, and the run ends with an explicit closing summary instead of finishing silently.

**Architecture (decisions locked in spec §6):** The Done **agent** authors and writes the spec file with its own tools (spec docs are large/complex markdown — unfit for routing through structured step output); the **daemon** gives it the workspace list, forces a confirmation pause so the user can review/adjust, then verifies the file landed and posts a closing summary. This reuses the existing supervised-completion checkpoint (`pauseForConfirmation`/`confirmStep` + chat-revision→`forward_to_agent`); the only new behavior is forcing that pause for `handoff` steps regardless of global supervision mode.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Node `fs`. Depends on Phase 1 (`completionPolicy`, Done `artifacts` schema) and Phase 2 (the active-run context + pause/confirm flow are already exercised).

---

## File Structure

- `apps/daemon/src/orchestrator-llm/prompts.ts` — add optional `workspaces` to `AgentInitialPromptInput` and render a `# Workspaces` section in `composeAgentInitialPrompt`.
- `apps/daemon/src/orchestrator-llm/prompts.test.ts` — assert workspace rendering.
- `apps/daemon/src/workflows/orchestrator/service.ts` — (a) pass workspaces into `composeAgentInitialPrompt` at the launch site (~2010); (b) force the confirmation pause for `handoff` steps (~1460); (c) on `handoff` confirmation in `confirmStep` (~1843), verify the reported spec file(s) and post a closing summary.
- The closest existing orchestrator test files for the service behaviors (`service.agent-step.test.ts` and/or `supervised-step-completion`-related tests — locate by reading them).

---

### Task 1: Include the workspace list in the agent's initial prompt

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/prompts.ts` (`AgentInitialPromptInput` + `composeAgentInitialPrompt`, lines 5-55)
- Test: `apps/daemon/src/orchestrator-llm/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `prompts.test.ts` (the file already tests `composeAgentInitialPrompt`; mirror its existing call style):

```ts
it("renders a Workspaces section when workspaces are provided", () => {
  const prompt = composeAgentInitialPrompt({
    goalTitle: "G", goalDescription: "", stepInstructions: "do it",
    outputSchema: [{ key: "summary", type: "string", required: true }],
    priorStepArtifacts: [],
    workspaces: [{ name: "api", root: "/repos/api" }, { name: "web", root: "/repos/web" }],
  });
  expect(prompt).toMatch(/# Workspaces/);
  expect(prompt).toMatch(/api/);
  expect(prompt).toMatch(/\/repos\/web/);
});

it("omits the Workspaces section when none are provided", () => {
  const prompt = composeAgentInitialPrompt({
    goalTitle: "G", goalDescription: "", stepInstructions: "do it",
    outputSchema: [{ key: "summary", type: "string", required: true }],
    priorStepArtifacts: [],
  });
  expect(prompt).not.toMatch(/# Workspaces/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test orchestrator-llm/prompts`
Expected: FAIL — `workspaces` is not an accepted field and no `# Workspaces` section is rendered.

- [ ] **Step 3: Implement**

In `prompts.ts`, add to `AgentInitialPromptInput`:

```ts
  workspaces?: Array<{ name: string; root: string }>;
```

In `composeAgentInitialPrompt`, build a workspace block and insert it into the returned array (place it after the goal/description block, before `# Step instructions`):

```ts
  const workspaceBlock = input.workspaces && input.workspaces.length > 0
    ? ["", "# Workspaces", ...input.workspaces.map((w) => `- ${w.name}: ${w.root}`)]
    : [];
```

Then splice `...workspaceBlock` into the existing returned array at the chosen position (match the existing array-join structure; do not reformat unrelated lines).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test orchestrator-llm/prompts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/prompts.ts apps/daemon/src/orchestrator-llm/prompts.test.ts
git commit -m "feat(orchestrator-llm): include workspace list in the agent initial prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pass workspaces from the launch site

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (the `composeAgentInitialPrompt` call at ~2010)
- Test: extend an existing service test that observes the composed objective, OR add a focused test that the launch query returns mapped workspaces (see note).

- [ ] **Step 1: Write/extend the test**

Locate how the existing tests assert on the launched objective (search `service.agent-step.test.ts` and siblings for `composeAgentInitialPrompt`, `objective`, or `launch`). If a test already captures the `objective` passed to the launcher, extend it: seed two `workspaces` rows for the goal and assert the delivered objective contains `# Workspaces` and a workspace root. If no such seam exists, add a minimal test that seeds workspaces and asserts the launcher received an objective containing `# Workspaces` (use the existing launcher stub/spy in those tests).

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: FAIL — objective has no `# Workspaces` section.

- [ ] **Step 3: Implement**

At the `composeAgentInitialPrompt({ ... })` call (~line 2010), add a workspaces lookup and pass it. Use the established query (same shape as `build-context.ts` / `server.ts`):

```ts
    const workspaceRows = db
      .prepare("SELECT name, path FROM workspaces WHERE goal_id = ? ORDER BY attached_at ASC")
      .all(ctx.goal.id) as Array<{ name: string; path: string }>;

    const objective = composeAgentInitialPrompt({
      goalTitle: ctx.goal.title,
      goalDescription: ctx.goal.description,
      stepInstructions: ctx.stepTpl.instructions,
      outputSchema: ctx.stepTpl.outputSchema,
      priorStepArtifacts: this.collectPriorStepArtifacts(db, ctx.run.id, ctx.stepRun.id),
      repairContext: this.latestRejectingGate(db, ctx.run.id),
      workspaces: workspaceRows.map((w) => ({ name: w.name, root: w.path })),
    });
```

(Workspaces are passed for every step — benign context; the Done step is the one that acts on it. Do not gate by step.)

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @orca/daemon typecheck` (PASS), then:

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(orchestrator): pass attached workspaces into the step agent objective

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Force a confirmation pause for `handoff` steps

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (the supervised-mode gate in `applyOrchestratorAction`'s `approve_step_complete` case, line ~1460)
- Test: the orchestrator service test suite (mirror an existing supervised-pause test if present)

**Context:** Today the confirmation pause only happens when `getSupervisionMode(db) === "supervised"`. The pause stashes `pending_completion_json`, calls `openOrUpdateLive`, and `pauseForConfirmation`. The user's "Continue" calls `confirmStep` (line 1843) to finalize; a chat revision goes through `forward_to_agent` (line 1385), which clears the stash and resumes the agent. We want a `handoff` step to take this same pause path **even in unsupervised mode**, so the user always reviews the spec before Done completes.

- [ ] **Step 1: Write the failing test**

Add a test that drives `approve_step_complete` for a step whose `stepTpl.completionPolicy === "handoff"` while supervision mode is **unsupervised** (the default). Assert the step PAUSES rather than completing: `pending_completion_json` is set on the step run AND no `step_output` artifact is written / `advanceToNextStep` did not run. Mirror the construction used by the Task 4 (Phase 2) interview tests in `service.agent-step.test.ts` (reuse `setupAgentStepRun`/`setupInterviewStepRun` patterns; add a `setupHandoffStepRun` helper if needed). Also keep/confirm a contrasting assertion: a non-handoff step in unsupervised mode still completes (existing behavior).

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: FAIL — the handoff step completes immediately in unsupervised mode.

- [ ] **Step 3: Implement**

Change the gate at line ~1460 from:

```ts
if (getSupervisionMode(db) === "supervised") {
```

to:

```ts
if (getSupervisionMode(db) === "supervised" || ctx.stepTpl.completionPolicy === "handoff") {
```

Leave the body unchanged. (`continueAllPausedSteps`, which auto-continues paused steps when switching to unsupervised, will still apply — acceptable: that is a user-initiated mode switch.)

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: PASS.

- [ ] **Step 5: Regression + typecheck + commit**

Run: `pnpm --filter @orca/daemon test workflows/orchestrator` (PASS), `pnpm --filter @orca/daemon typecheck` (PASS), then:

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(orchestrator): always pause handoff steps for user confirmation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Verify the spec + post a closing summary on Done confirmation

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`confirmStep`, lines ~1843-1893)
- Test: the orchestrator service test suite (a `confirmStep` test)

**Context:** `confirmStep` finalizes a paused completion: it loads the `pending_completion_json` stash (`{ block, scoring, finishedAt }`), commits the ledger, terminates the worker, builds the scored result, and advances. For a `handoff` step, `stash.block` is the Done agent's output JSON containing `artifacts: [{ type, reference, description }]` (the spec path(s), per Phase 1's schema) plus `summary` and `chosen_direction`. After finalizing, we (a) best-effort verify the reported spec file(s) exist, and (b) post a closing summary chat message — fixing "finishes silently."

- [ ] **Step 1: Write the failing test**

Add a `confirmStep` test for a `handoff` step: stash a `pending_completion_json` whose `block` includes `chosen_direction: "Approach A"`, `summary: "..."`, and `artifacts: [{ type: "spec", reference: ".orca/specs/2026-06-17-x.md", description: "design spec" }]`. Seed a workspace whose `path` is a real temp dir, and create the file at `<workspace>/.orca/specs/2026-06-17-x.md` so verification passes. Call `confirmStep`. Assert an orchestrator chat message was posted whose body names the chosen direction and the spec path (query `orchestrator_messages` for the goal, or use the existing test helper that reads posted messages). Add a second case where the file is absent and assert the closing message still posts but flags the spec could not be verified. Reuse the existing service-test harness for seeding runs/steps/workspaces and reading posted messages.

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test service.agent-step` (or the file you added the test to)
Expected: FAIL — no closing message posted.

- [ ] **Step 3: Implement**

In `confirmStep`, after `advanceToNextStep(...)` completes, add a handoff-gated closing summary. Add `import { existsSync } from "node:fs";` and `import { join, isAbsolute } from "node:path";` at the top of the file if not already present.

```ts
    if (stepTpl.completionPolicy === "handoff") {
      this.postHandoffClosingSummary(db, now, ctx, stash.block);
    }
```

Then add the private helper:

```ts
  /** Posts the Done step's closing summary and best-effort verifies the spec file(s). */
  private postHandoffClosingSummary(
    db: Database.Database,
    now: () => string,
    ctx: { run: WorkflowRunT; goal: GoalRow },
    block: unknown,
  ): void {
    const out = (block ?? {}) as { chosen_direction?: unknown; summary?: unknown; artifacts?: unknown };
    const direction = typeof out.chosen_direction === "string" ? out.chosen_direction : null;
    const artifacts = Array.isArray(out.artifacts) ? out.artifacts : [];
    const specRefs = artifacts
      .map((a) => (a && typeof a === "object" ? (a as { reference?: unknown }).reference : undefined))
      .filter((r): r is string => typeof r === "string");

    const roots = (db
      .prepare("SELECT path FROM workspaces WHERE goal_id = ? ORDER BY attached_at ASC")
      .all(ctx.goal.id) as Array<{ path: string }>).map((w) => w.path);

    const verified: string[] = [];
    const missing: string[] = [];
    for (const ref of specRefs) {
      const found = isAbsolute(ref)
        ? existsSync(ref)
        : roots.some((root) => existsSync(join(root, ref)));
      (found ? verified : missing).push(ref);
    }

    const lines: string[] = ["Design complete."];
    if (direction) lines.push(`Direction: ${direction}`);
    if (verified.length > 0) lines.push(`Spec saved: ${verified.join(", ")}`);
    if (missing.length > 0) lines.push(`Could not verify spec file(s): ${missing.join(", ")}`);
    if (specRefs.length === 0) lines.push("No spec artifact was reported by the Done step.");

    this.postOrchestratorMessage(db, now, ctx.run.goalId, lines.join("\n"), {});
  }
```

(Use the real signature of `postOrchestratorMessage` as it exists in this file — match its parameter order; pass an empty options object if that's what other internal callers use. Check an existing call such as the ones in `applyOrchestratorAction`.)

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test service.agent-step`
Expected: PASS (both the verified and missing-file cases).

- [ ] **Step 5: Regression + typecheck + commit**

Run: `pnpm --filter @orca/daemon test workflows/orchestrator` (PASS), `pnpm --filter @orca/daemon typecheck` (PASS), then:

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(orchestrator): verify spec and post a closing summary on Done confirmation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§6 + §1 handoff):**
- Agent authors+writes the spec; daemon verifies → Task 4 (best-effort `existsSync` against workspace roots). ✓ (The actual file write is the agent following the Phase-1 Done instruction; not engine code.)
- Workspace list in the Done agent's prompt → Tasks 1+2. ✓
- Multi-workspace: agent asks mid-step → reuses Phase 2 `ask_user`; no new engine code needed (the agent has the workspace list from Task 1+2 and the Done instruction tells it to ask). Noted, not a separate task. ✓
- Confirm-before-complete for `handoff`, regardless of supervision mode → Task 3 (pause) + adjustments via the existing `forward_to_agent` revision path (already built) + Continue via existing `confirmStep`. ✓
- Closing summary, not silent finish → Task 4. ✓

**Placeholder scan:** Task 2's and Task 4's tests are described against the existing service-test harness (which the implementer must read) rather than fully literal, because seeding runs/steps/workspaces and reading posted messages must match this repo's helpers; all implementation code is literal. Task 4 flags that `postOrchestratorMessage`'s exact signature must be matched from an existing call. No TBD/TODO in implementation.

**Type consistency:** `completionPolicy === "handoff"` matches the Phase 1 enum. `artifacts[].reference` matches the Phase 1 Done schema field. `composeAgentInitialPrompt`'s new `workspaces` field is the same `{ name, root }` shape used in Task 2's mapping and the `OrchestratorContextInput` workspace shape.

**Risk note:** Task 4's verification is best-effort (relative refs resolved against any workspace root; absolute refs checked directly). It surfaces a "could not verify" line rather than blocking completion — the agent already wrote (or failed to write) the file before the confirmation, and blocking finalization on a path heuristic would be worse than surfacing it.

---

## Remaining phases

- **Phase 4 — Narration:** reconstruct `currentStepAgentTurns`; plain-English activity feed; agent reasoning notes; the `agentAdapterId` polish deferred from Phase 2.
- **Phase 5 — Result card:** surface step output `summary`/headline + the `spec` artifact link into the `WorkflowStepResult` projection; rework `ActivityThread.tsx` to lead with the result, scores in a drawer.
