CREATE TABLE template_instruction_proposals (
  id                           TEXT PRIMARY KEY,
  template_id                  TEXT NOT NULL,
  template_version_at_proposal INTEGER NOT NULL,
  step_template_id             TEXT NOT NULL,
  before_instructions          TEXT NOT NULL,
  after_instructions           TEXT NOT NULL,
  targeted_failure_mode_json   TEXT NOT NULL,
  predicted_improvement        TEXT NOT NULL,
  invariants_preserved_json    TEXT NOT NULL,
  evidence_json                TEXT NOT NULL,
  rationale                    TEXT NOT NULL,
  human_edited                 INTEGER NOT NULL DEFAULT 0,
  status                       TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  decided_at                   TEXT,
  decided_by                   TEXT,
  applied_as_version           INTEGER
);
CREATE INDEX idx_proposals_template ON template_instruction_proposals (template_id, status);

CREATE TABLE learning_template_baselines (
  template_id         TEXT PRIMARY KEY,
  baseline_steps_json TEXT NOT NULL,
  captured_at         TEXT NOT NULL,
  restored_at         TEXT
);
