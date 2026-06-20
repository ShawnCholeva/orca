import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SpoolEntry {
  relUrl: string;
  body: string;
  enqueuedAt: string;
  attempts: number;
}

export function spoolDir(dataDir: string): string {
  return join(dataDir, "hook-spool");
}

export function enqueueSpool(
  dataDir: string,
  entry: { relUrl: string; body: string },
  now: () => string,
): string {
  const dir = spoolDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const full: SpoolEntry = { relUrl: entry.relUrl, body: entry.body, enqueuedAt: now(), attempts: 0 };
  const file = join(dir, `${randomUUID()}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(full), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function listSpool(dataDir: string): Array<{ file: string; entry: SpoolEntry }> {
  const dir = spoolDir(dataDir);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const items: Array<{ file: string; entry: SpoolEntry }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as SpoolEntry;
      if (typeof entry.relUrl === "string" && typeof entry.enqueuedAt === "string") {
        items.push({ file, entry });
      }
    } catch { /* skip corrupt */ }
  }
  items.sort((a, b) => a.entry.enqueuedAt.localeCompare(b.entry.enqueuedAt));
  return items;
}

export function removeSpool(file: string): void {
  rmSync(file, { force: true });
}

export function shouldAgeOut(
  entry: SpoolEntry,
  now: () => string,
  maxAttempts: number,
  maxAgeMs: number,
): boolean {
  if (entry.attempts >= maxAttempts) return true;
  const age = Date.parse(now()) - Date.parse(entry.enqueuedAt);
  return age >= maxAgeMs;
}
