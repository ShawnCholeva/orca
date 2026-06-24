-- 0042_gate_approval_counts.sql
-- Per-goal, per-action-class approval streaks for executable accountability:
-- after N consecutive approvals with no rejection, the gate proactively offers
-- "always allow". A rejection resets the streak.
CREATE TABLE gate_approval_counts (
  goal_id               TEXT NOT NULL REFERENCES goals(id),
  action_class          TEXT NOT NULL,
  consecutive_approvals INTEGER NOT NULL DEFAULT 0,
  last_decision         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (goal_id, action_class)
);
