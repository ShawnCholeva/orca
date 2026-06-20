# Daemon Independent Service + Resolved Addressing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Orca daemon an independent singleton service that workers reach through a fire-time hook resolver + discovery file, with spooled at-least-once delivery, so daemon restarts never orphan in-flight workers or accumulate stale daemons.

**Architecture:** The daemon writes a discovery file (`~/.orca/daemon.json`) with its current `{url, token, pid}` and enforces a single instance via a lockfile. Worker/shadow Claude Code hooks change from baked `type:"http"` URLs to a `type:"command"` resolver (`orca-daemon hook <relUrl>`) that reads the discovery file at fire-time and proxies the request, spooling to disk if the daemon is momentarily down. The daemon drains the spool on startup. The desktop becomes a client that adopts a healthy running daemon or spawns a detached one.

**Tech Stack:** TypeScript (Node, Fastify, better-sqlite3, Zod, Vitest) for the daemon; Rust (Tauri) for the desktop launcher.

## Global Constraints

- Data dir resolution stays as in `apps/daemon/src/config.ts`: `ORCA_DATA_DIR` env, else `~/.orca` (macOS/Linux) or `%APPDATA%/Orca` (Windows). All new files live under `dataDir`.
- File permissions: `dataDir` `0700`; `daemon.json`, spool entries, lockfile `0600`. On Windows, perms are best-effort (skip `chmod`).
- All writes to files under `dataDir` are atomic: write to `<name>.tmp` then `rename`.
- The resolver must be cross-platform (macOS + Windows) and must NEVER block the agent on non-interactive hooks.
- Keep existing module patterns: ESM `.js` import specifiers, named exports, Vitest `describe/it/expect`, `() => new Date().toISOString()` clock injection where a clock is needed.
- The only currently-unauthenticated HTTP route is `GET /v1/health` (`server.ts:335`). Do not add new unauthenticated routes.
- Token stays a fresh UUID per launch (rotation is intentional); it is never baked into worker artifacts.

---

## File Structure

**New (daemon):**
- `apps/daemon/src/discovery/discovery-file.ts` — read/write/staleness of `daemon.json`.
- `apps/daemon/src/discovery/discovery-file.test.ts`
- `apps/daemon/src/discovery/singleton.ts` — lockfile acquire/release + liveness probe.
- `apps/daemon/src/discovery/singleton.test.ts`
- `apps/daemon/src/discovery/spool.ts` — spool dir paths, enqueue, list/drain iteration, age-out.
- `apps/daemon/src/discovery/spool.test.ts`
- `apps/daemon/src/hooks-resolver/resolver.ts` — pure `resolveAndDeliver()` core.
- `apps/daemon/src/hooks-resolver/resolver.test.ts`

**Modified (daemon):**
- `apps/daemon/src/agent-hooks/hook-settings.ts` — emit command hooks.
- `apps/daemon/src/agent-hooks/hook-settings.test.ts`
- `apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts` — emit command hooks.
- `apps/daemon/src/orchestrator-llm/shadow-hook-settings.test.ts`
- `apps/daemon/src/orchestrator-llm/providers/claude.ts` — drop `port`/`authToken`, take `resolverCommand`.
- `apps/daemon/src/config.ts` — add `hookResolverCommand`.
- `apps/daemon/src/server.ts` — extend `/v1/health` with `service` + `pid`.
- `apps/daemon/src/index.ts` — argv dispatch (`hook`/`--stop`), singleton guard, write discovery file, drain spool.
- `apps/daemon/src/shutdown.ts` — remove discovery file + release lock on shutdown.

**Modified (desktop):**
- `apps/desktop/src-tauri/src/lib.rs` — adopt-or-spawn, detached spawn, remove kill-on-exit.

**New (test):**
- `apps/daemon/test/daemon-restart-spool.integration.test.ts` — the regression guard.

---

### Task 1: Discovery file module

**Files:**
- Create: `apps/daemon/src/discovery/discovery-file.ts`
- Test: `apps/daemon/src/discovery/discovery-file.test.ts`

**Interfaces:**
- Produces:
  - `interface DiscoveryRecord { version: 1; url: string; token: string; pid: number; startedAt: string; protocol: "http" }`
  - `function discoveryFilePath(dataDir: string): string`
  - `function writeDiscoveryFile(dataDir: string, rec: DiscoveryRecord): void` (atomic, mode 0600)
  - `function readDiscoveryFile(dataDir: string): DiscoveryRecord | null` (null if absent/corrupt)
  - `function removeDiscoveryFile(dataDir: string): void` (best-effort)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/daemon/src/discovery/discovery-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoveryFilePath,
  writeDiscoveryFile,
  readDiscoveryFile,
  removeDiscoveryFile,
  type DiscoveryRecord,
} from "./discovery-file.js";

const rec: DiscoveryRecord = {
  version: 1,
  url: "http://127.0.0.1:8787",
  token: "tok-123",
  pid: 4242,
  startedAt: "2026-06-20T00:00:00.000Z",
  protocol: "http",
};

