-- Persist a template's typed entry inputs (I5, workflow composition).
-- Without this, a DB-round-tripped template loses its `inputs`, so authoring-time
-- validation of a composed parent's `reads` against a child template resolved from
-- the DB (routes.ts getTemplateById resolver) would see empty child inputs and
-- mis-validate. NULL is read back as [] in the projection.
ALTER TABLE workflow_templates ADD COLUMN inputs_json TEXT;
