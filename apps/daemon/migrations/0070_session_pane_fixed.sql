-- A session whose terminal geometry belongs to the daemon, not to whoever is
-- watching it. Workflow workers run in a tmux pane created at a fixed size and
-- never resized -- the orchestrator reads that pane as text, and a narrower one
-- wraps the status line its busy/idle detection matches on. A viewer must render
-- AT that geometry rather than propose its own, so it has to be able to tell
-- these apart from pty-backed sessions, whose size a viewer does set.
ALTER TABLE sessions ADD COLUMN pane_fixed INTEGER NOT NULL DEFAULT 0;
