-- 0021_workflow_template_scope_graph.sql
-- Add scope, scope_name, and graph_json columns to workflow_templates.
-- Existing rows get defaults: scope='global', scope_name='', graph_json=NULL.
ALTER TABLE workflow_templates ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE workflow_templates ADD COLUMN scope_name TEXT NOT NULL DEFAULT '';
ALTER TABLE workflow_templates ADD COLUMN graph_json TEXT;
