-- 0020_drop_removed_provider_execution_modes.sql
-- Phase 4 cleanup: the opencode, gemini-cli, and shell-manual providers were
-- removed. Their adapter ids are no longer valid AdapterId enum members, so
-- delete the stale seeded execution-mode rows to keep stored data consistent
-- with the contract.
DELETE FROM adapter_execution_modes
WHERE adapter_id IN ('opencode', 'gemini-cli', 'shell-manual');
