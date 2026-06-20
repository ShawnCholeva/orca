import { writeFileSync, readFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveryRecord {
  version: 1;
  url: string;
  token: string;
  pid: number;
  startedAt: string;
  protocol: "http";
}

export function discoveryFilePath(dataDir: string): string {
  return join(dataDir, "daemon.json");
}

export function writeDiscoveryFile(dataDir: string, rec: DiscoveryRecord): void {
  const target = discoveryFilePath(dataDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

export function readDiscoveryFile(dataDir: string): DiscoveryRecord | null {
  try {
    const raw = readFileSync(discoveryFilePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as DiscoveryRecord;
    if (parsed.version !== 1 || typeof parsed.url !== "string" || typeof parsed.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function removeDiscoveryFile(dataDir: string): void {
  rmSync(discoveryFilePath(dataDir), { force: true });
}
