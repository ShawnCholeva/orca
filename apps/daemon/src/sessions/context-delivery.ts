import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { PtyHandle } from '../pty/types.js';
import type Database from 'better-sqlite3';

const CONTEXT_FILENAME = 'context.txt';
const INITIAL_INPUT_TERMINATOR = '# END ORCA CONTEXT\n';

function sessionContextDir(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'sessions', sessionId);
}

export function sessionContextFilePath(dataDir: string, sessionId: string): string {
  return path.join(sessionContextDir(dataDir, sessionId), CONTEXT_FILENAME);
}

// Returns false if any argv element or env value contains the first 1 KiB of rendered context.
// Guards against regressions that accidentally inline rendered content into process args or env.
export function checkArgvEnvSafety(
  argv: string[],
  env: Record<string, string>,
  renderedContext: string
): boolean {
  if (renderedContext.length === 0) return true;
  const prefix = renderedContext.slice(0, 1024);
  for (const arg of argv) {
    if (arg.includes(prefix)) return false;
  }
  for (const val of Object.values(env)) {
    if (val.includes(prefix)) return false;
  }
  return true;
}

export async function writeContextFile(
  sessionId: string,
  dataDir: string,
  renderedContext: string
): Promise<string> {
  const dir = sessionContextDir(dataDir, sessionId);
  await mkdir(dir, { recursive: true });

  const filePath = sessionContextFilePath(dataDir, sessionId);
  const content = Buffer.from(renderedContext, 'utf8');

  // 'ax' = O_CREAT|O_EXCL|O_WRONLY — fails if a stale file from a previous crashed session exists
  const fh = await open(filePath, 'ax', 0o600);
  try {
    await fh.write(content);
  } finally {
    await fh.close();
  }

  return filePath;
}

export function deliverContextToStdin(handle: PtyHandle, renderedContext: string): void {
  handle.write(Buffer.from(renderedContext + INITIAL_INPUT_TERMINATOR, 'utf8'));
}

export async function deleteContextFile(sessionId: string, dataDir: string): Promise<void> {
  try {
    await unlink(sessionContextFilePath(dataDir, sessionId));
  } catch {
    // ENOENT or already cleaned up — best-effort
  }
}

export async function sweepOrphanContextFiles(
  dataDir: string,
  isActiveSession: (sessionId: string) => boolean
): Promise<void> {
  const sessionsDir = path.join(dataDir, 'sessions');
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (isActiveSession(entry)) continue;
    try {
      await unlink(path.join(sessionsDir, entry, CONTEXT_FILENAME));
    } catch {
      // Best-effort
    }
  }
}

// Reads only the rendered_context column — avoids importing the full context schema
// into the sessions module and loading fields not needed for delivery.
let _deliveryDb: Database.Database | null = null;
let _deliveryStmt: Database.Statement | null = null;

export function getRenderedContextForDelivery(db: Database.Database, packageId: string): string | null {
  if (db !== _deliveryDb) {
    _deliveryDb = db;
    _deliveryStmt = db.prepare('SELECT rendered_context FROM context_packages WHERE id = ?');
  }
  const row = _deliveryStmt!.get(packageId) as { rendered_context: string } | undefined;
  return row?.rendered_context ?? null;
}

export function resetPreparedStatements(): void {
  _deliveryDb = null;
  _deliveryStmt = null;
}
