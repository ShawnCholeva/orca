# Orca Activity Thread

**Date:** 2026-06-05
**Status:** Design approved for review
**Scope:** Product and architecture design. Implementation plan deferred.

## Problem

Orca chat currently mixes several different concepts into one message stream:

- user-facing Orca replies;
- internal transport acknowledgements, such as relaying a message to the worker;
- generic loading states, such as routing;
- worker-agent input requests;
- transient progress indicators;
- durable internal-thought rows.

This makes the experience feel like the user is sometimes talking through Orca
to a worker agent, and sometimes watching implementation plumbing. It also
causes important supervision context to disappear, while low-value status text
can persist as chat history.

The desired model is different: the user talks only to Orca. Orca supervises the
step agent, interprets what is happening, and presents user-facing thoughts about
the agent's progress.

## Goals

- Make Orca's progress bubbles mean one thing: Orca is observing and reasoning
  about the active step agent's work.
- Keep transport details out of chat. The user does not need to see routing,
  relay acknowledgements, or other internal mechanics.
- Show one live activity bubble per active agent turn that updates as work
  progresses.
- Persist a concise final activity summary when the activity reaches a meaningful
  boundary, without keeping a long backlog of intermediate progress text.
- Present worker questions as Orca-mediated questions. The worker agent is not a
  visible chat participant.
- Preserve worker recommendations when presenting answer options.
- Start with Claude Code activity signals. Keep the model provider-neutral so
  Codex can be added next.

## Non-Goals

- No worker-question auto-answering in v1. If the worker asks, Orca asks the
  user.
- No exposure of raw hidden chain-of-thought from any model.
- No full observability platform across every provider in v1.
- No support work for removed providers.
- No implementation plan in this document.

## Core Concept

Add an **Orca Activity Thread** for workflow-step supervision.

An activity is not a chat message and not a raw worker log. It is Orca's
user-facing interpretation of the current agent turn, synthesized from structured
signals and available worker output.

Example progression within one activity bubble:

1. `Watching the step agent start the mechanics check...`
2. `The agent is preparing acceptance-signal questions...`
3. `I need your call on which signals passed.`

Those are revisions of the same activity, not three durable chat rows. When the
turn resolves, Orca may persist one concise final summary.

## Activity Lifecycle

Each activity belongs to a goal, workflow run, step run, and agent turn where
that turn can be identified.

Suggested lifecycle states:

- `active`: Orca is observing and synthesizing progress.
- `paused_for_input`: Orca needs the user to answer a mediated question before
  the worker can continue.
- `completed`: the activity reached a meaningful boundary and has a concise
  summary worth retaining.
- `expired`: the activity is no longer relevant and should not appear as durable
  history.

The desktop renders the latest `active` or `paused_for_input` activity as one
updating bubble. Completed activities can render as concise historical thought
rows when they add value.

## Chat Model

The user only talks to Orca.

Orca chat should not surface these as ordinary messages:

- `routing`;
- `Relayed your message to the agent working the current step.`;
- `The agent needs your input.`;
- successful submit or delivery acknowledgements.

Instead:

- active work appears as Orca activity;
- user questions appear as Orca-authored interaction cards;
- real failures remain visible as actionable Orca chat messages.

Examples of failures that should remain visible:

- no live step-agent session exists;
- a question expired before the answer was submitted;
- Orca cannot continue because a required provider or model is unavailable.

## Worker Questions

Worker questions are mediated by Orca.

Rules:

- Orca rewrites the question into Orca's voice.
- The answer schema remains equivalent to the worker's requested schema.
- Options remain selectable in a way that can be losslessly converted back to the
  worker's expected answer.
- Worker recommendations are preserved and made visible.
- The worker is not named as the conversational party unless needed for
  debugging or error recovery.

Example:

Worker signal:

```json
{
  "question": "Which PRD acceptance signals PASS?",
  "multiSelect": true,
  "options": [
    { "label": "Single block parsed OK", "description": "..." },
    { "label": "step_results non-empty", "description": "..." }
  ]
}
```

