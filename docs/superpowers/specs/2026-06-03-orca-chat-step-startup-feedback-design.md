# Orca Chat Step Startup Feedback

**Date:** 2026-06-03
**Branch:** main
**Status:** Design approved, pending spec review

## Problem

When a goal is created with a workflow (e.g. the Initiative workflow), step 1's
agent session is spawned and the composed objective (goal + step instructions +
output schema) is automatically pasted into the agent and submitted
(`worker-session.ts:145`). The agent starts working and, after ~30–60s of
thinking, produces its first turn, which the orchestrator mediator paraphrases
into the chat.

During that startup gap the Orca chat shows only a static header card and looks
idle. With no visible "working…" feedback, the user assumes nothing is happening
and types a message (e.g. `hi`) to prompt Orca. That bait triggers the mediator
to emit a generic throwaway greeting ("Hi! 👋 What would you like to work on?"),
adding noise before the agent's real first question arrives.

The initial prompt to step 1 is **not** missing — it is delivered automatically.
The defect is the silent, idle-looking startup gap and a redundant header card.

## Goals

- Show immediate, visible feedback that the current workflow step is starting,
  so the chat never looks idle during the agent's first-turn latency.
- Use the step's real human name (e.g. "Grill Me"), not the formatted template
  id ("Intake").
- Remove the redundant goal title/description header card from the chat.

## Non-Goals

- No change to how/when the initial prompt is delivered to the step agent (it
  already works).
- No suppression of the mediator's greeting reply (the user opted not to change
  this).
- No "seed my own initial prompt at goal creation" feature.
- No daemon or contract changes.
- No changes to `WorkflowBanner` — it is not rendered anywhere in the app.

## Scope

All changes are in `apps/desktop/src/orchestrator/OrcaChat.tsx`. No daemon,
contract, or other component changes.

## Design

### 1. Resolve the real step name

`WorkflowState` currently holds `detail`, `run`, `stepRun`, `decisions`,
`artifacts`. The step run carries only `stepTemplateId` (`"intake"`) and
`ordinal` — the human name ("Grill Me") lives in the template's `steps_json`.

In the existing `load()` effect (the one that already fetches run, decisions,
artifacts, and step run), after the step run is fetched, also call
`getWorkflowTemplate(run.templateId)`, find the step where
`step.id === stepRun.stepTemplateId`, and store its `name` as a new
`stepName: string | null` field on `WorkflowState`.

- `getWorkflowTemplate(id)` already exists in `api.ts`; the run already exposes
  `templateId`; the template response exposes `steps[]` with `id`, `ordinal`,
  `name`.
- If the template fetch fails or no matching step is found, `stepName` is `null`
  and the indicator falls back to `Step {ordinal + 1}` with no name suffix.

### 2. Drop the header card

Remove the `SystemCard` at `OrcaChat.tsx:381-387` that renders
`selectedGoal.title` / `description`. The goal title is already present in the
goal rail; this card is redundant. The other `SystemCard`s ("Select a goal",
"Goal needs an orchestrator model", "No workflow running") remain — they convey
actionable state, not just a title.

### 3. "Starting" indicator

Render a `ThinkingRow`-style row near the top of the message list (before the
mapped messages) when **all** of:

- `workflowState.run?.status === "active"`
- `workflowState.stepRun?.status === "active"`
- no message yet has role `orchestrator` or `agent_paraphrased` (Orca/agent has
  never spoken in this chat)

Copy: `Step {ordinal + 1} · {stepName} — starting (this can take ~30–60s)…`
(omit the `· {stepName}` segment when `stepName` is `null`).

The indicator disappears automatically once the agent's first turn is
paraphrased into the chat (an `agent_paraphrased`/`orchestrator` message appears,
failing the third condition).

## Data flow

1. Goal selected → `load()` fetches goal detail, run, step run, decisions,
   artifacts, and now the template → resolves `stepName`.
2. While run + step are active and Orca/agent has not yet spoken, the chat shows
   the starting indicator instead of looking idle.
3. SSE `workflow.*` / `orchestrator.message.created` events bump `refreshNonce`
   (debounced 75ms), re-running `load()` and re-evaluating the conditions. When
   the agent's first paraphrased turn lands, the indicator clears.

## Error handling

- Template fetch failure → `stepName = null`; indicator still shows with the
  ordinal-only label. No error surfaced for this non-critical enrichment.
- All other existing `load()` error handling is unchanged.

## Testing

`OrcaChat.test.tsx` already exists. Add cases:

- Header card (goal title/description) is no longer rendered.
- Starting indicator renders when run + step are active and no orchestrator/
  agent message exists, using the resolved step name.
- Starting indicator does **not** render once an `agent_paraphrased` (or
  `orchestrator`) message is present.
- Starting indicator falls back to the ordinal-only label when the template/step
  name cannot be resolved.

## Tradeoffs accepted

- The `load()` effect gains one `getWorkflowTemplate` fetch per refresh
  (debounced; templates are small). Not cached — YAGNI.
- The step name appears only in the starting indicator. There is no persistent
  current-step banner in the chat today (the `WorkflowBanner` component exists
  but is unmounted); adding one is out of scope.
