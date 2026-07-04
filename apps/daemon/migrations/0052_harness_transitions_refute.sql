-- Add the refute facet column to the harness transition spine (5.4).
ALTER TABLE harness_transitions ADD COLUMN refute_json TEXT;
