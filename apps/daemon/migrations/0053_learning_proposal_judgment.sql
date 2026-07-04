-- The pre-promotion counterfactual judgment, persisted on the proposal ledger (5.2 judge).
ALTER TABLE template_instruction_proposals ADD COLUMN judge_json TEXT;
