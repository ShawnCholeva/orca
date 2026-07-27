-- User-authored definition of done, captured at goal creation (structured list,
-- ≥1 required by the API). Stored as a JSON array of strings. Distinct from the
-- AI-generated goal_refinements.success_criteria. Nullable so existing rows read
-- as [] (rowToGoal defaults null → []).
ALTER TABLE goals ADD COLUMN success_criteria TEXT;
