# Persisted Agent Activity — Design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)

## Problem

During a workflow, the user feels "in the dark." Agent work is surfaced as a single
ephemeral tail bubble (`LiveActivity`) whose `currentText` is **overwritten** on every
signal — "Running a command…" → "Running the test suite…" — then vanishes when the turn
ends, leaving only a terminal result card. The intermediate work (what the agent read,
searched, ran, edited) is thrown away. There is no accumulated, persistent record of what
the agent actually did.

## Goal

Replace the flickering, self-overwriting live bubble with **one persisted `AgentActivity`
card per agent turn** that grows a checklist of steps in place — completed steps show a
green check, the active step shows a pulsing ellipsis — and settles with a closing summary
when the turn completes. Code-change steps expand into a GitHub-style diff. The card is
persisted, so the full trail survives reload and scroll-back.

Reference mockups: `image5.png` (step checklist), `image6.png` (inline diff).

## Scope (confirmed)

- **Step-agent execution** — the rich, hook-driven card. Primary surface.
- **Orchestrator routing** — a lighter, transient, client-side phase indicator (not persisted).
- **Inline diffs** — code-change steps expand to a collapsible unified-diff card.

## Principle

**Persist substance, not liveness chatter.** Tool work and code changes persist; "still
working" weak-signal ticks and the routing acknowledgement do not.

---

## 1. Data model

### New table `activity_steps` (additive migration)

Nothing FK-references it, so it runs in the normal transaction.

```sql
CREATE TABLE activity_steps (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  category    TEXT,            -- ActivityWorkCategory | null
  status      TEXT NOT NULL,   -- 'active' | 'done'
  diff        TEXT,            -- JSON ActivityDiff | null (edit steps only)
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_activity_steps_activity ON activity_steps(activity_id, ordinal);
```

### Contract changes (`@orca/contracts`)

`Activity` gains `steps: ActivityStep[]`.

```ts
ActivityStep = {
  id: string;
  text: string;
  category: ActivityWorkCategory | null;
  status: "active" | "done";
  diff?: ActivityDiff;        // present on edit steps
  createdAt: string;
}

ActivityDiff = {
  filePath: string;           // repo-relative when derivable, else absolute
  additions: number;
  deletions: number;
  hunks: ActivityDiffHunk[];
}

ActivityDiffHunk = {
  oldStart: number | null;    // null when line numbers couldn't be located
  newStart: number | null;
  lines: { kind: "context" | "add" | "remove"; text: string }[];
}
```

`currentText` and `finalSummary` stay. `currentText` mirrors the latest step's text for
back-compat; `finalSummary` is the closing summary line. **Back-compat:** an activity with
zero steps (pre-migration rows) renders as a single line from `currentText`.

---

## 2. Daemon — accumulate instead of overwrite

In `ActivityUpdater` / `store.ts`, replace `openOrUpdateLive`'s overwrite with **append-step**
semantics. A small `appendStep` helper: flip the current `active` step to `done`, insert the
new step as `active` (next ordinal), update the activity's `current_text` mirror, emit
`activity.changed`.

| Signal | Behavior |
| --- | --- |
| `step_started` | Create the activity with the step name as the card header. **No "Watching…" step is appended** — the first real step comes from the first `tool_use`. While the agent has produced no tool step yet, the card shows a single pulsing active line (the header carries the step name). |
| `tool_use` | Flip active→done, append new active step. **Existing `ACTIVITY_THROTTLE_MS` same-category dedup carries over** so rapid same-category calls don't spam the list. Edit-category steps also attach a `diff` (§3). |
| `weak_signal` | **No step appended.** The active step's pulse already signals liveness. |
| `turn_completed` | Mark active step `done`, set `finalSummary`, status `completed`. Card stays in the timeline permanently. |
| `permission_pending` / `question_pending` / `step_confirmation_pending` / `provider_recovery_pending` | Unchanged pause behavior; the active step text reflects the pause; existing forms render on the card. |

---

## 3. Specific step text + diffs (hook-driven)

Tool detail already arrives at the hook boundary (`PreToolUse`/`PostToolUse` carry
`tool_name` + `tool_input`) and is currently discarded after `categorizeClaudeTool`.

### `narrateToolDetail(toolName, toolInput): string`

