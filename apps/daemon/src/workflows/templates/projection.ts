import type Database from "better-sqlite3";
import { WorkflowTemplate, type WorkflowTemplate as WorkflowTemplateT } from "@orca/contracts";

interface WorkflowTemplateRow {
  id: string;
  name: string;
  description: string;
  version: number;
  is_built_in: number;
  is_locked: number;
  steps_json: string;
  guardrails_json: string;
  created_at: string;
  updated_at: string;
  scope: string;
  scope_name: string;
  graph_json: string | null;
}

let _db: Database.Database | null = null;
let _stmts: {
  getById: Database.Statement;
  listAll: Database.Statement;
} | null = null;

function ensureStmts(db: Database.Database): NonNullable<typeof _stmts> {
  if (_db !== db) {
    _db = db;
    _stmts = {
      getById: db.prepare(
        "SELECT id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, graph_json FROM workflow_templates WHERE id = ?"
      ),
      listAll: db.prepare(
        "SELECT id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at, scope, scope_name, graph_json FROM workflow_templates ORDER BY is_built_in DESC, name ASC"
      ),
    };
  }
  return _stmts!;
}

export function resetPreparedStatements(): void {
  _db = null;
  _stmts = null;
}

function rowToTemplate(row: WorkflowTemplateRow): WorkflowTemplateT {
  return WorkflowTemplate.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    isBuiltIn: row.is_built_in !== 0,
    isLocked: row.is_locked !== 0,
    steps: JSON.parse(row.steps_json),
    guardrails: JSON.parse(row.guardrails_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scope: row.scope,
    scopeName: row.scope_name,
    graph: row.graph_json ? JSON.parse(row.graph_json) : null,
  });
}

export function getTemplateById(db: Database.Database, id: string): WorkflowTemplateT | null {
  const row = ensureStmts(db).getById.get(id) as WorkflowTemplateRow | undefined;
  return row ? rowToTemplate(row) : null;
}

export function listTemplates(db: Database.Database): WorkflowTemplateT[] {
  const rows = ensureStmts(db).listAll.all() as WorkflowTemplateRow[];
  return rows.map(rowToTemplate);
}
