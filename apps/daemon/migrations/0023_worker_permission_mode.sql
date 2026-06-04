-- Per-goal worker tool-permission mode: 'ask' (relay residual permission prompts
-- to chat) or 'auto' (auto-allow). Default 'ask' (safe by default).
ALTER TABLE goals
  ADD COLUMN worker_permission_mode TEXT NOT NULL DEFAULT 'ask'
  CHECK (worker_permission_mode IN ('ask', 'auto'));

-- Chat messages can carry a pending permission-approval payload (JSON), parallel
-- to the existing pending_question column.
ALTER TABLE orchestrator_messages
  ADD COLUMN pending_approval TEXT;
