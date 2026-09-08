-- 0067_model_catalog_cache.sql
-- The model catalog read out of an installed agent CLI, keyed by that CLI's
-- version string.
--
-- Keyed by version because the catalog is a property OF a version, not of the
-- machine: re-reading a 199 MB binary on every boot to learn nothing is waste,
-- and a version that has not changed cannot have gained a model.
--
-- This is a cache and never a source of truth. A row is written only from a
-- successful extraction. When extraction fails the reader falls back to the
-- newest row here and then to the checked-in seed, and reports WHICH of the
-- three it used — a stale catalog must be visible as stale, since silently
-- serving last week's models as current is the failure this table risks.
CREATE TABLE model_catalog_cache (
  adapter_id      TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  extracted_at    TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  PRIMARY KEY (adapter_id, adapter_version)
);
