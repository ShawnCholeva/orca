ALTER TABLE agents ADD COLUMN readiness_status TEXT
  CHECK (readiness_status IS NULL OR readiness_status IN (
    'unchecked','ready','missing','needs_auth','misconfigured','failed'
  ));
ALTER TABLE agents ADD COLUMN readiness_checked_at TEXT;
ALTER TABLE agents ADD COLUMN readiness_detail     TEXT;
ALTER TABLE agents ADD COLUMN readiness_repair     TEXT;
ALTER TABLE agents ADD COLUMN readiness_version    TEXT;
