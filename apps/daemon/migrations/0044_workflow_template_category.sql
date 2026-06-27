-- 0044_workflow_template_category.sql
-- Promote template category from catalog-display-only to a first-class persisted
-- attribute so post-install surfaces (Workflows tab filter) read it directly
-- instead of reconstructing it by joining against the catalog by id.
-- Clean-state / future-shape-only: the contract requires `category` (no default).
-- The dev DB is reset, so there is no pre-existing data to migrate — this only
-- defines the column for fresh DBs. The DEFAULT is required by SQLite for an
-- ADD COLUMN NOT NULL and supplies the value for newly-created custom templates.
ALTER TABLE workflow_templates ADD COLUMN category TEXT NOT NULL DEFAULT 'Engineering';
