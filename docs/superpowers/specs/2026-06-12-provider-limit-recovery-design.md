# Provider Limit Recovery Design

## Summary

When a workflow step agent reaches a provider usage or session limit, Orca must
pause for an explicit user decision instead of blocking the workflow or
automatically switching providers.

The user can:

- wait for the current provider and later retry in the same agent session, or
- switch to another connected, compatible provider when more than one provider
  is connected.

This confirmation is required in both supervised and Auto-run modes.

## Goals

- Preserve the current agent session and context when the user waits.
- Never switch providers without explicit confirmation.
- Show the provider's reset time and timezone when the terminal output contains
  one.
- Offer alternative providers only when at least one other provider is
  connected.
- Clearly explain why connected alternatives are unavailable or incompatible.
- Continue the same workflow step after recovery without losing prior step
  inputs or useful work from the interrupted session.

## Non-Goals

- Automatically switching providers in Auto-run mode.
- Predicting provider quota availability when the provider does not report it.
- Sharing a provider's private native conversation state with another provider.
- Changing normal initial provider selection or workflow template preferences.
- Adding account upgrades, billing flows, or quota purchasing to Orca.

## Recovery State

A provider limit is a recoverable pause, not a terminal workflow failure.

When detected:

1. The workflow run remains `active`.
2. The current step run remains `active`.
3. The current worker session remains alive.
4. Orca persists a provider-recovery checkpoint for the step.
5. The live activity changes to `paused_for_input` with a dedicated
   `provider_recovery_pending` source kind.
6. Repeated output scans are idempotent while that checkpoint exists.

The checkpoint contains:

- workflow run and step run identifiers,
- current session and adapter identifiers,
- provider failure code and user-facing reason,
- detected reset-time text,
- normalized reset instant when it can be resolved,
- detection timestamp,
- eligible and ineligible alternative-provider choices,
- current recovery mode: `choose`, `waiting`, `retrying`, or `switching`.

Only one provider-recovery checkpoint may be active for a step.

## Structured Provider Errors

Provider terminal parsers should return a structured error rather than only an
`Error` message:

- `code`: for example `session_limit`,
- `message`: bounded user-facing summary,
- `resetTimeText`: exact bounded provider text such as
  `4:20am (America/New_York)`,
- `resetAt`: an ISO timestamp when Orca can safely resolve the next occurrence,
- `timezone`: the parsed IANA timezone when present.

For Claude Code, Orca should recognize output such as:

```text
You've hit your session limit · resets 4:20am (America/New_York)
/upgrade to increase your usage limit.
```

Orca must preserve the provider's displayed time and timezone even if it cannot
derive a normalized timestamp. If no reset time is present or parsing fails,
the UI displays `Reset time unavailable`.

## Provider Choices

The recovery card is based on connected agent providers, not every adapter
known to the application.

### One connected provider

Show only the wait-and-retry path. Do not show an empty provider-switching
section.

### Multiple connected providers

Show all other connected providers:

- Ready and compatible providers are selectable.
- Connected but currently unavailable providers are disabled with their
  readiness reason.
- Connected providers that do not support the step's configured model or
  execution requirements are disabled with an incompatibility reason.
- The exhausted current provider appears only in the wait path, not as a switch
  target.

Readiness is refreshed when the recovery card is created and again when the
user attempts a switch. A provider becoming unavailable between those checks
leaves the checkpoint open and displays the new reason.

## Wait And Retry

Choosing **Wait for `<provider>`**:

1. Keeps the current session and its native conversation context.
2. Uses provider-specific terminal handling to dismiss or accept the provider's
   wait state without ending the session.
3. Changes the recovery card to waiting mode.
4. Displays `Available again at <time> <timezone>` when known.
5. Displays `Reset time unavailable` when unknown.
6. Does not automatically send a retry when the time arrives.

When `resetAt` is known, the primary Retry action becomes enabled at that time.
When it is unknown, the manual Retry action remains available so the user can
decide when to test access again.

Choosing **Retry `<provider>`** sends a short continuation instruction through
the existing session, for example `Continue the previous step request.` It does
not create a new session or rebuild the prompt.

After delivery, the checkpoint enters retrying mode. Successful command
delivery alone does not clear it. Orca clears the checkpoint and resumes the
live activity only after observing provider output that proves a new turn has
started. If the same limit screen appears again, Orca returns to waiting mode
and refreshes the reset-time information.

