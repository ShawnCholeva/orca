-- Whether the step run is parked on the HUMAN rather than progressing. Set
-- after each orchestrator action: 1 when the action posted a chat reply (the
-- agent answered / escalated and now waits for the user), 0 when it drove the
-- agent instead. A step can be `active` with no live activity for either
-- reason, and the chat cannot tell them apart on its own — without this it
-- claims "Working on <step>…" over an agent that is idle, waiting on you.
ALTER TABLE workflow_step_runs ADD COLUMN awaiting_user INTEGER NOT NULL DEFAULT 0;