Orca presentation:

> I need your call on which acceptance signals passed.

The option labels and descriptions remain equivalent. If the worker supplied a
recommended choice, Orca marks it as recommended or presents it as a short
recommendation note.

## Activity Signal Sources

Use a hybrid signal model.

Preferred v1 sources:

- Claude Code hooks for tool use, question requests, stop/completion, and
  permission events.
- Workflow step-run state changes.
- Orchestrator judgement events, including paraphrase, revise, approve, and
  schema validation outcomes.
- Worker output summaries when they are available without parsing raw TUI state.

Provider scope:

- v1 implementation targets Claude Code first.
- Codex is next and should use the same activity contract once its hook/status
  signals are mapped.
- The contract should not encode Claude-specific concepts directly. Provider
  details belong in signal adapters.

## Weak Signal Handling

Orca should not invent detailed progress when it has weak evidence.

If no meaningful signal arrives after a threshold, update the live activity with
a conservative elapsed-time statement, for example:

> I am still waiting for the step agent; no new output yet.

This state is useful while active, but usually should not persist as a completed
activity summary unless the delay itself becomes relevant.

## Data Model Direction

Introduce a first-class activity projection instead of overloading
`orchestrator_messages`.

Likely fields:

- `id`
- `goal_id`
- `workflow_run_id`
- `step_run_id`
- `agent_session_id`
- `turn_key` or equivalent grouping key
- `status`
- `current_text`
- `final_summary`
- `source_kind`
- `confidence`
- `created_at`
- `updated_at`
- `completed_at`

The exact schema belongs in the implementation plan. The important design
constraint is that an activity can be updated in place while active, then either
completed with one retained summary or expired.

## Event Flow

1. Claude Code hook or workflow state event arrives.
2. Daemon maps the provider-specific signal into a normalized activity signal.
3. Activity updater creates or updates the current activity for the step/turn.
4. Daemon emits an activity-changed event.
5. Desktop refreshes the activity projection and updates the single live bubble.
6. If the activity pauses for input, desktop renders an Orca-mediated question
   card.
7. When the turn completes, daemon stores a concise final activity summary or
   expires the activity.

## Desktop Rendering

Desktop should render activity separately from chat messages.

Recommended visual behavior:

- latest active/paused activity appears near the bottom of the chat timeline;
- its text updates in place;
- paused-for-input activity can visually connect to the question card;
- completed summaries render only when they are meaningful;
- low-value transient statuses do not accumulate.

The activity component should not be labeled as worker output. It is Orca's
supervision layer.

## Testing Strategy

Focused tests should cover:

- activity updates in place rather than appending multiple chat rows;
- completed activity can persist as one concise summary;
- transport acknowledgements do not render as normal chat messages;
- `routing` does not appear as user-facing activity;
- worker questions render as Orca-mediated cards;
- worker recommendations survive the rewrite/presentation layer;
- v1 does not auto-answer worker questions;
- weak-signal timeout updates the active bubble conservatively;
- Claude Code signal adapter drives the activity projection;
- Codex support is deferred without blocking the provider-neutral contract.

## Tradeoffs

- This is larger than a string/UI patch, but it fixes the conceptual boundary
  between chat, activity, and transport state.
- Keeping only final summaries reduces chat noise but means intermediate progress
  revisions are not preserved as separate history.
- Claude Code first gives a practical delivery path while avoiding a
  lowest-common-denominator design.
- Rewriting worker questions improves UX but requires tests that prove answer
  schemas and recommendations remain faithful.

## Open Implementation Questions

- What is the best turn grouping key when provider hooks do not expose a clean
  turn identifier?
- Should completed activity summaries be shown inline by default, collapsed, or
  only retained for inspection?
- What threshold should trigger the weak-signal waiting update?
- Should question-card presentation be generated deterministically from the
  worker schema, via orchestrator LLM rewrite, or a hybrid?
- How should activity summaries be capped so long-running steps do not create too
  much durable history?
