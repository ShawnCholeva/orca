-- 0019_orchestrator_messages_pending_question.sql
-- Add nullable pending_question column (JSON) to orchestrator_messages.
ALTER TABLE orchestrator_messages ADD COLUMN pending_question TEXT;
