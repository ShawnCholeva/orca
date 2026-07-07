-- Built-in templates share one `version` counter between catalog upgrades and
-- learning-applied forward versions, so a catalog bump numbered at or below an
-- installation's learned version silently never lands (observed live: catalog
-- v7 blocked by an applied proposal that already occupied 7). Track which
-- CATALOG version last landed separately; the boot upgrade guards on this.
-- Backfill with the row's current version: approximately right for rows whose
-- latest write was a catalog upsert, and self-correcting on the next upgrade.
ALTER TABLE workflow_templates ADD COLUMN catalog_version INTEGER;
UPDATE workflow_templates SET catalog_version = version WHERE is_built_in = 1;
