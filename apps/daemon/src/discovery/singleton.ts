import { openSync, closeSync, writeSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function lockFilePath(dataDir: string): string {
  return join(dataDir, "daemon.lock");
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we cannot signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600); // wx = O_CREAT | O_EXCL
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export function acquireLock(dataDir: string): boolean {
  const path = lockFilePath(dataDir);
  if (tryCreate(path)) return true;
  // Lock exists — steal it only if its holder is dead.
  let holder = NaN;
  try { holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10); } catch { /* unreadable */ }
  if (!Number.isInteger(holder) || isPidAlive(holder)) return false;
  rmSync(path, { force: true });
  return tryCreate(path);
}

export function releaseLock(dataDir: string): void {
  const path = lockFilePath(dataDir);
  try {
    const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (holder === process.pid) rmSync(path, { force: true });
  } catch { /* nothing to release */ }
}
