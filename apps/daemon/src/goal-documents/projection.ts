import type Database from "better-sqlite3";
import { GoalDocument } from "@orca/contracts";

export class DuplicateDocumentError extends Error {
  readonly code = "document_duplicate" as const;
  constructor(public readonly ref: string) {
    super(`Document already attached for ref: ${ref}`);
    this.name = "DuplicateDocumentError";
  }
}

export interface GoalDocumentRow {
  id: string;
  goal_id: string;
  kind: "file" | "url";
  ref: string;
  name: string;
  content: string;
  content_hash: string;
  content_bytes: number;
  truncated: number;
  fetched_at: string;
  created_at: string;
}

function toGoalDocument(r: Omit<GoalDocumentRow, "content">): GoalDocument {
  return GoalDocument.parse({
    id: r.id,
    goalId: r.goal_id,
    kind: r.kind,
    ref: r.ref,
    name: r.name,
    contentHash: r.content_hash,
    contentBytes: r.content_bytes,
    truncated: r.truncated === 1,
    fetchedAt: r.fetched_at,
    createdAt: r.created_at,
  });
}

const META_COLUMNS = "id,goal_id,kind,ref,name,content_hash,content_bytes,truncated,fetched_at,created_at";

let _db: Database.Database | null = null;
let _s: Record<string, Database.Statement> | null = null;

function stmts(db: Database.Database) {
  if (db !== _db) {
    _db = db;
    _s = {
      insert: db.prepare(
        "INSERT INTO goal_documents (id,goal_id,kind,ref,name,content,content_hash,content_bytes,truncated,fetched_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),
      byGoal: db.prepare(
        `SELECT ${META_COLUMNS},content FROM goal_documents WHERE goal_id = ? ORDER BY created_at ASC, id ASC`),
      metaByGoal: db.prepare(
        `SELECT ${META_COLUMNS} FROM goal_documents WHERE goal_id = ? ORDER BY created_at ASC, id ASC`),
      byIdAndGoal: db.prepare(
        `SELECT ${META_COLUMNS},content FROM goal_documents WHERE id = ? AND goal_id = ?`),
      byRefAndGoal: db.prepare(
        `SELECT ${META_COLUMNS} FROM goal_documents WHERE goal_id = ? AND ref = ?`),
      updateSnapshot: db.prepare(
        "UPDATE goal_documents SET content = ?, content_hash = ?, content_bytes = ?, truncated = ?, fetched_at = ? WHERE id = ?"),
      touch: db.prepare("UPDATE goal_documents SET fetched_at = ? WHERE id = ?"),
      remove: db.prepare("DELETE FROM goal_documents WHERE id = ? AND goal_id = ?"),
    };
  }
  return _s!;
}

export function resetPreparedStatements(): void { _db = null; _s = null; }

export function insertGoalDocument(db: Database.Database, row: GoalDocumentRow): void {
  try {
    stmts(db).insert.run(
      row.id, row.goal_id, row.kind, row.ref, row.name, row.content,
      row.content_hash, row.content_bytes, row.truncated, row.fetched_at, row.created_at,
    );
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new DuplicateDocumentError(row.ref);
    }
    throw e;
  }
}

export function listGoalDocumentsByGoal(db: Database.Database, goalId: string): GoalDocumentRow[] {
  return stmts(db).byGoal.all(goalId) as GoalDocumentRow[];
}

export function listGoalDocumentMetaByGoal(db: Database.Database, goalId: string): GoalDocument[] {
  return (stmts(db).metaByGoal.all(goalId) as Omit<GoalDocumentRow, "content">[]).map(toGoalDocument);
}

export function findGoalDocument(db: Database.Database, goalId: string, documentId: string): GoalDocumentRow | null {
  return (stmts(db).byIdAndGoal.get(documentId, goalId) as GoalDocumentRow | undefined) ?? null;
}

export function findGoalDocumentByRef(db: Database.Database, goalId: string, ref: string): GoalDocument | null {
  const r = stmts(db).byRefAndGoal.get(goalId, ref) as Omit<GoalDocumentRow, "content"> | undefined;
  return r ? toGoalDocument(r) : null;
}

export function updateGoalDocumentSnapshot(
  db: Database.Database,
  id: string,
  snapshot: { content: string; contentHash: string; contentBytes: number; truncated: boolean; fetchedAt: string },
): void {
  stmts(db).updateSnapshot.run(
    snapshot.content, snapshot.contentHash, snapshot.contentBytes,
    snapshot.truncated ? 1 : 0, snapshot.fetchedAt, id,
  );
}

export function touchGoalDocumentFetchedAt(db: Database.Database, id: string, fetchedAt: string): void {
  stmts(db).touch.run(fetchedAt, id);
}

export function deleteGoalDocument(db: Database.Database, goalId: string, documentId: string): boolean {
  return stmts(db).remove.run(documentId, goalId).changes > 0;
}

export function toGoalDocumentMeta(row: GoalDocumentRow): GoalDocument {
  return toGoalDocument(row);
}
