-- 0039_workflow_run_pending_split_route.sql
-- Deferred-route stash for a splitter parked at a supervised confirmation
-- checkpoint. Mirrors pending_gate_route_json but is consumed only by
-- confirmSplit, so gate and splitter confirmation paths never cross-route.
ALTER TABLE workflow_runs ADD COLUMN pending_split_route_json TEXT;