describe("discovery-file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-disc-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes and reads back the record", () => {
    writeDiscoveryFile(dir, rec);
    expect(readDiscoveryFile(dir)).toEqual(rec);
  });

  it("path is daemon.json under dataDir", () => {
    expect(discoveryFilePath(dir)).toBe(join(dir, "daemon.json"));
  });

  it("returns null when absent", () => {
    expect(readDiscoveryFile(dir)).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    writeFileSync(discoveryFilePath(dir), "{not json", "utf8");
    expect(readDiscoveryFile(dir)).toBeNull();
  });

  it("removeDiscoveryFile is idempotent", () => {
    writeDiscoveryFile(dir, rec);
    removeDiscoveryFile(dir);
    removeDiscoveryFile(dir);
    expect(existsSync(discoveryFilePath(dir))).toBe(false);
  });

  it("writes with 0600 permissions (non-Windows)", () => {
    if (process.platform === "win32") return;
    writeDiscoveryFile(dir, rec);
    expect(statSync(discoveryFilePath(dir)).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test discovery-file`
Expected: FAIL — cannot find module `./discovery-file.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/discovery/discovery-file.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test discovery-file`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/discovery/discovery-file.ts apps/daemon/src/discovery/discovery-file.test.ts
git commit -m "feat(daemon): discovery-file read/write for daemon addressing"
```

---

### Task 2: Singleton lock + liveness

**Files:**
- Create: `apps/daemon/src/discovery/singleton.ts`
- Test: `apps/daemon/src/discovery/singleton.test.ts`

**Interfaces:**
- Consumes: nothing (uses `node:fs`, `node:process`).
- Produces:
  - `function isPidAlive(pid: number): boolean` (via `process.kill(pid, 0)`)
  - `function acquireLock(dataDir: string): boolean` — `O_EXCL` create of `daemon.lock` containing this pid; returns true if acquired. If the lock exists but its pid is dead, steal it (remove + retry once).
  - `function releaseLock(dataDir: string): void` — remove `daemon.lock` if it holds our pid.
  - `function lockFilePath(dataDir: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/daemon/src/discovery/singleton.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, lockFilePath, isPidAlive } from "./singleton.js";

describe("singleton lock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-lock-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("acquires when free, blocks a second live holder", () => {
    expect(acquireLock(dir)).toBe(true);
    // simulate a different live holder by leaving our own pid in the file
    expect(acquireLock(dir)).toBe(false);
  });

  it("steals a lock held by a dead pid", () => {
    writeFileSync(lockFilePath(dir), "999999999", "utf8"); // pid that does not exist
    expect(acquireLock(dir)).toBe(true);
  });

  it("releaseLock removes our lock", () => {
    acquireLock(dir);
    releaseLock(dir);
    expect(existsSync(lockFilePath(dir))).toBe(false);
  });

  it("isPidAlive true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("isPidAlive false for impossible pid", () => {
    expect(isPidAlive(999999999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test singleton`
Expected: FAIL — cannot find module `./singleton.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/discovery/singleton.ts
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
  if (Number.isInteger(holder) && holder !== process.pid && isPidAlive(holder)) return false;
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
```

Note: the test's "blocks a second live holder" case passes because the first `acquireLock` writes *our own* pid, which `isPidAlive` reports alive, so the second call returns false.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test singleton`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/discovery/singleton.ts apps/daemon/src/discovery/singleton.test.ts
git commit -m "feat(daemon): singleton lockfile with dead-holder steal"
```

---

### Task 3: Hook spool (enqueue, list, age-out)

**Files:**
- Create: `apps/daemon/src/discovery/spool.ts`
- Test: `apps/daemon/src/discovery/spool.test.ts`

**Interfaces:**
- Produces:
  - `interface SpoolEntry { relUrl: string; body: string; enqueuedAt: string; attempts: number }`
  - `function spoolDir(dataDir: string): string`
  - `function enqueueSpool(dataDir: string, entry: { relUrl: string; body: string }, now: () => string): string` — writes `<uuid>.json`, returns the file path.
  - `function listSpool(dataDir: string): Array<{ file: string; entry: SpoolEntry }>` — sorted oldest-first by `enqueuedAt`, skipping corrupt files.
  - `function removeSpool(file: string): void`
  - `function shouldAgeOut(entry: SpoolEntry, now: () => string, maxAttempts: number, maxAgeMs: number): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/daemon/src/discovery/spool.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueSpool, listSpool, removeSpool, shouldAgeOut, spoolDir } from "./spool.js";

const clock = (iso: string) => () => iso;

describe("hook spool", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-spool-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("enqueues then lists oldest-first", () => {
    enqueueSpool(dir, { relUrl: "/v1/agent-hooks/stop?sessionId=b", body: "{}" }, clock("2026-06-20T00:00:02.000Z"));
    enqueueSpool(dir, { relUrl: "/v1/agent-hooks/stop?sessionId=a", body: "{}" }, clock("2026-06-20T00:00:01.000Z"));
    const items = listSpool(dir);
    expect(items.map((i) => i.entry.relUrl)).toEqual([
      "/v1/agent-hooks/stop?sessionId=a",
      "/v1/agent-hooks/stop?sessionId=b",
    ]);
    expect(items[0].entry.attempts).toBe(0);
  });

  it("removeSpool deletes the file", () => {
    const file = enqueueSpool(dir, { relUrl: "/x", body: "{}" }, clock("2026-06-20T00:00:00.000Z"));
    removeSpool(file);
    expect(existsSync(file)).toBe(false);
  });

  it("creates the spool dir on demand", () => {
    enqueueSpool(dir, { relUrl: "/x", body: "{}" }, clock("2026-06-20T00:00:00.000Z"));
    expect(existsSync(spoolDir(dir))).toBe(true);
  });

  it("ages out past max attempts", () => {
    const entry = { relUrl: "/x", body: "{}", enqueuedAt: "2026-06-20T00:00:00.000Z", attempts: 5 };
    expect(shouldAgeOut(entry, clock("2026-06-20T00:00:01.000Z"), 5, 86_400_000)).toBe(true);
  });

  it("ages out past max age", () => {
    const entry = { relUrl: "/x", body: "{}", enqueuedAt: "2026-06-19T00:00:00.000Z", attempts: 0 };
    expect(shouldAgeOut(entry, clock("2026-06-21T00:00:00.000Z"), 5, 86_400_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test spool`
Expected: FAIL — cannot find module `./spool.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/discovery/spool.ts
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  // rename is atomic within the same dir
  rmSync(file, { force: true });
  writeFileSync(file, readFileSync(tmp, "utf8"), { encoding: "utf8", mode: 0o600 });
  rmSync(tmp, { force: true });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test spool`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/discovery/spool.ts apps/daemon/src/discovery/spool.test.ts
git commit -m "feat(daemon): hook spool enqueue/list/age-out"
```

---

### Task 4: Extend `/v1/health` with service identity

**Files:**
- Modify: `apps/daemon/src/server.ts` (the `/v1/health` handler, ~`server.ts:346`)
- Test: extend `apps/daemon/src/server.test.ts` (health assertion)

**Interfaces:**
- Produces: `GET /v1/health` response now includes `service: "orca-daemon"` and `pid: number`. The desktop/resolver use `service === "orca-daemon"` to confirm identity before adopting.

**Note:** `HealthResponse` is a contract type. If `HealthResponse` is defined in `@orca/contracts`, add the two fields there; if it is a local interface in `server.ts`, add them locally. Search first: `grep -rn "HealthResponse" packages/contracts apps/daemon/src`.

- [ ] **Step 1: Write the failing test**

Find the existing health test in `apps/daemon/src/server.test.ts` (`grep -n "v1/health" apps/daemon/src/server.test.ts`) and add assertions in that test body:

```typescript
// inside the existing "GET /v1/health" test, after parsing the body:
expect(body.service).toBe("orca-daemon");
expect(typeof body.pid).toBe("number");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test server.test -t health`
Expected: FAIL — `body.service` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `apps/daemon/src/server.ts`, extend the handler:

```typescript
  server.get('/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'orca-daemon',
    pid: process.pid,
    version: pkg.version,
    startedAt,
    registries: {
      plugins: pluginRegistry.list().length,
      skills: skillRegistry.listPublic().length
    }
  }));
```

Add `service: string` and `pid: number` to the `HealthResponse` type wherever it is defined.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test server.test -t health`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.test.ts packages/contracts/src/index.ts
git commit -m "feat(daemon): /v1/health reports service identity + pid"
```

---

### Task 5: Resolver core (`resolveAndDeliver`)

**Files:**
- Create: `apps/daemon/src/hooks-resolver/resolver.ts`
- Test: `apps/daemon/src/hooks-resolver/resolver.test.ts`

**Interfaces:**
- Consumes: `readDiscoveryFile` (Task 1), `enqueueSpool` (Task 3).
- Produces:
  - `interface ResolverResult { exitCode: number; stdout: string }`
  - `async function resolveAndDeliver(args: { dataDir: string; relUrl: string; body: string; spoolable: boolean; now: () => string; fetchImpl?: typeof fetch }): Promise<ResolverResult>`
  - Behavior:
    - Read discovery file. If missing → if `spoolable`, enqueue + `{exitCode:0, stdout:""}`; else `{exitCode:0, stdout:'{"decision":"deny"}'}` (fail-safe; exit 0 so the hook does not crash the agent).
    - POST `<url><relUrl>` with `Authorization: Bearer <token>`, `content-type: application/json`, body = `body`. On 2xx → relay `{exitCode:0, stdout:<responseText>}`. On non-2xx → same spool/deny policy as a connection failure.
    - On thrown/connection error → spool (if spoolable) else deny, exit 0.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/daemon/src/hooks-resolver/resolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscoveryFile } from "../discovery/discovery-file.js";
import { listSpool } from "../discovery/spool.js";
import { resolveAndDeliver } from "./resolver.js";

const now = () => "2026-06-20T00:00:00.000Z";
const disc = {
  version: 1 as const, url: "http://127.0.0.1:9", token: "tok", pid: 1,
  startedAt: now(), protocol: "http" as const,
};

describe("resolveAndDeliver", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-res-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("delivers and relays the daemon response on 2xx", async () => {
    writeDiscoveryFile(dir, { ...disc, url: "http://daemon.test" });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://daemon.test/v1/agent-hooks/stop?sessionId=s1");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/stop?sessionId=s1",
      body: "{}", spoolable: true, now, fetchImpl,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{"ok":true}');
    expect(listSpool(dir)).toHaveLength(0);
  });

  it("spools when discovery file is missing and spoolable", async () => {
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/stop?sessionId=s1",
      body: "{}", spoolable: true, now,
    });
    expect(r.exitCode).toBe(0);
    expect(listSpool(dir)).toHaveLength(1);
  });

  it("denies (no spool) when not spoolable and daemon unreachable", async () => {
    writeDiscoveryFile(dir, disc); // url points at closed port
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/permission?sessionId=s1",
      body: "{}", spoolable: false, now, fetchImpl,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("deny");
    expect(listSpool(dir)).toHaveLength(0);
  });

  it("spools on connection error when spoolable", async () => {
    writeDiscoveryFile(dir, disc);
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/stop?sessionId=s1",
      body: "{}", spoolable: true, now, fetchImpl,
    });
    expect(r.exitCode).toBe(0);
    expect(listSpool(dir)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test resolver`
Expected: FAIL — cannot find module `./resolver.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/daemon/src/hooks-resolver/resolver.ts
import { readDiscoveryFile } from "../discovery/discovery-file.js";
import { enqueueSpool } from "../discovery/spool.js";

export interface ResolverResult {
  exitCode: number;
  stdout: string;
}

const DENY = '{"decision":"deny","reason":"orca daemon unreachable"}';

export async function resolveAndDeliver(args: {
  dataDir: string;
  relUrl: string;
  body: string;
  spoolable: boolean;
  now: () => string;
  fetchImpl?: typeof fetch;
}): Promise<ResolverResult> {
  const fetchFn = args.fetchImpl ?? fetch;
  const fallback = (): ResolverResult => {
    if (args.spoolable) {
      enqueueSpool(args.dataDir, { relUrl: args.relUrl, body: args.body }, args.now);
      return { exitCode: 0, stdout: "" };
    }
    return { exitCode: 0, stdout: DENY };
  };

  const disc = readDiscoveryFile(args.dataDir);
  if (!disc) return fallback();

  try {
    const res = await fetchFn(`${disc.url}${args.relUrl}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${disc.token}`, "content-type": "application/json" },
      body: args.body,
    });
    if (res.status < 200 || res.status >= 300) return fallback();
    return { exitCode: 0, stdout: await res.text() };
  } catch {
    return fallback();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test resolver`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/hooks-resolver/resolver.ts apps/daemon/src/hooks-resolver/resolver.test.ts
git commit -m "feat(daemon): hook resolver core with spool/deny fallback"
```

---

### Task 6: Hook-settings builders emit command hooks

**Files:**
- Modify: `apps/daemon/src/agent-hooks/hook-settings.ts`
- Modify: `apps/daemon/src/agent-hooks/hook-settings.test.ts`
- Modify: `apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts`
- Modify: `apps/daemon/src/orchestrator-llm/shadow-hook-settings.test.ts`

**Interfaces:**
- Consumes: a `resolverCommand: string[]` — the argv prefix that invokes the daemon's hook subcommand (e.g. `["/abs/orca-daemon"]` for prod SEA, or `["node", "/abs/dist/index.js"]` for dev). Produced by Task 8/config.
- Produces:
  - `buildAgentHookSettings(args: { sessionId: string; resolverCommand: string[] }): AgentHookSettings`
  - `buildShadowHookSettings(args: { goalId: string; resolverCommand: string[] }): ShadowHookSettings`
  - Hook entries are now `{ type: "command"; command: string; timeout?: number }`. `command` is a single shell string: `<resolverCommand...> hook <relUrl> [--spool]`, with each argv element shell-quoted.
  - Stop/StopFailure/tool-use are `--spool` (non-interactive); elicit/permission are NOT `--spool` (interactive).

- [ ] **Step 1: Update the failing tests**

Replace the agent-hooks test body assertions:

```typescript
// apps/daemon/src/agent-hooks/hook-settings.test.ts
import { describe, it, expect } from "vitest";
import { buildAgentHookSettings } from "./hook-settings.js";

describe("buildAgentHookSettings", () => {
  const settings = buildAgentHookSettings({
    sessionId: "s1",
    resolverCommand: ["/abs/orca-daemon"],
  });

  it("emits command hooks (no http url, no token)", () => {
    const json = JSON.stringify(settings);
    expect(json).not.toContain("http://");
    expect(json).not.toContain("Bearer");
    expect(settings.hooks.Stop[0].hooks[0].type).toBe("command");
  });

  it("stop hook targets the agent-hooks stop relUrl and is spoolable", () => {
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("hook");
    expect(cmd).toContain("/v1/agent-hooks/stop?sessionId=s1");
    expect(cmd).toContain("--spool");
  });

  it("permission hook is NOT spoolable", () => {
    const cmd = settings.hooks.PermissionRequest![0].hooks[0].command;
    expect(cmd).toContain("/v1/agent-hooks/permission?sessionId=s1");
    expect(cmd).not.toContain("--spool");
  });

  it("shell-quotes resolver args with spaces", () => {
    const s = buildAgentHookSettings({ sessionId: "s1", resolverCommand: ["/abs path/orca-daemon"] });
    expect(s.hooks.Stop[0].hooks[0].command).toContain("'/abs path/orca-daemon'");
  });
});
```

Add the analogous test in `shadow-hook-settings.test.ts` asserting `/v1/shadow-hooks/stop?goalId=g1` and `--spool`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon test hook-settings shadow-hook-settings`
Expected: FAIL — `command` undefined / signature mismatch.

- [ ] **Step 3: Implement the builders**

```typescript
// apps/daemon/src/agent-hooks/hook-settings.ts
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_/.:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function resolverCommand(prefix: string[], relUrl: string, spool: boolean): string {
  const parts = [...prefix, "hook", relUrl, ...(spool ? ["--spool"] : [])];
  return parts.map(shellQuote).join(" ");
}

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

export interface AgentHookSettings {
  hooks: {
    Stop: Array<{ hooks: CommandHook[] }>;
    StopFailure: Array<{ hooks: CommandHook[] }>;
    PreToolUse?: Array<{ matcher: string; hooks: CommandHook[] }>;
    PermissionRequest?: Array<{ matcher: string; hooks: CommandHook[] }>;
  };
}

export function buildAgentHookSettings(args: {
  sessionId: string;
  resolverCommand: string[];
}): AgentHookSettings {
  const sid = encodeURIComponent(args.sessionId);
  const cmd = (relUrl: string, spool: boolean) => resolverCommand(args.resolverCommand, relUrl, spool);
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/stop?sessionId=${sid}`, true) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/stop?sessionId=${sid}&failure=1`, true) }] }],
      PreToolUse: [
        { matcher: "AskUserQuestion", hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/elicit?sessionId=${sid}`, false), timeout: 600 }] },
        { matcher: "*", hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/tool-use?sessionId=${sid}`, true), timeout: 5 }] },
      ],
      PermissionRequest: [
        { matcher: "*", hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/permission?sessionId=${sid}`, false), timeout: 1800 }] },
      ],
    },
  };
}
```

Delete the now-unused `agentHookUrl/elicitHookUrl/permissionHookUrl/toolUseHookUrl` exports and the old `HttpHook` interface. Apply the same pattern to `shadow-hook-settings.ts` (`buildShadowHookSettings({ goalId, resolverCommand })` → Stop/StopFailure command hooks targeting `/v1/shadow-hooks/stop?goalId=<g>` with `--spool`; remove `shadowHookUrl` and `HttpHook`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon test hook-settings shadow-hook-settings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/agent-hooks/hook-settings.ts apps/daemon/src/agent-hooks/hook-settings.test.ts apps/daemon/src/orchestrator-llm/shadow-hook-settings.ts apps/daemon/src/orchestrator-llm/shadow-hook-settings.test.ts
git commit -m "feat(daemon): hook settings emit resolver command hooks (no baked port/token)"
```

---

### Task 7: Config + claude.ts wiring for `resolverCommand`

**Files:**
- Modify: `apps/daemon/src/config.ts` (add `hookResolverCommand: string[]`)
- Modify: `apps/daemon/src/orchestrator-llm/providers/claude.ts` (`hookConfig`/`workerHookConfig` signatures)
- Modify any call sites of `hookConfig`/`workerHookConfig` (search: `grep -rn "hookConfig\|workerHookConfig" apps/daemon/src | grep -v test`)

**Interfaces:**
- Consumes: `buildAgentHookSettings`/`buildShadowHookSettings` (Task 6).
- Produces:
  - `Config.hookResolverCommand: string[]` — resolved at load time:
    - If `process.env.ORCA_SIDECAR_BIN` is set (prod SEA), use `[that]`.
    - Else use `[process.execPath, fileURLToPath(import.meta.url resolved to the daemon entry)]`. Concretely: resolve the daemon entry as the compiled `index.js`. For dev/tsx and prod, `[process.execPath, process.argv[1]]` is correct because `process.argv[1]` is the entry the daemon was launched with. Capture it in `config.ts` at module load.
  - `ClaudeShadowProvider.hookConfig(args: { goalId: string; resolverCommand: string[] })`
  - `ClaudeShadowProvider.workerHookConfig(args: { goalId: string; sessionId: string; resolverCommand: string[]; configDir: string })`

**Note on entry resolution:** the resolver must re-invoke the *daemon* entrypoint with the `hook` subcommand. `process.argv[1]` at daemon startup is that entrypoint path. Pass `config.hookResolverCommand` down to wherever sessions are spawned (the same place that currently passes `config.port` + `config.getAuthToken()` to `hookConfig`/`workerHookConfig`).

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/daemon/src/config.test.ts
import { loadConfig } from "./config.js";
it("exposes a non-empty hookResolverCommand", () => {
  const cfg = loadConfig();
  expect(Array.isArray(cfg.hookResolverCommand)).toBe(true);
  expect(cfg.hookResolverCommand.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test config.test -t hookResolverCommand`
Expected: FAIL — `hookResolverCommand` undefined.

- [ ] **Step 3: Implement**

In `config.ts`, add to `Config` and `loadConfig`:

```typescript
// in Config interface:
  hookResolverCommand: string[];

// in loadConfig(), before the return:
  const sidecarBin = process.env.ORCA_SIDECAR_BIN?.trim();
  const hookResolverCommand =
    sidecarBin && sidecarBin.length > 0
      ? [sidecarBin]
      : [process.execPath, process.argv[1] ?? ""];

// add to the returned object:
  hookResolverCommand,
```

In `claude.ts`, change `hookConfig` and `workerHookConfig` to take `resolverCommand` instead of `port`/`authToken`, and pass it through to the builders:

```typescript
  hookConfig(args: { goalId: string; resolverCommand: string[] }): ShadowHookConfig {
    return {
      files: [{ relPath: ".claude/settings.local.json",
        contents: JSON.stringify(buildShadowHookSettings(args), null, 2) }],
      // ...unchanged spawnArgs/other fields
    };
  },

  workerHookConfig(args: { goalId: string; sessionId: string; resolverCommand: string[]; configDir: string }) {
    const settings = buildAgentHookSettings({ sessionId: args.sessionId, resolverCommand: args.resolverCommand });
    return {
      files: [{ relPath: "settings.json", contents: JSON.stringify(settings, null, 2) }],
      spawnArgs: ["--settings", join(args.configDir, "settings.json")],
    };
  },
```

Update the `ShadowProvider` interface type for `hookConfig`/`workerHookConfig` (search `grep -rn "hookConfig" apps/daemon/src/orchestrator-llm` and the provider interface in `adapters/types.ts` or `orchestrator-llm/providers/*`), and update the call sites to pass `config.hookResolverCommand` where they currently pass `config.port`/`config.getAuthToken()`.

- [ ] **Step 4: Run the relevant suites**

Run: `pnpm --filter @orca/daemon test config.test claude`
Expected: PASS. Then `pnpm --filter @orca/daemon typecheck` — fix any call sites still passing `port`/`authToken`.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/config.ts apps/daemon/src/config.test.ts apps/daemon/src/orchestrator-llm/providers/claude.ts apps/daemon/src/adapters/types.ts
git commit -m "feat(daemon): thread hookResolverCommand into worker/shadow hook config"
```

---

### Task 8: Daemon argv dispatch — `hook` and `--stop` subcommands

**Files:**
- Modify: `apps/daemon/src/index.ts`

**Interfaces:**
- Consumes: `resolveAndDeliver` (Task 5), `readDiscoveryFile` (Task 1), `isPidAlive` (Task 2).
- Produces: the daemon binary/entry now branches on argv before starting the server:
  - `orca-daemon hook <relUrl> [--spool]` → read stdin fully, call `resolveAndDeliver`, write `stdout`, `process.exit(result.exitCode)`. Never starts the server.
  - `orca-daemon --stop` → read discovery file; if pid alive, `process.kill(pid, "SIGTERM")`; exit 0.
  - otherwise → `startDaemon()`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/daemon/src/index.hook-subcommand.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSpool } from "./discovery/spool.js";

describe("hook subcommand (spools when no daemon)", () => {
  it("exits 0 and spools a stop hook when discovery file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-hookcmd-"));
    try {
      // run via tsx so the .ts entry executes
      execFileSync(
        "node",
        ["--import", "tsx", join(__dirname, "index.ts"), "hook", "/v1/agent-hooks/stop?sessionId=s1", "--spool"],
        { input: "{}", env: { ...process.env, ORCA_DATA_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] },
      );
      expect(listSpool(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

(If the repo's vitest cannot resolve `__dirname` under ESM, use `fileURLToPath(new URL(".", import.meta.url))` to compute the dir.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test index.hook-subcommand`
Expected: FAIL — `hook` arg currently ignored; daemon tries to start; no spool written.

- [ ] **Step 3: Implement argv dispatch**

Replace the `isMainEntrypoint()` tail of `index.ts` with:

```typescript
async function runHookSubcommand(relUrl: string, spool: boolean): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const { resolveAndDeliver } = await import("./hooks-resolver/resolver.js");
  const cfg = loadConfig();
  const body = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    if (process.stdin.isTTY) resolve(""); // no piped input
  });
  const result = await resolveAndDeliver({
    dataDir: cfg.dataDir, relUrl, body, spoolable: spool,
    now: () => new Date().toISOString(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}

async function runStopSubcommand(): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const { readDiscoveryFile } = await import("./discovery/discovery-file.js");
  const { isPidAlive } = await import("./discovery/singleton.js");
  const cfg = loadConfig();
  const rec = readDiscoveryFile(cfg.dataDir);
  if (rec && isPidAlive(rec.pid)) {
    try { process.kill(rec.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  process.exit(0);
}

if (isMainEntrypoint()) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "hook") {
    const relUrl = rest[0] ?? "";
    runHookSubcommand(relUrl, rest.includes("--spool")).catch((err) => {
      console.error("[orca-daemon] hook error:", err);
      process.exit(0); // never block the agent
    });
  } else if (sub === "--stop") {
    runStopSubcommand().catch(() => process.exit(0));
  } else {
    startDaemon().catch((err) => {
      console.error("[orca-daemon] fatal:", err);
      process.exit(1);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test index.hook-subcommand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/index.ts apps/daemon/src/index.hook-subcommand.test.ts
git commit -m "feat(daemon): hook + --stop argv subcommands on the daemon entry"
```

---

### Task 9: Startup singleton guard, discovery write, spool drain; shutdown cleanup

**Files:**
- Modify: `apps/daemon/src/index.ts` (`startDaemon`)
- Modify: `apps/daemon/src/shutdown.ts`
- Test: `apps/daemon/test/daemon-singleton-discovery.integration.test.ts` (new)

**Interfaces:**
- Consumes: `acquireLock`/`releaseLock` (Task 2), `writeDiscoveryFile`/`removeDiscoveryFile` (Task 1), `listSpool`/`removeSpool`/`shouldAgeOut` (Task 3), the existing agent-hooks + shadow-hooks route handlers (reused for drain).
- Produces: after `server.listen`, `startDaemon` writes the discovery file and drains the spool; on shutdown the discovery file and lock are removed. A second `startDaemon` against a live daemon exits without binding.

**Drain mechanism:** the spool stores a `relUrl` + `body`. To replay, POST to the *local* server we just started (`http://127.0.0.1:<config.port><relUrl>`) with `Authorization: Bearer <config.getAuthToken()>` — reusing the real route handlers, so no logic is duplicated. Age-out (`shouldAgeOut`, maxAttempts 5, maxAge 24h) drops poison entries; otherwise on failure increment `attempts` and leave for next boot.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/daemon/test/daemon-singleton-discovery.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiscoveryFile } from "../src/discovery/discovery-file.js";
import { startDaemon } from "../src/index.js";

describe("daemon startup writes discovery file", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-boot-")); process.env.ORCA_DATA_DIR = dir; process.env.ORCA_PORT = "0"; });
  afterEach(() => { delete process.env.ORCA_DATA_DIR; delete process.env.ORCA_PORT; rmSync(dir, { recursive: true, force: true }); });

  it("writes daemon.json with a live url+token after listen", async () => {
    const handle = await startDaemon();
    try {
      const rec = readDiscoveryFile(dir);
      expect(rec).not.toBeNull();
      expect(rec!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(rec!.token.length).toBeGreaterThan(0);
      expect(rec!.pid).toBe(process.pid);
    } finally {
      await handle.close();
    }
  });

  it("removes daemon.json on close", async () => {
    const handle = await startDaemon();
    await handle.close();
    expect(readDiscoveryFile(dir)).toBeNull();
  });
});
```

**Note:** `startDaemon` must accept `ORCA_PORT=0` (OS-assigns a port) and record the *actual* bound port. Read it from `server.server.address()` after `listen`, not `config.port`, when `config.port === 0`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test daemon-singleton-discovery`
Expected: FAIL — no discovery file written.

- [ ] **Step 3: Implement**

In `startDaemon`, before the registry/migration work, acquire the lock; after `server.listen`, compute the bound url, write the discovery file, then drain the spool. Add a `drainSpool` helper and remove discovery/lock in the `close` handler and in `registerShutdown`.

```typescript
// near top of startDaemon, after loadConfig():
  const { acquireLock, releaseLock } = await import("./discovery/singleton.js");
  const { writeDiscoveryFile, removeDiscoveryFile } = await import("./discovery/discovery-file.js");
  if (!acquireLock(config.dataDir)) {
    console.error("[orca-daemon] another healthy daemon holds the lock — exiting");
    process.exit(0);
  }

// replace the server.listen block:
  try {
    await server.listen({ host: "127.0.0.1", port: config.port });
  } catch (err) {
    server.log.error(err);
    releaseLock(config.dataDir);
    process.exit(1);
  }

  const addr = server.server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : config.port;
  const token = config.getAuthToken();
  writeDiscoveryFile(config.dataDir, {
    version: 1,
    url: `http://127.0.0.1:${boundPort}`,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    protocol: "http",
  });

  await drainSpool(config.dataDir, `http://127.0.0.1:${boundPort}`, token);

  registerShutdown(server, extractionRunner);

  return {
    close: async () => {
      extractionRunner.stop();
      await server.close();
      removeDiscoveryFile(config.dataDir);
      releaseLock(config.dataDir);
    },
  };
