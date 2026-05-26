# Orchestrator Chat Persistence - Design Spec

**Date:** 2026-05-26
**Status:** Draft
**Owner:** Shawn Choleva

## Problem

The current orchestrator tab is not a persistent goal-scoped chat. It is a workflow-status surface that sometimes renders workflow-specific input.

Today:

- no selected goal shows a placeholder card
- a selected goal shows workflow state, recommendations, and a `request_user_input` textarea only when that specific workflow prompt is active
- when there are no pending workflow recommendations, the tab falls back to `No pending workflow recommendations`

That breaks the expected interaction model. The user should be able to send freeform guidance to Orca at any time while a goal is selected, and that conversation should persist so reopening the goal restores the full history.

## Goals

- Make the orchestrator tab a real goal-scoped chat surface.
- Keep the chat composer available whenever a goal is selected.
- Persist user and orchestrator messages so reopening a goal restores the conversation history.
- Keep freeform chat separate from workflow recommendation state.
- Preserve workflow-specific UI such as `request_user_input`, recommendation cards, and the workflow banner.
- Show no chat UI when no goal is selected; instead prompt the user to start or select a goal.

## Non-goals

- Do not turn every freeform message into a workflow mutation.
- Do not auto-accept, reject, dismiss, or modify recommendations from chat input.
- Do not replace the existing recommendation model with chat messages.
- Do not redesign the overall orchestrator workflow engine in this change.
- Do not add goal-less top-level orchestrator chat.
- Do not introduce agent-autonomous replies beyond the existing orchestrator boundary without explicit backend support.

## Product Behavior

### No selected goal

The orchestrator pane does not render chat history or a composer. It shows a single empty state prompting the user to start a goal or select one from the rail.

### Selected goal

The orchestrator pane renders:

- the persisted conversation timeline for that goal
- workflow system content relevant to the current goal state
- a normal freeform composer anchored at the bottom of the pane

The composer is available even when:

- the workflow is active
- there are no pending workflow recommendations
- a `request_user_input` workflow prompt is visible

If a selected goal has no configured orchestrator provider/model, the composer still renders but send attempts fail with an inline message explaining that the goal needs an orchestrator model before Orca can reply.

### Freeform messages

A freeform message sent while a goal is selected becomes orchestrator guidance attached to that goal.

By default, it does not:

- mutate workflow recommendation state
- satisfy workflow exit criteria
- submit workflow user input
- advance the workflow

It is normal conversation state, not workflow control state.

### Workflow-specific input

If the workflow is waiting on a structured `request_user_input` prompt, that prompt still renders its dedicated answer UI. The normal composer remains visible at the same time.

The dedicated workflow answer box continues to submit through the workflow input endpoint. The normal composer sends a normal orchestrator message.

## Recommended Approach

Add a dedicated goal-scoped orchestrator conversation model.

This is preferable to reusing recommendation rows or workflow artifacts because freeform guidance is neither an approval object nor a workflow artifact. Keeping conversation state separate avoids coupling simple chat behavior to workflow lifecycle rules.

## Architecture

### Data model

Introduce a new persisted entity for orchestrator chat messages:

```ts
type OrchestratorChatMessage = {
  id: string;
  goalId: string;
  role: "user" | "orchestrator" | "system";
  kind: "message" | "workflow_event";
  body: string;
  createdAt: string;
  correlationId: string | null;
};
```

Notes:

- `goalId` is mandatory. There is no global chat.
- `role` drives message rendering and semantics.
- `kind` allows the timeline to mix normal conversation with workflow-generated system entries.
- `correlationId` is optional and can link future orchestrator replies or workflow-derived timeline entries without changing the core model.

V1 may start with persisted `user` and `system`/`orchestrator` rows only. The schema should still leave room for timeline correlation.

### Backend API

Add goal-scoped read/write endpoints:

- `GET /v1/goals/:goalId/orchestrator-messages`
- `POST /v1/goals/:goalId/orchestrator-messages`

`GET` returns the persisted timeline for the selected goal in ascending creation order.

`POST` accepts a freeform user message, persists it, then invokes the selected goal's orchestrator provider/model in a non-mutating guidance mode. The daemon persists the orchestrator reply as a separate message row and returns both created rows in a single response.

That guidance mode is chat-only:

- it can reference current goal and workflow state
- it cannot accept or change recommendations
- it cannot advance workflow state
- it cannot write any workflow artifacts or decisions directly