## Switch Provider

Choosing **Switch to `<provider>`**:

1. Rechecks that the selected provider is connected, ready, and compatible.
2. Keeps the old session alive until the replacement has started, accepted its
   initial prompt, and produced evidence that its first turn began.
3. Creates a new session for the same workflow step using the selected adapter.
4. Builds the replacement prompt from:
   - the original goal and step instructions,
   - the step output schema,
   - prior-step artifacts,
   - a bounded transcript or handoff summary from the interrupted session.
5. Updates the step's selected operator and model only after successful startup.
6. Clears the recovery checkpoint, resumes the activity, and retires the old
   session.

The replacement provider receives Orca-managed context, not the old provider's
private native conversation state.

If replacement startup or initial delivery fails, Orca keeps the old session
and recovery checkpoint intact, returns the card to choice mode, and shows the
failure reason. The user can wait or choose another eligible provider.

## User Interface

The provider-recovery card appears in the activity thread where the working
bubble was displayed.

Choice mode includes:

- the interrupted provider and reason,
- reset-time information,
- a **Wait for `<provider>`** action,
- switch actions when another provider is connected,
- disabled connected providers with concise reasons.

Waiting mode includes:

- confirmation that the existing session and context are preserved,
- the reset time and timezone or `Reset time unavailable`,
- a **Retry `<provider>`** action,
- switch choices when eligible alternatives exist.

Retrying and switching modes lock duplicate actions and report the operation in
progress. Errors restore actionable controls rather than replacing the card
with a terminal chat message.

The ordinary chat composer remains available while waiting. Chat messages may
be recorded, but Orca must not forward them to the quota-limited worker until
the recovery checkpoint is cleared. The card explains that pending guidance
will be applied after retry or included in a switched provider's handoff.

## API And Persistence

Add a persisted, typed provider-recovery payload associated with the active
workflow step run. It must survive daemon and desktop restarts.

Expose explicit daemon actions:

- choose the wait path,
- retry the preserved session,
- switch to a selected adapter,
- refresh provider choices.

Requests must include the workflow run and expected recovery checkpoint
identifier so stale or duplicate desktop actions are rejected idempotently.

The workflow/activity event stream notifies the desktop after every recovery
state transition; the desktop must not maintain an independent source of truth.

## Failure Handling

- Unknown or malformed reset times retain the raw bounded text when useful and
  fall back to `Reset time unavailable`.
- Unsupported provider adapters do not crash output scanning; they produce a
  bounded unavailable reason.
- A daemon restart reconstructs the waiting card from persisted state and
  reattaches the preserved worker when it still exists.
- If the preserved worker is gone after restart, Retry is disabled and Orca
  offers a same-provider fresh-session restart alongside eligible switches.
- Repeated session-limit output cannot create duplicate checkpoints, messages,
  sessions, or activities.
- A provider switch is committed only after the replacement session is usable.

## Testing

Daemon tests cover:

- Claude reset-time parsing with timezone and without a reset time,
- one connected provider showing only wait/retry,
- multiple providers with selectable and disabled alternatives,
- provider-limit detection pausing rather than blocking or failing the run,
- wait preserving the same session identifier,
- retry delivery using the same preserved session,
- retry remaining pending until resumed provider activity is observed,
- repeated limit output remaining idempotent,
- successful provider switching with bounded handoff context,
- switch startup failure preserving the old session and checkpoint,
- restart recovery with a live and a missing worker.

Desktop tests cover:

- choice, waiting, and switching card states,
- exact reset-time and unavailable-time labels,
- hiding switch controls with one connected provider,
- disabled provider reasons,
- action locking and error recovery,
- Auto-run still requiring confirmation.

End-to-end verification covers a Claude Code session-limit screen followed by:

- waiting and retrying the same session, and
- switching the same step to Codex after confirmation.

## Success Criteria

- A provider limit no longer leaves the chat indefinitely thinking or
  immediately blocks the workflow.
- Orca never switches providers without a user action.
- Waiting preserves the original session and context.
- The reset time and timezone are visible when supplied by the provider.
- Switching is offered only when another provider is connected.
- A successful recovery continues the same active workflow step.