New helper in `claude-adapter.ts`, computed where `tool_input` exists, threaded through the
`tool_use` signal as a `detail` string (signals stay provider-neutral — it's just a string):

- `Read` → `Read verifier.ts`
- `Edit` / `Write` / `MultiEdit` → `Edited store.ts`
- `Grep` / `Glob` → `Searched "retryCharge("`
- `Bash` → `Ran <cmd>` (testing category → `Ran tests: <cmd>`)
- default / failure → fall back to today's `narrateCategory`

Wrapped in try/catch so a malformed tool input never breaks ingestion.

### Diff reconstruction (chosen source: from hook payload)

On a `PostToolUse` for an edit tool, build the diff from the payload:

- `Edit`: `old_string` = removed lines, `new_string` = added lines.
- `Write`: `content` = all added lines (new/overwritten file).
- `MultiEdit`: one hunk per edit.

To recover image6.png fidelity (real line numbers + gray context lines), do **one `fs` read**
of the just-edited file (it now contains `new_string`), locate the changed region, and emit a
couple of context lines around it. If `new_string` can't be unambiguously located (e.g. the
snippet repeats), fall back to `oldStart`/`newStart = null` and render without line numbers.
`additions`/`deletions` computed from the line counts. Read is windowed/bounded so large files
are cheap. Rationale for this source over `git diff`: hook-native, isolates exactly the agent's
edit, works in non-git workspaces, and avoids pre-existing-dirty-state pollution and baseline
snapshots.

**Size cap:** large hunks truncated (e.g. beyond N lines) with a "+X more lines" marker so a
huge edit doesn't bloat the persisted row.

---

## 4. Desktop — one `AgentActivity` card

`LiveActivity` + `ActivityCard` merge into a single `AgentActivity` component:

- Optional header: `stepName`.
- Checklist: `done` → green `check` icon + muted text; `active` → pulsing ellipsis (reuse the
  existing `thinking-dots`).
- Edit steps with a `diff`: show `▸ filename +A -D`, **collapsed by default**, expandable into
  the image6.png diff card (file header, `+A -D` stat, line numbers, red/green hunks, context).
- On `completed`: all checks + `finalSummary` as the closing line.
- When `paused_for_input`: the embedded forms (worker question, step-confirm Continue,
  provider-recovery) render on the card, as today.

In `OrcaChat`, `isTimelineCard` expands to include **every agent activity that has steps**
(active, paused, completed) — so each turn is one persisted card that grows in place. The
separate live tail-bubble path (`pickLiveActivity` rendering) is removed; the active card is
naturally newest at the tail. `showStarting` (first-turn latency indicator) stays. The
existing `step_result` card is unchanged and still interleaves by `createdAt`.

The `step_started` "Watching the step agent start…" line is dropped — it was redundant with
the card's step-name header. The checklist is pure agent work; before the first tool step the
card shows a single pulsing line under the step-name header.

---

## 5. Orchestrator routing card (lighter, transient)

The `one_shot` orchestrator path is a single synchronous LLM call with no real substeps, so
this is a **client-side synthetic, non-persisted** indicator — an evolution of today's
thinking-dots into a small phase checklist ("Reading your message" → "Working out a
response") shown while `awaitingReply` / `sendingMessage`, which collapses when the real reply
message lands. No migration or backend work; the reply itself is already persisted as a chat
message. Rationale: the routing card is "I heard you, working on it" — once the reply lands,
the reply *is* the record; persisting a "✓ Reading ✓ Routing" stub per exchange is permanent
clutter.

---

## 6. Error handling

- `narrateToolDetail` and diff reconstruction are fully wrapped: any failure falls back to
  `narrateCategory` / a step with no diff. Ingestion never throws on a weird tool input.
- Migration is additive (new table); safe in the normal transaction.
- Pre-migration activities (zero steps) render from `currentText` — no broken cards.
- Diff line-number ambiguity → render without line numbers rather than guess.

---

## 7. Testing

- **Contract:** `Activity` parses with `steps`; `ActivityStep` with and without `diff`.
- **Updater:** `step_started` seeds first active step; `tool_use` flips prior→done + appends;
  same-category throttle dedups; `turn_completed` checks all + sets `finalSummary`;
  `weak_signal` appends nothing.
- **`narrateToolDetail`:** per-tool unit tests + fallback path.
- **Diff reconstruction:** Edit (with context/line numbers), Write (all-add), MultiEdit
  (multi-hunk), ambiguous-location fallback, size-cap truncation.
- **Desktop `AgentActivity`:** renders checklist with active pulse on the last step, checks on
  done, summary on complete; edit step expands to diff; card persists in the timeline after
  completion (no vanishing tail bubble).

---

## Out of scope

- Wiring the orchestrator's own shadow-session hooks into the persisted activity stream
  (the routing card stays synthetic/transient).
- `git diff`-based capture (rejected in favor of hook reconstruction).
- Per-turn consolidated "Changes" card (diffs attach per edit step instead).
- Auto-collapsing completed cards to a summary line (deferred; revisit if scroll length
  becomes a problem in practice).