### Live updates

Emit a new goal-scoped event when an orchestrator message is created so the selected goal timeline can update without polling. The event payload should be content-light and point clients back to the existing list endpoint or include the created message if that matches current event conventions.

### Desktop state

`OrcaChat` becomes responsible for two parallel state tracks:

- conversation state: persisted messages plus freeform draft
- workflow state: banner, recommendations, and workflow input prompts

These tracks coexist. Workflow state no longer decides whether the base composer exists.

## UI Design

### Timeline

The main chat area becomes a goal-scoped message timeline.

It should contain:

- persisted user messages
- persisted orchestrator/system replies
- workflow system cards already shown in the pane, rendered as timeline content where appropriate

The current `No pending workflow recommendations` card should stop acting as the terminal fallback that implies the chat is unavailable. It may remain as an informational system row within the timeline, but only as content, never as a replacement for the composer.

### Composer

The composer is fixed at the bottom of the chat pane and is visible whenever a goal is selected.

Expected behavior:

- disabled only when the daemon connection is unavailable or a send is actively in flight
- optimistic local draft retention on transient failures
- clear after successful send
- does not disappear because workflow recommendation count reaches zero

### Empty states

- no goal selected: prompt to start or select a goal
- selected goal with no messages yet: show the goal header and an empty conversation state, but keep the composer visible

## Data Flow

### Initial load

1. User selects a goal.
2. Desktop loads goal-scoped workflow state as today.
3. Desktop also loads orchestrator messages for that goal.
4. UI renders the timeline and the always-visible composer.

### Send message

1. User types a freeform message in the composer.
2. Desktop `POST`s a goal-scoped orchestrator message.
3. Daemon persists the user message.
4. Daemon generates a non-mutating orchestrator reply using the goal's configured provider/model.
5. Daemon persists the reply as a second message row.
6. Daemon emits orchestrator-message-created events for the persisted rows.
7. Desktop appends or refreshes the timeline.

### Workflow prompt visible

1. Workflow state indicates structured human input is needed.
2. UI shows the dedicated workflow answer card.
3. UI still shows the normal composer.
4. Structured workflow submission and freeform guidance remain separate actions.

## Error Handling

- Sending a freeform message must not mutate workflow state on failure.
- Timeline load failures should show an inline error in the chat area without hiding the composer if a goal is selected.
- Message send failures should preserve the draft and show an inline error near the composer.
- Goal mismatch or missing-goal reads must return the same goal-scoped access behavior as the rest of the daemon API.
- Event-delivery loss should degrade to manual refresh or next goal reload without corrupting timeline state.

## Testing

### Desktop

- no selected goal shows the goal-start prompt and no composer
- selected goal with no workflow recommendations still shows the composer
- selected goal with a pending `request_user_input` shows both the workflow answer UI and the normal composer
- selecting a goal reloads persisted chat history
- re-entering the same goal restores prior messages
- send failure preserves draft text

### Daemon

- create/list orchestrator messages are goal-scoped
- message creation persists correct role and body
- event emission occurs after persistence
- a freeform user message produces a persisted orchestrator reply row in the same logical request flow
- workflow endpoints remain unchanged by freeform message creation
- freeform message creation does not alter recommendation status or step-run state

### Contracts

- orchestrator message schema parses expected roles and payloads
- list/create response schemas remain stable
- event payloads stay within current limits

## Implementation Notes

- Prefer adding a dedicated daemon module for orchestrator messages instead of embedding this into workflow recommendation code.
- Keep message persistence and workflow persistence separate at the storage layer.
- The existing `OrcaChat` component should keep distinct state slices for conversation and workflow data even if the first implementation remains in one file.

## Open Decisions Resolved

- Freeform messages while a workflow is active are persisted as goal-scoped orchestrator guidance.
- They do not automatically change workflow recommendation state.
- No goal selected means no chat UI; show a prompt to start or select a goal.
- Conversation history is persisted and restored when returning to the goal.

## Acceptance Criteria

- With a selected goal, the orchestrator tab always shows a freeform composer.
- With no selected goal, the orchestrator tab shows only the goal-start/select prompt.
- Sending a freeform message creates a persisted goal-scoped chat row.
- Reopening a goal restores the full persisted chat history.
- Workflow prompts and workflow recommendations can appear without removing the normal composer.
- `No pending workflow recommendations` no longer implies that chat input is unavailable.
