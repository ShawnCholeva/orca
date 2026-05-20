import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  ContextAssembly,
  ContextPackage,
  ContextSourceRef,
  type ContextAssemblyFailureCode,
} from '@orca/contracts';

// Internal SQLite row shapes (snake_case, integer booleans, JSON strings)
interface ContextPackageDbRow {
  id: string;
  goal_id: string;
  supersedes_package_id: string | null;
  adapter_id: string;
  workspace_id: string | null;
  role: string;
  objective: string;
  status: string;
  rendered_context: string;
  rendered_bytes: number;
  estimated_tokens: number;
  truncated: 0 | 1;
  sparse: 0 | 1;
  source_count: number;
  sources_json: string;
  warnings_json: string;
  source_fingerprint: string;
  assembler_version: string;
  created_at: string;
}

interface ContextAssemblyDbRow {
  id: string;
  goal_id: string;
  package_id: string | null;
  replace_package_id: string | null;
  adapter_id: string;
  workspace_id: string | null;
  role: string;
  objective_hash: string;
  source_fingerprint: string;
  assembler_version: string;
  request_fingerprint: string;
  status: string;
  trigger: string;
  failure_code: string | null;
  failure_message: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class ContextProjectionError extends Error {
  readonly code = 'context_projection_error' as const;
  constructor(
    public readonly field: string,
    public readonly reason: string
  ) {
    super(`Context projection error in field '${field}': ${reason}`);
    this.name = 'ContextProjectionError';
  }
}

const SourcesSchema = z.array(ContextSourceRef);
const WarningsSchema = z.array(z.string());

function rowToContextPackage(row: ContextPackageDbRow): ContextPackage {
  let sources: z.infer<typeof SourcesSchema>;
  try {
    sources = SourcesSchema.parse(JSON.parse(row.sources_json));
  } catch (err) {
    throw new ContextProjectionError('sources_json', err instanceof Error ? err.message : String(err));
  }

  let warnings: string[];
  try {
    warnings = WarningsSchema.parse(JSON.parse(row.warnings_json));
  } catch (err) {
    throw new ContextProjectionError('warnings_json', err instanceof Error ? err.message : String(err));
  }

  return ContextPackage.parse({
    id: row.id,
    goalId: row.goal_id,
    supersedesPackageId: row.supersedes_package_id,
    adapterId: row.adapter_id,
    workspaceId: row.workspace_id,
    role: row.role,
    objective: row.objective,
    status: row.status,
    renderedContext: row.rendered_context,
    renderedBytes: row.rendered_bytes,
    estimatedTokens: row.estimated_tokens,
    truncated: row.truncated !== 0,
    sparse: row.sparse !== 0,
    sourceCount: row.source_count,
    sources,
    warnings,
    sourceFingerprint: row.source_fingerprint,
    assemblerVersion: row.assembler_version,
    createdAt: row.created_at,
  });
}

function rowToContextAssembly(row: ContextAssemblyDbRow): ContextAssembly {
  return ContextAssembly.parse({
    id: row.id,
    goalId: row.goal_id,
    packageId: row.package_id,
    replacePackageId: row.replace_package_id,
    adapterId: row.adapter_id,
    workspaceId: row.workspace_id,
    role: row.role,
    objectiveHash: row.objective_hash,
    sourceFingerprint: row.source_fingerprint,
    assemblerVersion: row.assembler_version,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    trigger: row.trigger,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

const PKG_COLS = `id, goal_id, supersedes_package_id, adapter_id, workspace_id, role, objective, status,
  rendered_context, rendered_bytes, estimated_tokens, truncated, sparse, source_count,
  sources_json, warnings_json, source_fingerprint, assembler_version, created_at`;

const ASM_COLS = `id, goal_id, package_id, replace_package_id, adapter_id, workspace_id, role,
  objective_hash, source_fingerprint, assembler_version, request_fingerprint,
  status, trigger, failure_code, failure_message, requested_at, started_at, finished_at`;

export interface InsertContextPackageInput {
  id: string;
  goalId: string;
  supersedesPackageId: string | null;
  adapterId: string;
  workspaceId: string | null;
  role: string;
  objective: string;
  status: string;
  renderedContext: string;
  renderedBytes: number;
  estimatedTokens: number;
  truncated: boolean;
  sparse: boolean;
  sourceCount: number;
  sources: z.infer<typeof SourcesSchema>;
  warnings: string[];
  sourceFingerprint: string;
  assemblerVersion: string;
  createdAt: string;
}

export interface InsertContextAssemblyInput {
  id: string;
  goalId: string;
  packageId: string | null;
  replacePackageId: string | null;
  adapterId: string;
  workspaceId: string | null;
  role: string;
  objectiveHash: string;
  sourceFingerprint: string;
  assemblerVersion: string;
  requestFingerprint: string;
  status: string;
  trigger: string;
  failureCode: string | null;
  failureMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function insertContextPackage(db: Database.Database, input: InsertContextPackageInput): void {
  db.prepare(
    `INSERT INTO context_packages (
      id, goal_id, supersedes_package_id, adapter_id, workspace_id, role, objective, status,
      rendered_context, rendered_bytes, estimated_tokens, truncated, sparse, source_count,
      sources_json, warnings_json, source_fingerprint, assembler_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.goalId,
    input.supersedesPackageId,
    input.adapterId,
    input.workspaceId,
    input.role,
    input.objective,
    input.status,
    input.renderedContext,
    input.renderedBytes,
    input.estimatedTokens,
    input.truncated ? 1 : 0,
    input.sparse ? 1 : 0,
    input.sourceCount,
    JSON.stringify(input.sources),
    JSON.stringify(input.warnings),
    input.sourceFingerprint,
    input.assemblerVersion,
    input.createdAt
  );
}

export function insertContextAssembly(db: Database.Database, input: InsertContextAssemblyInput): void {
  db.prepare(
    `INSERT INTO context_assemblies (
      id, goal_id, package_id, replace_package_id, adapter_id, workspace_id, role,
      objective_hash, source_fingerprint, assembler_version, request_fingerprint,
      status, trigger, failure_code, failure_message, requested_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.goalId,
    input.packageId,
    input.replacePackageId,
    input.adapterId,
    input.workspaceId,
    input.role,
    input.objectiveHash,
    input.sourceFingerprint,
    input.assemblerVersion,
    input.requestFingerprint,
    input.status,
    input.trigger,
    input.failureCode,
    input.failureMessage,
    input.requestedAt,
    input.startedAt,
    input.finishedAt
  );
}

export function updateAssemblyStarted(db: Database.Database, id: string, startedAt: string): void {
  db.prepare(
    `UPDATE context_assemblies SET status = 'running', started_at = ? WHERE id = ?`
  ).run(startedAt, id);
}

export function updateAssemblySucceeded(
  db: Database.Database,
  id: string,
  opts: { packageId: string; finishedAt: string }
): void {
  db.prepare(
    `UPDATE context_assemblies SET status = 'succeeded', package_id = ?, finished_at = ? WHERE id = ?`
  ).run(opts.packageId, opts.finishedAt, id);
}

export function updateAssemblyFailed(
  db: Database.Database,
  id: string,
  opts: { failureCode: ContextAssemblyFailureCode; failureMessage: string | null; finishedAt: string }
): void {
  db.prepare(
    `UPDATE context_assemblies SET status = 'failed', failure_code = ?, failure_message = ?, finished_at = ? WHERE id = ?`
  ).run(opts.failureCode, opts.failureMessage, opts.finishedAt, id);
}

export function getContextPackageById(db: Database.Database, id: string): ContextPackage | null {
  const row = db
    .prepare(`SELECT ${PKG_COLS} FROM context_packages WHERE id = ?`)
    .get(id) as ContextPackageDbRow | undefined;
  if (!row) return null;
  return rowToContextPackage(row);
}

export interface ListContextPackagesOptions {
  sessionId?: string;
  adapterId?: string;
  limit: number;
}

export function listContextPackagesByGoal(
  db: Database.Database,
  goalId: string,
  opts: ListContextPackagesOptions
): { packages: ContextPackage[]; assemblies: ContextAssembly[] } {
  const conditions: string[] = ['goal_id = ?'];
  const pkgParams: unknown[] = [goalId];

  if (opts.sessionId) {
    const sessRow = db
      .prepare('SELECT context_package_id FROM sessions WHERE id = ? AND goal_id = ?')
      .get(opts.sessionId, goalId) as { context_package_id: string | null } | undefined;
    const pkgId = sessRow?.context_package_id ?? null;
    if (pkgId === null) {
      return { packages: [], assemblies: [] };
    }
    conditions.push('id = ?');
    pkgParams.push(pkgId);
  }

  if (opts.adapterId) {
    conditions.push('adapter_id = ?');
    pkgParams.push(opts.adapterId);
  }

  pkgParams.push(opts.limit);

  const pkgRows = db
    .prepare(
      `SELECT ${PKG_COLS} FROM context_packages WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...pkgParams) as ContextPackageDbRow[];

  const asmRows = db
    .prepare(
      `SELECT ${ASM_COLS} FROM context_assemblies WHERE goal_id = ? ORDER BY requested_at DESC LIMIT ?`
    )
    .all(goalId, opts.limit) as ContextAssemblyDbRow[];

  return {
    packages: pkgRows.map(rowToContextPackage),
    assemblies: asmRows.map(rowToContextAssembly),
  };
}

export function getActiveAssemblyByFingerprint(
  db: Database.Database,
  goalId: string,
  requestFingerprint: string
): ContextAssembly | null {
  const row = db
    .prepare(
      `SELECT ${ASM_COLS} FROM context_assemblies
       WHERE goal_id = ? AND request_fingerprint = ? AND status IN ('pending', 'running', 'succeeded')
       LIMIT 1`
    )
    .get(goalId, requestFingerprint) as ContextAssemblyDbRow | undefined;
  if (!row) return null;
  return rowToContextAssembly(row);
}

export function getAssembliesByStatus(
  db: Database.Database,
  statuses: string[]
): ContextAssembly[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ${ASM_COLS} FROM context_assemblies WHERE status IN (${placeholders})`
    )
    .all(...statuses) as ContextAssemblyDbRow[];
  return rows.map(rowToContextAssembly);
}

export function setSessionContextPackageId(
  db: Database.Database,
  sessionId: string,
  packageId: string
): void {
  db.prepare('UPDATE sessions SET context_package_id = ? WHERE id = ?').run(packageId, sessionId);
}
