# Brainstorm Phase 4: Narration (Reasoning Notes + Context Completion)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the agent's *reasoning* (the "why") during a step — not just the tool checklist and one-line turn summaries that already exist — and complete the two context items deferred from Phase 2 (`agentAdapterId`, `currentStepAgentTurns`).

**Architecture (what already exists vs. what's new):** Tool activity is already narrated to a checklist (`narrateToolDetail` → `tool_use` signal → `appendActivityStep`) and each turn gets a one-line summary (`deriveTurnSummary`). The gap is the agent's reasoning *between* tool calls. Claude Code hooks fire on PreToolUse/PostToolUse/Stop and the payload carries a `transcript_path` (the conversation JSONL). The `onToolUse` handler (`server.ts:1387`) already receives the hook payload; we extend it to read new assistant-text blocks from the transcript and emit a new `reasoning_note` activity signal that surfaces inline in the thread. Two small build-context fixes round out the phase.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Node `fs`. Depends on Phases 1–3. Provider note: transcript parsing is Claude-Code-specific; other adapters simply won't emit reasoning notes (graceful no-op).

---

## File Structure

- `apps/daemon/src/orchestrator-llm/build-context.ts` — set `agentAdapterId` from the step run's selected operator; reconstruct `currentStepAgentTurns` from the step's `interview_turn` artifacts.
- `packages/contracts/src/index.ts` — add the `reasoning_note` variant to `ActivitySignal`'s contract counterpart only if the signal type is defined in contracts (it is defined in `apps/daemon/src/activities/signals.ts`; confirm and add there).
- `apps/daemon/src/activities/signals.ts` — add a `reasoning_note` signal kind.
- `apps/daemon/src/activities/updater.ts` — handle `reasoning_note` → `appendActivityStep`.
- `apps/daemon/src/activities/transcript.ts` (new) — read a Claude transcript JSONL and return assistant text blocks newer than a cursor.
- `apps/daemon/src/agent-hooks/routes.ts` + `apps/daemon/src/server.ts` — thread `transcriptPath` into `onToolUse`; emit `reasoning_note` from extracted text.
- Tests alongside each.

---

### Task 1: `agentAdapterId` from the selected operator (Phase 2 polish)

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/build-context.ts` (the `loadActiveStep` helper + the active-run `currentStep` construction)
- Test: `apps/daemon/src/orchestrator-llm/build-context.test.ts`

**Context:** Phase 2 hardcoded `agentAdapterId: "claude-code"` in the active-run path. The real adapter is on the step-run row as `selected_operator_id` (format `"agent:<adapterId>"`). Use it; fall back to `"claude-code"` when null/unparseable.

- [ ] **Step 1: Write the failing test**

Extend the active-run test in `build-context.test.ts`: seed the `workflow_step_runs` row with `selected_operator_id = 'agent:codex'` and assert:

```ts
expect(ctx.currentStep.agentAdapterId).toBe("codex");
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test build-context`
Expected: FAIL — it is hardcoded to `"claude-code"`.

- [ ] **Step 3: Implement**

In `loadActiveStep`, include `selected_operator_id` in the step-run SELECT (e.g. `SELECT step_template_id, ordinal, selected_operator_id FROM workflow_step_runs WHERE id = ?`) and surface it. In the `currentStep` construction, derive the adapter:

```ts
    const selectedOperator = activeStep.selectedOperatorId; // e.g. "agent:codex" | null
    const agentAdapterId = typeof selectedOperator === "string" && selectedOperator.startsWith("agent:")
      ? selectedOperator.slice("agent:".length)
      : "claude-code";
```

Use `agentAdapterId` in the `currentStep` object instead of the literal.

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test build-context`

- [ ] **Step 5: Typecheck + commit**

`pnpm --filter @orca/daemon typecheck` (PASS), then:

```bash
git add apps/daemon/src/orchestrator-llm/build-context.ts apps/daemon/src/orchestrator-llm/build-context.test.ts
git commit -m "feat(orchestrator-llm): derive agentAdapterId from the selected operator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Reconstruct `currentStepAgentTurns` (Phase 2 stub)

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/build-context.ts`
- Test: `apps/daemon/src/orchestrator-llm/build-context.test.ts`

**Context:** Phase 2 left `currentStepAgentTurns: []`. The current step's conversation lives as `interview_turn` artifacts; `reconstructTranscript(artifacts)` (`apps/daemon/src/workflows/orchestrator/interview.ts`) returns `InterviewTurn[]` sorted by `turnIndex`. The context shape needs `{ role: "agent" | "user_via_orchestrator", body, ts }`. Inspect the `InterviewTurn` contract (`@orca/contracts`) for its real field names (role/content/text + any timestamp) and map accordingly.

- [ ] **Step 1: Write the failing test**

Extend the active-run test: seed two `workflow_artifacts` rows of `type = 'interview_turn'` for the current step run (bodies are JSON matching `InterviewTurn`), then assert `ctx.conversation.currentStepAgentTurns.length === 2` and that the mapped `role`/`body` reflect the seeded turns.

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test build-context`
Expected: FAIL — currentStepAgentTurns is empty.

- [ ] **Step 3: Implement**

In the active-run path, load the current step run's artifacts and reconstruct turns. Add a helper (mirror the artifact query used by `loadPriorArtifacts`, but filtered to the CURRENT `stepRunId` and `type = 'interview_turn'`), call `reconstructTranscript`, and map each `InterviewTurn` to `{ role, body, ts }` using the real field names. Import `reconstructTranscript` from `../workflows/orchestrator/interview.js`. Replace the `currentStepAgentTurns: []` placeholder (and remove the Phase-2 "follow-on" comment).

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test build-context`

- [ ] **Step 5: Typecheck + commit**

`pnpm --filter @orca/daemon typecheck` (PASS), then:

```bash
git add apps/daemon/src/orchestrator-llm/build-context.ts apps/daemon/src/orchestrator-llm/build-context.test.ts
git commit -m "feat(orchestrator-llm): reconstruct current-step agent turns for mediator context

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Add a `reasoning_note` activity signal and surface it

**Files:**
- Modify: `apps/daemon/src/activities/signals.ts` (new signal kind)
- Modify: `apps/daemon/src/activities/updater.ts` (handle it)
- Test: `apps/daemon/src/activities/updater.test.ts`

**Context:** This adds the *surfacing* side (no transcript reading yet) so it can be tested in isolation. A `reasoning_note` is a short line of agent reasoning; it appends to the activity checklist like a `tool_use` step but with its own category so the UI can style it.

- [ ] **Step 1: Write the failing test**

In `updater.test.ts` (mirror existing `tool_use` tests), add a test: applying a `reasoning_note` signal calls `appendActivityStep` with the note text and a `thinking` category, on the live activity for the step.

```ts
it("appends a reasoning note as an activity step", () => {
  // open a live activity for the step (step_started), then:
  updater.apply(ctx, {
    kind: "reasoning_note",
    goalId, workflowRunId, stepRunId, agentSessionId: null,
    text: "Comparing an app-wide table against per-goal storage",
  });
  // assert the latest activity step text === the note and its category is "thinking"
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test activities/updater`
Expected: FAIL — `reasoning_note` is not a known signal kind.

- [ ] **Step 3: Implement**

In `signals.ts`, add to the `ActivitySignal` union:

```ts
  | {
      kind: "reasoning_note";
      goalId: string;
      workflowRunId: string;
      stepRunId: string;
      agentSessionId: string | null;
      text: string;
    }
```

In `updater.ts`, add a case mirroring `tool_use` (but without throttle-by-category, and with a fixed category). If `ActivityWorkCategory` does not already include a `"thinking"` value, use the existing `"other"` category instead (do NOT change the contract enum in this task — check `ActivityWorkCategory` in `@orca/contracts` and pick `"thinking"` only if it exists, else `"other"`):

```ts
      case "reasoning_note": {
        const text = signal.text.trim();
        if (text.length === 0) return;
        appendActivityStep(ctx, {
          goalId: signal.goalId,
          workflowRunId: signal.workflowRunId,
          stepRunId: signal.stepRunId,
          agentSessionId: signal.agentSessionId,
          text,
          category: "other",
          diff: null,
        });
        return;
      }
```

- [ ] **Step 4: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test activities/updater`

- [ ] **Step 5: Typecheck + commit**

`pnpm --filter @orca/daemon typecheck` (PASS), then:

```bash
git add apps/daemon/src/activities/signals.ts apps/daemon/src/activities/updater.ts apps/daemon/src/activities/updater.test.ts
git commit -m "feat(activities): add reasoning_note signal surfaced as an activity step

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Extract agent reasoning from the transcript and emit notes

**Files:**
- Create: `apps/daemon/src/activities/transcript.ts` + `transcript.test.ts`
- Modify: `apps/daemon/src/agent-hooks/routes.ts` (pass `transcriptPath` through to the PostToolUse handler/deps)
- Modify: `apps/daemon/src/server.ts` (`onToolUse` — read new reasoning since the last note, emit `reasoning_note`)

**Context:** The hook payload carries `transcript_path` (already in the route schema). At PostToolUse, the transcript JSONL up to the current tool call contains the assistant's text blocks (its reasoning) plus tool_use blocks. We extract assistant *text* emitted since the last note we surfaced for this step and emit each as a `reasoning_note`. This is Claude-Code-specific; for other adapters or a missing/unreadable transcript, it is a silent no-op.

- [ ] **Step 1: Inspect a real transcript FIRST**

Before writing the parser, locate a real Claude Code transcript JSONL (the `transcript_path` points at `~/.claude/...` / the project session dir) and inspect one assistant entry's structure: confirm how text blocks vs `tool_use` blocks are represented (typically `{"type":"assistant","message":{"content":[{"type":"text","text":...},{"type":"tool_use",...}]}}` per line). If you cannot find a sample, write the parser against that documented shape and keep it defensive. Record what you found in your report.

- [ ] **Step 2: Write the failing test (`transcript.test.ts`)**

Write a fixture transcript JSONL string with two assistant entries containing `text` blocks and a `tool_use` block, plus a user entry. Test `extractReasoningSince(transcriptText, cursor)`:

```ts
it("returns assistant text blocks after the cursor, in order", () => {
  const out = extractReasoningSince(FIXTURE, 0);
  expect(out.notes).toEqual(["First I’ll map the storage options", "Leaning toward an app-wide table"]);
  expect(out.cursor).toBeGreaterThan(0);
});

it("returns nothing when the cursor is already at the end", () => {
  const { cursor } = extractReasoningSince(FIXTURE, 0);
  expect(extractReasoningSince(FIXTURE, cursor).notes).toEqual([]);
});
```

(Design `extractReasoningSince(text: string, cursor: number): { notes: string[]; cursor: number }` — `cursor` is a count of assistant-text blocks already surfaced; it returns only newer ones and the advanced cursor. This keeps state simple and avoids re-emitting.)

- [ ] **Step 3: Run, verify FAIL**

Run: `pnpm --filter @orca/daemon test activities/transcript`
Expected: FAIL — module/function does not exist.

- [ ] **Step 4: Implement `transcript.ts`**

Implement `extractReasoningSince` defensively: split JSONL by line, `JSON.parse` each (skip malformed lines), select entries that are assistant messages, flatten their `content` to `text`-type blocks, trim, drop empty and very-short (< 8 chars) fragments, count them, and return those beyond `cursor` plus the new cursor (= total count). No `fs` here — pure string in, for testability.

- [ ] **Step 5: Run, verify PASS**

Run: `pnpm --filter @orca/daemon test activities/transcript`

- [ ] **Step 6: Wire it into `onToolUse`**

- In `agent-hooks/routes.ts`, ensure the PostToolUse handler forwards `transcript_path` to its `deps` callback (extend the `onToolUse` payload with `transcriptPath`).
- In `server.ts` `onToolUse` (line ~1387): keep a per-step cursor (a `Map<stepRunId, number>` alongside the handler, or store on a small in-memory map like `activityUpdater`'s state). When `payload.transcriptPath` is set and the file exists, `readFileSync` it, call `extractReasoningSince(text, cursor)`, emit a `reasoning_note` signal for each note via `applyActivitySafely`, and save the advanced cursor. Wrap in try/catch — a transcript read must never break tool_use handling. Emit reasoning notes BEFORE the existing `tool_use` apply so the note precedes the action it motivated.

Add a focused test in `server`-level or a unit around the cursor logic if a seam exists; otherwise rely on `transcript.test.ts` for the parser and keep the `onToolUse` wiring minimal and defensive (note this in the report).

- [ ] **Step 7: Verify + regression + typecheck**

Run: `pnpm --filter @orca/daemon test activities` and `pnpm --filter @orca/daemon test server` (if a server test exists for hooks), plus `pnpm --filter @orca/daemon typecheck`. Expect PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/activities/transcript.ts apps/daemon/src/activities/transcript.test.ts apps/daemon/src/agent-hooks/routes.ts apps/daemon/src/server.ts
git commit -m "feat(activities): surface agent reasoning notes from the transcript during a step

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§3 + Phase 2 deferrals):**
- Plain-English activity feed → already exists (`narrateToolDetail`); no work needed (documented finding). ✓
- Agent reasoning notes → Tasks 3 (surface) + 4 (extract from transcript). ✓
- `agentAdapterId` polish → Task 1. ✓
- `currentStepAgentTurns` reconstruction → Task 2. ✓

**Placeholder scan:** Task 4 Step 1 is an explicit inspection step (not a code placeholder) because the Claude transcript line shape must be confirmed against a real file; the parser is written against the documented shape and is defensive. Tasks 1–3 are fully literal. Task 2's `InterviewTurn` field mapping directs the implementer to the real contract (field names vary) rather than guessing.

**Type consistency:** `reasoning_note` signal fields mirror `tool_use`'s (`goalId/workflowRunId/stepRunId/agentSessionId`); `extractReasoningSince(text, cursor)` returns `{ notes, cursor }` used identically in the parser test and the `onToolUse` wiring; `agentAdapterId` strips the `"agent:"` prefix consistent with how `selected_operator_id` is written elsewhere (`"agent:" + dispatch.adapterId` in `service.ts`).

**Risk notes:**
- Task 4 is provider-specific (Claude transcript). For other adapters or unreadable transcripts it is a silent no-op — acceptable; reasoning notes are additive.
- Reasoning-note volume: filtering out < 8-char fragments and using a per-step cursor avoids spamming the checklist. If notes still feel noisy in practice, a follow-up can summarize/throttle them — out of scope here.

---

## Remaining phase

- **Phase 5 — Result card:** surface step output `summary`/headline + the `spec` artifact link into the `WorkflowStepResult` projection; rework `ActivityThread.tsx` to lead with the result and move scores into a drawer. (The reasoning notes from this phase will appear in the in-progress activity thread; the card is the terminal summary.)