```

Add the drain helper (module scope in `index.ts`):

```typescript
async function drainSpool(dataDir: string, baseUrl: string, token: string): Promise<void> {
  const { listSpool, removeSpool, shouldAgeOut } = await import("./discovery/spool.js");
  const { writeFileSync } = await import("node:fs");
  const now = () => new Date().toISOString();
  for (const { file, entry } of listSpool(dataDir)) {
    if (shouldAgeOut(entry, now, 5, 24 * 60 * 60 * 1000)) { removeSpool(file); continue; }
    try {
      const res = await fetch(`${baseUrl}${entry.relUrl}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: entry.body,
      });
      if (res.ok) { removeSpool(file); continue; }
    } catch { /* leave for retry */ }
    writeFileSync(file, JSON.stringify({ ...entry, attempts: entry.attempts + 1 }), "utf8");
  }
}
```

Also update `registerShutdown` in `shutdown.ts` to call `removeDiscoveryFile(dataDir)` + `releaseLock(dataDir)` on SIGTERM/SIGINT (pass `config.dataDir` in). Search the current `registerShutdown` signature and thread `dataDir` through.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test daemon-singleton-discovery`
Expected: PASS (2 tests). Then run the full daemon suite: `pnpm --filter @orca/daemon test` — fix fallout from changed signatures.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/index.ts apps/daemon/src/shutdown.ts apps/daemon/test/daemon-singleton-discovery.integration.test.ts
git commit -m "feat(daemon): singleton guard, discovery write, and spool drain on startup"
```

---

### Task 10: Regression guard — completion lands after a restart via spool

**Files:**
- Create: `apps/daemon/test/daemon-restart-spool.integration.test.ts`

**Interfaces:**
- Consumes: `startDaemon` (Task 9), the daemon `hook` subcommand (Task 8), `resolveAndDeliver` (Task 5).

This is the stuck-goal repro turned into a guard: a `stop` hook fired while the daemon is down must be spooled and then delivered on the next startup.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/daemon/test/daemon-restart-spool.integration.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndDeliver } from "../src/hooks-resolver/resolver.js";
import { listSpool } from "../src/discovery/spool.js";
import { startDaemon } from "../src/index.js";

describe("completion survives a daemon-down window", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-restart-")); process.env.ORCA_DATA_DIR = dir; process.env.ORCA_PORT = "0"; });
  afterEach(() => { delete process.env.ORCA_DATA_DIR; delete process.env.ORCA_PORT; rmSync(dir, { recursive: true, force: true }); });

  it("spools a stop hook with no daemon, then drains it on startup", async () => {
    // 1) daemon is DOWN: resolver must spool, not lose the signal
    const r = await resolveAndDeliver({
      dataDir: dir,
      relUrl: "/v1/agent-hooks/response-done",
      body: JSON.stringify({ sessionId: "nonexistent", adapterId: "claude-code", responseText: "done" }),
      spoolable: true,
      now: () => new Date().toISOString(),
    });
    expect(r.exitCode).toBe(0);
    expect(listSpool(dir)).toHaveLength(1);

    // 2) daemon starts: startup drains the spool through the real route handler
    const handle = await startDaemon();
    try {
      // the unknown session is a no-op in onResponseDone, but the spool entry is consumed
      expect(listSpool(dir)).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test daemon-restart-spool`
Expected: FAIL if drain is not wired (spool still length 1). With Task 9 complete it should drive the implementation to green.

- [ ] **Step 3: Make it pass**

No new code if Tasks 5 + 9 are correct. If the spool entry is not consumed, verify `drainSpool` posts to the bound port with the auth token and that `/v1/agent-hooks/response-done` returns 2xx for an unknown session (it does — `onResponseDone` early-returns and the route replies `{ ok: true }`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test daemon-restart-spool`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/test/daemon-restart-spool.integration.test.ts
git commit -m "test(daemon): regression guard for spooled completion across restart"
```

---

### Task 11: Desktop adopt-or-spawn (Rust)

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: the discovery file written by the daemon (Task 9), `GET /v1/health` with `service` (Task 4).
- Produces: `setup()` adopts a healthy daemon or spawns a detached one; `get_daemon_endpoint` returns the adopted endpoint; the `RunEvent::Exit` daemon kill is removed.

**Behavior:**
1. Compute `data_dir` (mirror `config.ts`: `ORCA_DATA_DIR` env, else `~/.orca` or `%APPDATA%/Orca`).
2. Read `data_dir/daemon.json`; if present and `GET <url>/v1/health` returns 200 with `service == "orca-daemon"`, adopt `{url, token}`.
3. Else spawn the daemon **detached** (no `process_group(0)` tie to the app; in dev still `pnpm --filter @orca/daemon dev`, in prod the sidecar) and poll `daemon.json` + health for up to ~10s, then adopt.
4. Remove the `shutdown_daemon` call in the `RunEvent::Exit` handler.

- [ ] **Step 1: Write the failing test (Rust unit for data-dir + parsing)**

Add a `#[cfg(test)]` module in `lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_discovery_record() {
        let json = r#"{"version":1,"url":"http://127.0.0.1:8787","token":"t","pid":1,"startedAt":"x","protocol":"http"}"#;
        let rec: DiscoveryRecord = serde_json::from_str(json).unwrap();
        assert_eq!(rec.url, "http://127.0.0.1:8787");
        assert_eq!(rec.token, "t");
    }
}
```

(Requires a `#[derive(Deserialize)] struct DiscoveryRecord { url: String, token: String, pid: u32, .. }` and `serde_json` in `Cargo.toml` — add it if missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml parses_discovery_record`
Expected: FAIL — `DiscoveryRecord` undefined.

- [ ] **Step 3: Implement**

Add the struct, a `daemon_data_dir() -> PathBuf`, a `read_discovery(data_dir) -> Option<DiscoveryRecord>`, a `health_ok(url) -> bool` (blocking `ureq`/`reqwest` GET `/v1/health`, check `service`), and rewrite `setup()`:

```rust
#[derive(serde::Deserialize)]
struct DiscoveryRecord { url: String, token: String, #[allow(dead_code)] pid: u32 }

fn daemon_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("ORCA_DATA_DIR") { return PathBuf::from(d); }
    #[cfg(target_os = "windows")]
    { let base = std::env::var("APPDATA").unwrap_or_default(); return PathBuf::from(base).join("Orca"); }
    #[cfg(not(target_os = "windows"))]
    { return dirs::home_dir().expect("home").join(".orca"); }
}

// in setup(): try adopt, else spawn detached + poll. Detached = do NOT call
// process_group(0); set its own session so app exit does not kill it.
```

For the detached spawn on Unix, replace `cmd.process_group(0)` with a *new session* via `pre_exec(setsid)`, and on app exit do not kill it. Keep `attach_log_pipes` but also tee to `data_dir/daemon.log`. Remove the `shutdown_daemon(&mut child)` call in `RunEvent::Exit`.

**Note (dev hot-reload):** `pnpm dev`/`tsx watch` restarts re-acquire the lock and rewrite `daemon.json`; the brief gap is covered by the spool. No desktop change needed for that.

- [ ] **Step 4: Run test + manual smoke**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS. Then manual: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(desktop): adopt running daemon via discovery file; spawn detached; no kill-on-exit"
```

---

### Task 12: Full verification + manual end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Daemon suite + typecheck**

Run: `pnpm --filter @orca/daemon test && pnpm --filter @orca/daemon typecheck`
Expected: all green. Fix any remaining call sites that referenced the removed `port`/`authToken` hook params or the deleted `*HookUrl` helpers.

- [ ] **Step 2: Build the resolver path in dev**

Run the daemon directly and confirm the `hook` subcommand resolves against a live daemon:
```bash
ORCA_DATA_DIR=/tmp/orca-e2e ORCA_PORT=0 node --import tsx apps/daemon/src/index.ts &
sleep 2
echo '{"sessionId":"x","adapterId":"claude-code","responseText":"hi"}' \
  | ORCA_DATA_DIR=/tmp/orca-e2e node --import tsx apps/daemon/src/index.ts hook /v1/agent-hooks/response-done --spool
# expect: exit 0, no spool file left (delivered)
ls /tmp/orca-e2e/hook-spool 2>/dev/null || echo "spool empty (delivered)"
```

- [ ] **Step 3: Kill-daemon-then-spool check**

```bash
kill %1   # stop the daemon
echo '{"sessionId":"x","adapterId":"claude-code","responseText":"hi"}' \
  | ORCA_DATA_DIR=/tmp/orca-e2e node --import tsx apps/daemon/src/index.ts hook /v1/agent-hooks/response-done --spool
ls /tmp/orca-e2e/hook-spool   # expect: one spool file
ORCA_DATA_DIR=/tmp/orca-e2e ORCA_PORT=0 node --import tsx apps/daemon/src/index.ts &
sleep 2
ls /tmp/orca-e2e/hook-spool 2>/dev/null || echo "spool drained on startup"
kill %1
```

- [ ] **Step 4: Desktop smoke**

Launch `pnpm --filter @orca/desktop tauri:dev`, confirm the UI connects (adopts the running daemon), create a goal that spawns a worker, and inspect the worker's `~/.orca/workers/<sid>/settings.json` — confirm the hooks are `type:"command"` with no `http://` and no `Bearer`.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "chore(daemon): verification fixups for resolver addressing"
```

---

## Self-Review

**Spec coverage:**
- Discovery file → Task 1. Singleton guard → Task 2. Resolver → Tasks 5/8. Hook-settings builders → Task 6. Desktop adopt-or-spawn → Task 11. Spool drain → Task 9. Stop path → Task 8 (`--stop`). `/healthz` identity → Task 4. Token rotation works because nothing bakes the token → Tasks 6/7. Edge cases: spawn race (Task 2 lock), stale-pid (Task 2 steal + Task 11 health identity), port conflict (Task 9 OS-assign via `ORCA_PORT=0`/bound-port read), crash recovery (Task 11 respawn + Task 9 drain), spool age-out (Task 3/9), dev hot-reload (Task 9 lock re-acquire), existing workers age out (documented, no task), Windows (perms best-effort, detached via setsid/no process group). Regression guard → Task 10.
- **Gap noted:** "client-triggered re-adopt/respawn when health is lost mid-use" (spec §Component 5) is described in Task 11 step 3 but not given its own test; acceptable — it is exercised by the manual smoke (Task 12 step 4) and is a thin wrapper over `setup()`'s adopt-or-spawn.
- **Out of scope (spec confirms):** remote daemon impl, retrofitting in-flight workers, unsticking the current goal, auto-stop.

**Placeholder scan:** no TBD/TODO; every code step has concrete code. Search-and-confirm steps (call-site updates, `HealthResponse` location, `registerShutdown` signature) are explicit greps, not vague "handle the rest."

**Type consistency:** `DiscoveryRecord` shape identical across Tasks 1/5/9/11. `resolverCommand: string[]` consistent across Tasks 6/7. `resolveAndDeliver` signature identical in Tasks 5/8/10. `relUrl` is always a leading-slash path+query. Spool `attempts` starts at 0 (Task 3) and increments in `drainSpool` (Task 9).
