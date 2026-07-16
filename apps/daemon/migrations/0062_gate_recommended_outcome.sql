-- Phase 1 scoring: persist the gate's PROPOSED verdict distinctly from the human's
-- resolution so reviewer-overturn (false acceptance) is computable. Nullable: historical
-- rows and automated-path rows (no human) legitimately have no proposal to compare.
ALTER TABLE workflow_gate_decisions ADD COLUMN recommended_outcome TEXT;
ALTER TABLE workflow_gate_decisions ADD COLUMN recommended_reason TEXT;
ALTER TABLE workflow_gate_decisions ADD COLUMN recommended_issue_refs_json TEXT;
