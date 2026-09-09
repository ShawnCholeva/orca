-- Sessions launched into tmux by the orchestrator before the daemon recorded
-- their pane geometry. Every one of them was created by newSession at the same
-- fixed size, so the size is known even though it was never written down -- and
-- without it a viewer sizes itself and scrambles their recorded redraws. The
-- literals are the WORKER_PANE_COLS/ROWS of the day, stated here as the historical
-- fact they are; the constant is free to change for panes created after this.
UPDATE sessions
   SET pane_fixed = 1, terminal_cols = 220, terminal_rows = 50
 WHERE workflow_step_run_id IS NOT NULL
   AND pane_fixed = 0
   AND terminal_cols IS NULL;
