# Agent Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake 800 ms "Preparing your workspace" screen with a real readiness pipeline that verifies install + auth for every selected agent during onboarding, persists results, and surfaces inline copyable repair commands.

**Architecture:** Each `AgentAdapter` gains `checkInstalled()`, `checkAuth()` (typed `authStatus`), and `repairFor()`. A new `ReadinessService` runs them in parallel via `Promise.allSettled`, persists every terminal report to a small set of new columns on the `agents` table, and exposes two HTTP endpoints. Onboarding step 2 replaces the fake delay with a `ReadinessPanel` that renders per-agent rows and Retry buttons. The main app shell mounts a `NoReadyAgentsBanner` when zero connected agents are `ready`.

**Tech Stack:** TypeScript, Vitest, Fastify v5, Zod, better-sqlite3, Tauri v2 + React 18 (desktop), `child_process.execFile` for CLI probes. Spec at `docs/superpowers/specs/2026-05-22-agent-readiness-design.md`.

## Model assignments

| Task | Assigned model | Effort | Why |
|---|---|---:|---|
| 1 | Codex 5.3 | Low | Contract/schema work is mechanical and bounded. |
| 2 | Codex 5.3 | Low | SQLite migration + focused migration test. |
| 3 | GPT 5.4 | Medium | DB row mapping with JSON parsing and persistence edge cases. |
| 4 | GPT 5.4 | Medium | Sanitization needs careful regex and byte truncation. |
| 5 | GPT 5.5 | High | Child-process timeout, kill, and failure classification are brittle. |
| 6 | Codex 5.3 | Low | Static mapping module and tests. |
| 7 | GPT 5.5 | Medium | Phase hygiene and type-boundary sequencing. |
| 8 | GPT 5.5 | High | Claude status parsing must avoid PII and command drift. |
| 9 | GPT 5.4 | Medium | Codex classifier is straightforward but exit-code-sensitive. |
| 10 | GPT 5.5 | High | OpenCode output parsing is CLI-format-sensitive. |
| 11 | Opus 4.7 | High | Gemini auth modes and adapter registration have the most ambiguity. |
| 12 | GPT 5.5 | High | Service concurrency, dedup, and persistence failure modes. |
| 13 | GPT 5.4 | Medium | HTTP wiring with fake adapter injection. |
| 14 | Codex 5.3 | Low | Desktop API wrappers and response parsing. |
| 15 | Sonnet 4.6 | Medium | Small UI component and accessibility detail. |
| 16 | Sonnet 4.6 | Medium | UI state rendering across readiness statuses. |
| 17 | Sonnet 4.6 | High | React orchestration, cache behavior, and callback stability. |
| 18 | Sonnet 4.6 | High | Onboarding flow wiring, persistence ordering, and Tauri opener. |
| 19 | Sonnet 4.6 | Medium | App-shell banner and agent refresh behavior. |
| 20 | Codex 5.3 | Low | Gated smoke tests with no product behavior changes. |

---

## Task 1: Contracts — readiness types, schemas, AdapterId update

**Assigned model:** Codex 5.3  
**Effort:** Low

**Files:**
- Modify: `packages/contracts/src/index.ts` (extend `AdapterId` enum, add readiness section, extend `Agent` schema)
- Test: `packages/contracts/src/index.test.ts` (append cases)

- [ ] **Step 1: Write failing tests**

Append to `packages/contracts/src/index.test.ts`:

```ts
import {
  AdapterId,
  AgentReadinessStatus,
  AuthStatus,
  CheckStep,
  RepairAction,
  AgentReadinessReport,
  CheckReadinessAllResponse,
  CheckReadinessOneResponse,
  Agent,
} from "./index.js";

describe("AdapterId now includes gemini-cli", () => {
  it("accepts gemini-cli", () => {
    expect(AdapterId.parse("gemini-cli")).toBe("gemini-cli");
  });
});

describe("agent readiness contracts", () => {
  it("accepts every persisted status", () => {
    for (const s of ["unchecked", "ready", "missing", "needs_auth", "misconfigured", "failed"] as const) {
      expect(AgentReadinessStatus.parse(s)).toBe(s);
    }
  });

  it("rejects the transient 'checking' status (UI-only)", () => {
    expect(() => AgentReadinessStatus.parse("checking")).toThrow();
  });

  it("AuthStatus is a closed union of three values", () => {
    for (const s of ["ready", "needs_auth", "misconfigured"] as const) {
      expect(AuthStatus.parse(s)).toBe(s);
    }
    expect(() => AuthStatus.parse("ok")).toThrow();
  });

  it("CheckStep validates a minimal install step", () => {
    expect(
      CheckStep.parse({ name: "installed", ok: true, command: "claude --version" }),
    ).toMatchObject({ name: "installed", ok: true });
  });

  it("CheckStep requires authStatus only on authenticated steps", () => {
    // install step with no authStatus passes
    expect(CheckStep.parse({ name: "installed", ok: false, command: "claude --version" })).toBeDefined();
    // auth step with authStatus passes
    expect(
      CheckStep.parse({
        name: "authenticated",
        ok: true,
        authStatus: "ready",
        command: "claude auth status --json",
      }),
    ).toBeDefined();
  });

  it("RepairAction.run_command requires `command`", () => {
    expect(() =>
      RepairAction.parse({ kind: "run_command", label: "Sign in" }),
    ).toThrow();
    expect(
      RepairAction.parse({ kind: "run_command", command: "claude auth login", label: "Sign in" }),
    ).toBeDefined();
  });

  it("RepairAction.install_url requires `url`", () => {
    expect(() => RepairAction.parse({ kind: "install_url", label: "Install" })).toThrow();
    expect(
      RepairAction.parse({ kind: "install_url", url: "https://example.invalid", label: "Install" }),
    ).toBeDefined();
  });

  it("AgentReadinessReport round-trips", () => {
    const r = {
      agentId: "claude-code",
      status: "ready" as const,
      steps: [
        { name: "installed" as const, ok: true, command: "claude --version" },
        { name: "authenticated" as const, ok: true, authStatus: "ready" as const, command: "claude auth status --json" },
      ],
      checkedAt: "2026-05-22T00:00:00.000Z",
      version: "1.2.3",
    };
    expect(AgentReadinessReport.parse(r)).toEqual(r);
  });

  it("CheckReadinessAllResponse wraps an array of reports", () => {
    expect(CheckReadinessAllResponse.parse({ reports: [] })).toEqual({ reports: [] });
  });

  it("CheckReadinessOneResponse wraps a single report", () => {
    const report = {
      agentId: "codex",
      status: "needs_auth" as const,
      steps: [
        { name: "installed" as const, ok: true, command: "codex --version" },
        { name: "authenticated" as const, ok: false, authStatus: "needs_auth" as const, command: "codex login status" },
      ],
      repair: { kind: "run_command" as const, command: "codex login", label: "Sign in to Codex" },
      checkedAt: "2026-05-22T00:00:00.000Z",
    };
    expect(CheckReadinessOneResponse.parse({ report })).toEqual({ report });
  });

  it("Agent schema accepts an optional readiness field", () => {
    const base = {
      id: "claude-code",
      name: "Claude Code",
      shortLabel: "x",
      description: "x",
      swatch: "#000",
      recommended: true,
      connected: true,
      sortOrder: 10,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    };
    expect(Agent.parse(base)).toBeDefined();
    expect(Agent.parse({ ...base, readiness: null })).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/contracts && pnpm test -- --run`
Expected: tests fail because the new exports don't exist.

- [ ] **Step 3: Add the contracts**

First, extend `AdapterId` (currently around line 357 of `packages/contracts/src/index.ts`):

```ts
export const AdapterId = z.enum(["shell-manual", "claude-code", "opencode", "codex", "gemini-cli"]);
export type AdapterId = z.infer<typeof AdapterId>;
```

Then locate the existing `export const Agent = z.object({ ... })` block. **Replace** that single block with the readiness schemas + extended Agent below (paste this whole block in place of the original `Agent` + `ListAgentsResponse` + `UpdateAgentResponse` definitions):

```ts
// ---------- agent readiness ----------

export const AgentReadinessStatus = z.enum([
  "unchecked",
  "ready",
  "missing",
  "needs_auth",
  "misconfigured",
  "failed",
]);
export type AgentReadinessStatus = z.infer<typeof AgentReadinessStatus>;

export const AuthStatus = z.enum(["ready", "needs_auth", "misconfigured"]);
export type AuthStatus = z.infer<typeof AuthStatus>;

export const CheckStep = z.object({
  name: z.enum(["installed", "authenticated"]),
  ok: z.boolean(),
  authStatus: AuthStatus.optional(),
  command: z.string(),
  exitCode: z.number().int().optional(),
  detail: z.string().optional(),
  errorOutput: z.string().optional(),
});
export type CheckStep = z.infer<typeof CheckStep>;

export const RepairAction = z
  .object({
    kind: z.enum(["run_command", "install_url"]),
    command: z.string().optional(),
    url: z.string().url().optional(),
    label: z.string(),
    requiresAppRestart: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "run_command" && !v.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "run_command requires command" });
    }
    if (v.kind === "install_url" && !v.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "install_url requires url" });
    }
  });
export type RepairAction = z.infer<typeof RepairAction>;

export const AgentReadinessReport = z.object({
  agentId: z.string(),
  status: AgentReadinessStatus,
  steps: z.array(CheckStep),
  repair: RepairAction.optional(),
  checkedAt: z.string().datetime(),
  version: z.string().optional(),
});
export type AgentReadinessReport = z.infer<typeof AgentReadinessReport>;

// ---------- agents ----------

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  shortLabel: z.string(),
  description: z.string(),
  swatch: z.string(),
  recommended: z.boolean(),
  connected: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  readiness: AgentReadinessReport.nullish(),
});
export type Agent = z.infer<typeof Agent>;

export const ListAgentsResponse = z.object({ agents: z.array(Agent) });
export type ListAgentsResponse = z.infer<typeof ListAgentsResponse>;

export const UpdateAgentRequest = z.object({ connected: z.boolean() });
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>;

export const UpdateAgentResponse = z.object({ agent: Agent });
export type UpdateAgentResponse = z.infer<typeof UpdateAgentResponse>;

export const CheckReadinessAllResponse = z.object({
  reports: z.array(AgentReadinessReport),
});
export type CheckReadinessAllResponse = z.infer<typeof CheckReadinessAllResponse>;

export const CheckReadinessOneResponse = z.object({ report: AgentReadinessReport });
export type CheckReadinessOneResponse = z.infer<typeof CheckReadinessOneResponse>;
```

- [ ] **Step 4: Run tests and confirm they pass**

Run: `cd packages/contracts && pnpm test -- --run`
Expected: all new tests pass; pre-existing tests still pass.

- [ ] **Step 5: Build contracts so consumers can import the new types**

Run: `cd packages/contracts && pnpm build`
Expected: emits `dist/index.js` / `dist/index.d.ts` with the new symbols.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts packages/contracts/dist
git commit -m "feat(contracts): add agent readiness schemas"
```

---

## Task 2: Migration `0009_agent_readiness.sql`

**Assigned model:** Codex 5.3  
**Effort:** Low

**Files:**
- Create: `apps/daemon/migrations/0009_agent_readiness.sql`
- Modify: `apps/daemon/src/migrations.ts` (append filename to `migrationFiles` array)
- Test: `apps/daemon/src/migrations.test.ts` (append a case)

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/migrations.test.ts`:

```ts
describe("migration 0009 agent readiness", () => {
  it("adds readiness columns to agents and enforces status CHECK", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-mig-9-"));
    tempDirs.push(dir);
    const db = openDatabase(createConfig(dir));
    runMigrations(db, defaultMigrationsDir());

    const cols = db.prepare(`PRAGMA table_info(agents)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
      "readiness_status",
      "readiness_checked_at",
      "readiness_detail",
      "readiness_repair",
      "readiness_version",
    ]) {
      expect(names).toContain(expected);
    }

    // CHECK constraint rejects junk
    expect(() =>
      db
        .prepare(`UPDATE agents SET readiness_status = 'bogus' WHERE id = ?`)
        .run("claude-code"),
    ).toThrow();

    // NULL allowed
    db.prepare(`UPDATE agents SET readiness_status = NULL WHERE id = ?`).run("claude-code");

    // every legal value accepted
    for (const v of ["unchecked", "ready", "missing", "needs_auth", "misconfigured", "failed"]) {
      db.prepare(`UPDATE agents SET readiness_status = ? WHERE id = ?`).run(v, "claude-code");
    }
    closeDatabase(db);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- migrations.test.ts`
Expected: fails (migration file does not exist; columns missing).

- [ ] **Step 3: Create the migration file**

Create `apps/daemon/migrations/0009_agent_readiness.sql`:

```sql
ALTER TABLE agents ADD COLUMN readiness_status TEXT
  CHECK (readiness_status IS NULL OR readiness_status IN (
    'unchecked','ready','missing','needs_auth','misconfigured','failed'
  ));
ALTER TABLE agents ADD COLUMN readiness_checked_at TEXT;
ALTER TABLE agents ADD COLUMN readiness_detail     TEXT;
ALTER TABLE agents ADD COLUMN readiness_repair     TEXT;
ALTER TABLE agents ADD COLUMN readiness_version    TEXT;
```

- [ ] **Step 4: Register the migration**

Edit `apps/daemon/src/migrations.ts`. In the `migrationFiles` const array (around the top of the file) append the new filename so the final array reads:

```ts
export const migrationFiles = [
  "0001_init.sql",
  "0002_workspaces_refinements.sql",
  "0004_sessions.sql",
  "0005_memory.sql",
  "0006_context.sql",
  "0007_agents.sql",
  SUGGESTED_ORCHESTRATION_MIGRATION,
  "0009_agent_readiness.sql",
] as const;
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd apps/daemon && pnpm test -- migrations.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0009_agent_readiness.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts
git commit -m "feat(daemon): add 0009_agent_readiness migration"
```

---

## Task 3: Extend `agents.ts` row mapping + add `persistReadiness`

**Assigned model:** GPT 5.4  
**Effort:** Medium

**Files:**
- Modify: `apps/daemon/src/agents.ts`
- Test: `apps/daemon/src/agents.test.ts` (append cases)

- [ ] **Step 1: Write the failing test**

Append to `apps/daemon/src/agents.test.ts`:

```ts
import { persistReadiness } from "./agents.js";
import type { AgentReadinessReport } from "@orca/contracts";

describe("agents readiness columns", () => {
  it("listAgents surfaces readiness as null when never checked", () => {
    const { db } = setup(); // setup helper used elsewhere in this file
    const agents = listAgents(db);
    for (const a of agents) {
      expect(a.readiness).toBeNull();
    }
  });

  it("persistReadiness writes and listAgents reads back the full report", () => {
    const { db } = setup();
    const report: AgentReadinessReport = {
      agentId: "claude-code",
      status: "ready",
      steps: [
        { name: "installed", ok: true, command: "claude --version" },
        { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
      ],
      checkedAt: "2026-05-22T00:00:00.000Z",
      version: "1.2.3",
    };
    persistReadiness(db, report);
    const row = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(row.readiness).toEqual(report);
  });

  it("persistReadiness overwrites a prior report", () => {
    const { db } = setup();
    persistReadiness(db, {
      agentId: "claude-code",
      status: "ready",
      steps: [{ name: "installed", ok: true, command: "claude --version" }],
      checkedAt: "2026-05-22T00:00:00.000Z",
    });
    persistReadiness(db, {
      agentId: "claude-code",
      status: "needs_auth",
      steps: [
        { name: "installed", ok: true, command: "claude --version" },
        { name: "authenticated", ok: false, authStatus: "needs_auth", command: "claude auth status --json" },
      ],
      repair: { kind: "run_command", command: "claude auth login", label: "Sign in to Claude Code" },
      checkedAt: "2026-05-22T00:01:00.000Z",
    });
    const row = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(row.readiness?.status).toBe("needs_auth");
    expect(row.readiness?.repair?.command).toBe("claude auth login");
  });
});
```

The file already declares a per-test setup; if not, add at the top of the new describe block:

```ts
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-agents-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  seedAgents(db);
  return { db };
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- agents.test.ts`
Expected: fails — `persistReadiness` not exported; `readiness` missing on returned rows.

- [ ] **Step 3: Update row mapping + add helper**

Edit `apps/daemon/src/agents.ts`. Update `interface AgentRow` to include the new columns:

```ts
interface AgentRow {
  id: string;
  name: string;
  short_label: string;
  description: string;
  swatch: string;
  recommended: number;
  connected: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  readiness_status: string | null;
  readiness_checked_at: string | null;
  readiness_detail: string | null;
  readiness_repair: string | null;
  readiness_version: string | null;
}
```

Replace `rowToAgent` with:

```ts
function rowToAgent(row: AgentRow): Agent {
  let readiness: Agent["readiness"] = null;
  if (row.readiness_status && row.readiness_status !== "unchecked" && row.readiness_checked_at) {
    try {
      readiness = AgentReadinessReport.parse({
        agentId: row.id,
        status: row.readiness_status,
        steps: row.readiness_detail ? JSON.parse(row.readiness_detail) : [],
        repair: row.readiness_repair ? JSON.parse(row.readiness_repair) : undefined,
        checkedAt: row.readiness_checked_at,
        version: row.readiness_version ?? undefined,
      });
    } catch {
      // Partial/corrupt persisted readiness — treat as unchecked rather than crash listAgents.
      readiness = null;
    }
  }

  return Agent.parse({
    id: row.id,
    name: row.name,
    shortLabel: row.short_label,
    description: row.description,
    swatch: row.swatch,
    recommended: row.recommended === 1,
    connected: row.connected === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readiness,
  });
}
```

Update both `SELECT` statements (in `listAgents` and `setAgentConnected`) to include all five new columns. Replace the existing column list with:

```ts
`SELECT id, name, short_label, description, swatch, recommended, connected, sort_order,
        created_at, updated_at,
        readiness_status, readiness_checked_at, readiness_detail, readiness_repair, readiness_version
   FROM agents`
```

Add the imports at the top:

```ts
import { Agent, AgentReadinessReport, type AgentReadinessReport as Report } from "@orca/contracts";
```

Add the helper at the bottom of the file:

```ts
export function persistReadiness(
  db: Database.Database,
  report: Report,
  now: string = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE agents
        SET readiness_status     = @status,
            readiness_checked_at = @checkedAt,
            readiness_detail     = @detail,
            readiness_repair     = @repair,
            readiness_version    = @version,
            updated_at           = @now
      WHERE id = @id`,
  ).run({
    status: report.status,
    checkedAt: report.checkedAt,
    detail: JSON.stringify(report.steps),
    repair: report.repair ? JSON.stringify(report.repair) : null,
    version: report.version ?? null,
    now,
    id: report.agentId,
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/daemon && pnpm test -- agents.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/agents.ts apps/daemon/src/agents.test.ts
git commit -m "feat(daemon): persist readiness reports on agents"
```

---

## Task 4: Output sanitizer

**Assigned model:** GPT 5.4  
**Effort:** Medium

**Files:**
- Create: `apps/daemon/src/readiness/sanitize.ts`
- Test: `apps/daemon/src/readiness/sanitize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/readiness/sanitize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sanitizeOutput } from "./sanitize.js";

describe("sanitizeOutput", () => {
  it("returns empty string for null/undefined input", () => {
    expect(sanitizeOutput(undefined)).toBe("");
    expect(sanitizeOutput(null)).toBe("");
  });

  it("strips ANSI escape sequences", () => {
    expect(sanitizeOutput("[31mERROR[0m message")).toBe("ERROR message");
  });

  it("truncates output to 4 KB", () => {
    const big = "a".repeat(5000);
    const out = sanitizeOutput(big);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("redacts Anthropic sk- keys", () => {
    expect(sanitizeOutput("token=sk-ant-api03-AbCdEfGhIjKlMnOpQrSt")).toContain("<redacted>");
  });

  it("redacts generic sk- keys", () => {
    expect(sanitizeOutput("key=sk-1234567890ABCDEFGH")).toContain("<redacted>");
  });

  it("redacts GitHub PATs (ghp_/gho_/ghs_)", () => {
    expect(sanitizeOutput("ghp_AAAAAAAAAAAAAAAAAAAA1234")).toContain("<redacted>");
    expect(sanitizeOutput("gho_AAAAAAAAAAAAAAAAAAAA1234")).toContain("<redacted>");
    expect(sanitizeOutput("ghs_AAAAAAAAAAAAAAAAAAAA1234")).toContain("<redacted>");
  });

  it("redacts Google OAuth (ya29.) and API keys (AIza...)", () => {
    expect(sanitizeOutput("ya29.A0AfH6SMABCDEFG")).toContain("<redacted>");
    expect(sanitizeOutput("AIzaSyA1234567890ABCDEFGHIJ")).toContain("<redacted>");
  });

  it("redacts Bearer tokens", () => {
    expect(sanitizeOutput("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")).toContain("<redacted>");
  });

  it("redacts PEM private keys", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----";
    expect(sanitizeOutput(pem)).toContain("<redacted>");
    expect(sanitizeOutput(pem)).not.toContain("ABC");
  });

  it("redacts URL auth query params", () => {
    expect(sanitizeOutput("https://api.example/path?access_token=xyz&foo=bar")).toContain(
      "<redacted>",
    );
  });

  it("redacts email addresses", () => {
    expect(sanitizeOutput("Hello user@example.com today")).toContain("<redacted>");
    expect(sanitizeOutput("Hello user@example.com today")).not.toContain("user@example.com");
  });

  it("redacts high-entropy 32+ char tokens", () => {
    expect(sanitizeOutput("token=abcdefghijklmnopqrstuvwxyz12345678")).toContain("<redacted>");
  });

  it("does not redact normal short words", () => {
    const text = "Codex is not logged in. Please run codex login.";
    expect(sanitizeOutput(text)).toBe(text);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- sanitize.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Create the sanitizer module**

Create `apps/daemon/src/readiness/sanitize.ts`:

```ts
const ANSI = /\[[0-9;]*[A-Za-z]/g;

const REDACTIONS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{16,}/g,
  /sk-[A-Za-z0-9_\-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghs_[A-Za-z0-9]{20,}/g,
  /ya29\.[A-Za-z0-9_\-]+/g,
  /AIza[A-Za-z0-9_\-]{20,}/g,
  /Bearer\s+[A-Za-z0-9_\-\.]+/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /([\?&#])(?:access_token|id_token|api_key|token|key|password)=[^\s&#]+/g,
  /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
  /\b[A-Za-z0-9_\-]{32,}\b/g,
];

const MAX_BYTES = 4096;
const TRUNC_SUFFIX = "…[truncated]";

export function sanitizeOutput(input: string | null | undefined): string {
  if (!input) return "";
  let out = input.replace(ANSI, "");
  for (const rx of REDACTIONS) {
    out = out.replace(rx, (match, p1) => {
      // Preserve the leading delimiter for URL-param patterns so the URL stays readable.
      if (p1 && (p1 === "?" || p1 === "&" || p1 === "#")) return `${p1}<redacted>`;
      return "<redacted>";
    });
  }
  if (Buffer.byteLength(out, "utf8") > MAX_BYTES) {
    const limitBytes = MAX_BYTES - Buffer.byteLength(TRUNC_SUFFIX, "utf8");
    const buf = Buffer.from(out, "utf8").subarray(0, limitBytes);
    // Decode with 'replacement' substitution so a half multi-byte char at the boundary
    // becomes U+FFFD instead of producing invalid output.
    out = new TextDecoder("utf-8", { fatal: false }).decode(buf) + TRUNC_SUFFIX;
  }
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/daemon && pnpm test -- sanitize.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/readiness/sanitize.ts apps/daemon/src/readiness/sanitize.test.ts
git commit -m "feat(daemon): add readiness output sanitizer"
```

---

## Task 5: Exec helper `runCheckCommand`

**Assigned model:** GPT 5.5  
**Effort:** High

**Files:**
- Create: `apps/daemon/src/readiness/exec.ts`
- Test: `apps/daemon/src/readiness/exec.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/readiness/exec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCheckCommand } from "./exec.js";

describe("runCheckCommand", () => {
  it("returns exit 0 and stdout for a trivial command", async () => {
    const res = await runCheckCommand("node", ["-e", "process.stdout.write('hi')"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
    expect(res.timedOut).toBe(false);
  });

  it("captures stderr and a non-zero exit code without throwing", async () => {
    const res = await runCheckCommand("node", [
      "-e",
      "process.stderr.write('boom'); process.exit(7)",
    ]);
    expect(res.exitCode).toBe(7);
    expect(res.stderr.trim()).toBe("boom");
  });

  it("returns timedOut: true when the child exceeds the timeout", async () => {
    const res = await runCheckCommand("node", ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 });
    expect(res.timedOut).toBe(true);
  });

  it("returns ENOENT-style failure for a missing binary", async () => {
    const res = await runCheckCommand("definitely-not-a-real-binary-orca-xyz", ["--version"]);
    expect(res.exitCode).toBeUndefined();
    expect(res.failureKind).toBe("spawn");
    expect(res.spawnError?.code).toBe("ENOENT");
  });

  it("classifies maxBuffer overflows distinctly", async () => {
    const res = await runCheckCommand("node", [
      "-e",
      "process.stdout.write('x'.repeat(1024*1024))",
    ]);
    expect(res.failureKind).toBe("max_buffer");
  });

  it("honors an env allowlist (does not leak HOME by default)", async () => {
    const res = await runCheckCommand("node", ["-e", "process.stdout.write(String(!!process.env.HOME))"]);
    expect(res.stdout.trim()).toBe("false");
  });

  it("can pass through specific env vars when asked", async () => {
    const res = await runCheckCommand(
      "node",
      ["-e", "process.stdout.write(String(process.env.ORCA_TEST))"],
      { env: { ORCA_TEST: "1" } },
    );
    expect(res.stdout.trim()).toBe("1");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- exec.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Create the exec helper**

Create `apps/daemon/src/readiness/exec.ts`:

```ts
import { execFile } from "node:child_process";
import os from "node:os";

export interface RunCheckOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
}

export type FailureKind = "spawn" | "timeout" | "max_buffer" | "exit";

export interface RunCheckResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  failureKind?: FailureKind;
  spawnError?: { code?: string; message: string };
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 256 * 1024;
const SIGKILL_GRACE_MS = 1000;

export function runCheckCommand(
  command: string,
  args: string[],
  opts: RunCheckOptions = {},
): Promise<RunCheckResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "" };
    if (opts.env) Object.assign(env, opts.env);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let childExited = false;
    let softTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;

    // We manage timeout ourselves so we control SIGTERM → SIGKILL escalation.
    const child = execFile(
      command,
      args,
      {
        maxBuffer: MAX_BUFFER,
        cwd: opts.cwd ?? os.tmpdir(),
        env,
        windowsHide: true,
        shell: false,
      },
      (err, stdout, stderr) => {
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (softTimer) clearTimeout(softTimer);
        const durationMs = Date.now() - start;

        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            durationMs,
            timedOut: false,
            failureKind: "spawn",
            spawnError: { code: "ENOENT", message: err.message },
          });
          return;
        }

        const errCode = (err as { code?: number | string } | null)?.code;
        if (errCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            durationMs,
            timedOut: false,
            failureKind: "max_buffer",
            spawnError: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: (err as Error).message },
          });
          return;
        }

        const exitCode = typeof errCode === "number" ? errCode : err ? undefined : 0;
        const failureKind: FailureKind | undefined = timedOut
          ? "timeout"
          : exitCode !== 0
            ? "exit"
            : undefined;

        resolve({
          exitCode,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          durationMs,
          timedOut,
          failureKind,
        });
      },
    );

    // Close stdin so the child cannot block waiting for input.
    child.stdin?.end();
    child.once("exit", () => {
      childExited = true;
    });

    // Soft timeout: SIGTERM first, then SIGKILL after the grace window.
    softTimer = setTimeout(() => {
      timedOut = true;
      if (!childExited) child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        if (!childExited) child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/daemon && pnpm test -- exec.test.ts`
Expected: all six tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/readiness/exec.ts apps/daemon/src/readiness/exec.test.ts
git commit -m "feat(daemon): add runCheckCommand exec helper with fixed policy"
```

---

## Task 6: Repair links module

**Assigned model:** Codex 5.3  
**Effort:** Low

**Files:**
- Create: `apps/daemon/src/readiness/repair-links.ts`
- Test: `apps/daemon/src/readiness/repair-links.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/readiness/repair-links.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { installUrlFor, signInCommandFor } from "./repair-links.js";

describe("repair-links", () => {
  it("returns an https install URL for each known adapter", () => {
    for (const id of ["claude-code", "codex", "gemini-cli", "opencode"] as const) {
      const url = installUrlFor(id);
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it("returns the sign-in command for each known adapter", () => {
    expect(signInCommandFor("claude-code")).toBe("claude auth login");
    expect(signInCommandFor("codex")).toBe("codex login");
    expect(signInCommandFor("gemini-cli")).toBe("gemini");
    expect(signInCommandFor("opencode")).toBe("opencode auth login");
  });

  it("returns null for unknown ids (caller decides fallback)", () => {
    expect(installUrlFor("nope" as never)).toBeNull();
    expect(signInCommandFor("nope" as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- repair-links.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Create the module**

Create `apps/daemon/src/readiness/repair-links.ts`:

```ts
export type KnownAdapterId = "claude-code" | "codex" | "gemini-cli" | "opencode";

const INSTALL_URLS: Record<KnownAdapterId, string> = {
  "claude-code": "https://docs.anthropic.com/claude/docs/claude-code",
  codex: "https://github.com/openai/codex",
  "gemini-cli": "https://github.com/google-gemini/gemini-cli",
  opencode: "https://opencode.ai",
};

const SIGN_IN_COMMANDS: Record<KnownAdapterId, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  "gemini-cli": "gemini",
  opencode: "opencode auth login",
};

export function installUrlFor(id: KnownAdapterId): string | null {
  return INSTALL_URLS[id] ?? null;
}

export function signInCommandFor(id: KnownAdapterId): string | null {
  return SIGN_IN_COMMANDS[id] ?? null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/daemon && pnpm test -- repair-links.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/readiness/repair-links.ts apps/daemon/src/readiness/repair-links.test.ts
git commit -m "feat(daemon): centralise readiness repair links"
```

---

## Task 7: Adapter phase — overview & branch hygiene

**Assigned model:** GPT 5.5  
**Effort:** Medium

**Tasks 7 → 11 form one logical commit.** The typecheck breaks the moment we add the new abstract methods to the `AgentAdapter` interface, so we adopt an **adapter-first** strategy:

1. Tasks 8, 9, 10, 11a implement `checkInstalled`, `checkAuth`, `repairFor` on each adapter as **plain class methods** — without touching the interface yet. Each task's test imports the class directly, so the tests pass.
2. Task 11b (final step) extends the `AgentAdapter` interface in `types.ts`. By that point every implementing class already has the methods, so the typecheck stays green.
3. Tasks 8–11 produce **a single combined commit** at the end of Task 11b. Do not commit between Tasks 7 and the end of Task 11b.

If you have to stop execution mid-phase, leave the worktree dirty rather than committing a half-state.

- [ ] **Step 1: Confirm starting state is clean**

Run: `git status` — expect a clean tree. Run: `cd apps/daemon && pnpm typecheck && pnpm test` — expect green.

If either fails, fix or stash before starting Task 8.

- [ ] **Step 2: No code changes in this task**

Proceed to Task 8.

---

## Task 8: Claude Code adapter checks

**Assigned model:** GPT 5.5  
**Effort:** High

**Files:**
- Modify: `apps/daemon/src/adapters/claude-code.ts`
- Create: `apps/daemon/src/adapters/claude-code.readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/claude-code.readiness.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";
import type { RunCheckFn } from "./claude-code.js";

const ok = (path: string) => () => Promise.resolve({ resolvedPath: path });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["claude"] });

function adapter(run: RunCheckFn, resolved = ok("/usr/bin/claude")) {
  return new ClaudeCodeAdapter(resolved, run);
}

describe("ClaudeCodeAdapter.checkInstalled", () => {
  it("reports installed + version on exit 0", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "claude 1.2.3\n",
      stderr: "",
      durationMs: 10,
      timedOut: false,
    });
    const step = await adapter(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("1.2.3");
  });

  it("reports missing on ENOENT", async () => {
    const step = await new ClaudeCodeAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/not found/i);
  });
});

describe("ClaudeCodeAdapter.checkAuth", () => {
  it("classifies loggedIn=true JSON as ready", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, account: "shawn@example.com" }),
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.ok).toBe(true);
    // PII never persisted on success
    expect(step.errorOutput).toBeUndefined();
    expect(step.detail).toBe("authenticated");
  });

  it("classifies loggedIn=false JSON as needs_auth (exit 1)", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("classifies loggedIn=false JSON as needs_auth even if exit code is unexpected (exit 0)", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("classifies invalid JSON / unexpected exit as misconfigured", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: 2,
      stdout: "panic: keychain locked",
      stderr: "",
      durationMs: 5,
      timedOut: false,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
    expect(step.errorOutput).toBeDefined();
  });

  it("classifies timeout as misconfigured", async () => {
    const run: RunCheckFn = vi.fn().mockResolvedValue({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      durationMs: 5000,
      timedOut: true,
    });
    const step = await adapter(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
    expect(step.detail).toMatch(/timeout/i);
  });

  it("invokes claude auth status --json", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '{"loggedIn":true}',
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    await adapter(run).checkAuth();
    expect(run).toHaveBeenCalledWith("/usr/bin/claude", ["auth", "status", "--json"], expect.anything());
  });
});

describe("ClaudeCodeAdapter.repairFor", () => {
  const a = new ClaudeCodeAdapter(ok("/usr/bin/claude"), vi.fn());
  it("missing → install_url", () => {
    expect(a.repairFor("missing")).toMatchObject({ kind: "install_url" });
  });
  it("needs_auth → run_command with claude auth login", () => {
    expect(a.repairFor("needs_auth")).toMatchObject({ kind: "run_command", command: "claude auth login" });
  });
  it("ready returns undefined", () => {
    expect(a.repairFor("ready")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- claude-code.readiness.test.ts`
Expected: fails — `RunCheckFn` not exported, constructor signature wrong, methods missing.

- [ ] **Step 3: Implement the adapter checks**

Replace the contents of `apps/daemon/src/adapters/claude-code.ts` with:

```ts
import type {
  AgentAdapter,
  AdapterSpawnInput,
  AdapterSpawnResult,
  AdapterAvailability,
  AdapterContextDelivery,
} from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary, type ResolveFn } from "./resolve.js";
import { runCheckCommand, type RunCheckResult } from "../readiness/exec.js";
import { sanitizeOutput } from "../readiness/sanitize.js";
import { installUrlFor, signInCommandFor } from "../readiness/repair-links.js";
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly title = "Claude Code";
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(
          `claude not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code. Tried: ${result.tried.join(", ")}`,
        ),
        { code: "command_not_found" },
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `claude not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "installed",
        ok: false,
        command: "claude --version",
        detail: "claude not found on PATH",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"]);
    const version = parseVersion(r.stdout);
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "claude --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "claude --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "claude --version failed",
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "claude auth status --json",
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["auth", "status", "--json"]);
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "claude auth status --json",
        detail: "timeout",
      };
    }
    let parsed: { loggedIn?: boolean } | null = null;
    try {
      parsed = JSON.parse(r.stdout) as { loggedIn?: boolean };
    } catch {
      parsed = null;
    }
    // JSON drives the classification first; exit code is a tiebreaker only.
    if (parsed && typeof parsed.loggedIn === "boolean") {
      if (parsed.loggedIn === true) {
        return {
          name: "authenticated",
          ok: true,
          authStatus: "ready",
          command: "claude auth status --json",
          detail: "authenticated",
        };
      }
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: "claude auth status --json",
        exitCode: r.exitCode,
        detail: "not signed in",
      };
    }
    return {
      name: "authenticated",
      ok: false,
      authStatus: "misconfigured",
      command: "claude auth status --json",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "unexpected auth status output",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("claude-code");
      return url ? { kind: "install_url", url, label: "Install Claude Code" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("claude-code");
      return command ? { kind: "run_command", command, label: "Sign in to Claude Code" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "claude auth status --json", label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_CLAUDE_CODE_BIN"];
  return override ? [override] : ["claude"];
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/daemon && pnpm test -- claude-code.readiness.test.ts`
Expected: every test passes.

- [ ] **Step 5: Do not commit yet**

Other adapters are still failing typecheck. Continue to Task 9.

---

## Task 9: Codex adapter checks

**Assigned model:** GPT 5.4  
**Effort:** Medium

**Files:**
- Modify: `apps/daemon/src/adapters/codex.ts`
- Create: `apps/daemon/src/adapters/codex.readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/codex.readiness.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex.js";
import type { RunCheckFn } from "./codex.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["codex"] });

function a(run: RunCheckFn, resolved = ok("/usr/bin/codex")) {
  return new CodexAdapter(resolved, run);
}

describe("CodexAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "codex 0.9.0", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("0.9.0");
  });

  it("returns missing on ENOENT", async () => {
    const step = await new CodexAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
  });
});

describe("CodexAdapter.checkAuth", () => {
  it("exit 0 → ready", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "Logged in as shawn", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("ready");
  });

  it("exit non-zero + 'not logged in' stderr → needs_auth", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "you are not logged in", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("exit non-zero without auth pattern → misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 2, stdout: "", stderr: "keychain unlock failed", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("timeout → misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: undefined, stdout: "", stderr: "", durationMs: 5000, timedOut: true });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("invokes codex login status", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false });
    await a(run).checkAuth();
    expect(run).toHaveBeenCalledWith("/usr/bin/codex", ["login", "status"], expect.anything());
  });
});

describe("CodexAdapter.repairFor", () => {
  const adapter = new CodexAdapter(ok("/usr/bin/codex"), vi.fn());
  it("needs_auth → codex login", () => {
    expect(adapter.repairFor("needs_auth")).toMatchObject({ kind: "run_command", command: "codex login" });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- codex.readiness.test.ts`
Expected: fails.

- [ ] **Step 3: Implement the adapter checks**

Replace `apps/daemon/src/adapters/codex.ts` with:

```ts
import type {
  AgentAdapter,
  AdapterSpawnInput,
  AdapterSpawnResult,
  AdapterAvailability,
  AdapterContextDelivery,
} from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary, type ResolveFn } from "./resolve.js";
import { runCheckCommand, type RunCheckResult } from "../readiness/exec.js";
import { sanitizeOutput } from "../readiness/sanitize.js";
import { installUrlFor, signInCommandFor } from "../readiness/repair-links.js";
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

const NOT_LOGGED_IN = /\bnot (logged in|authenticated)\b|please (log|sign) in/i;

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly title = "Codex";
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`codex not found. Set ORCA_CODEX_BIN or install Codex. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" },
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `codex not found. Set ORCA_CODEX_BIN or install Codex. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "codex --version", detail: "codex not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"]);
    const version = parseVersion(r.stdout);
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "codex --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "codex --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "codex login status",
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["login", "status"]);
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "codex login status",
        detail: "timeout",
      };
    }
    if (r.exitCode === 0) {
      return {
        name: "authenticated",
        ok: true,
        authStatus: "ready",
        command: "codex login status",
        detail: "authenticated",
      };
    }
    const combined = `${r.stdout}\n${r.stderr}`;
    if (NOT_LOGGED_IN.test(combined)) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: "codex login status",
        detail: "not signed in",
      };
    }
    return {
      name: "authenticated",
      ok: false,
      authStatus: "misconfigured",
      command: "codex login status",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "unexpected login status output",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("codex");
      return url ? { kind: "install_url", url, label: "Install Codex" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("codex");
      return command ? { kind: "run_command", command, label: "Sign in to Codex" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "codex login status", label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_CODEX_BIN"];
  return override ? [override] : ["codex"];
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/daemon && pnpm test -- codex.readiness.test.ts`
Expected: every test passes.

- [ ] **Step 5: Do not commit yet**

Continue to Task 10.

---

## Task 10: OpenCode adapter checks

**Assigned model:** GPT 5.5  
**Effort:** High

**Files:**
- Modify: `apps/daemon/src/adapters/opencode.ts`
- Create: `apps/daemon/src/adapters/opencode.readiness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/opencode.readiness.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { OpenCodeAdapter } from "./opencode.js";
import type { RunCheckFn } from "./opencode.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["opencode"] });

function a(run: RunCheckFn, resolved = ok("/usr/bin/opencode")) {
  return new OpenCodeAdapter(resolved, run);
}

describe("OpenCodeAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "opencode 0.4.1\n", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("0.4.1");
  });

  it("returns missing on ENOENT", async () => {
    const step = await new OpenCodeAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
  });
});

describe("OpenCodeAdapter.checkAuth", () => {
  it("positive credential count → ready without persisting provider names", async () => {
    const stdout = [
      "┌  Credentials ~/.local/share/opencode/auth.json",
      "│",
      "●  MiniMax Token Plan (minimaxi.com) api",
      "│",
      "●  OpenAI oauth",
      "│",
      "2 credentials",
      "└",
    ].join("\n");
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toBe("authenticated (2 credentials)");
  });

  it("'0 credentials' footer or empty list → needs_auth", async () => {
    const stdout = "No credentials stored\n0 credentials\n";
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("empty stdout but exit 0 → needs_auth", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("exit non-zero → misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 2, stdout: "", stderr: "config parse error", durationMs: 1, timedOut: false });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("invokes opencode auth list with --pure to avoid plugin loading", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "1 credentials", stderr: "", durationMs: 1, timedOut: false });
    await a(run).checkAuth();
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/opencode",
      ["auth", "list", "--pure"],
      expect.anything(),
    );
  });
});

describe("OpenCodeAdapter.repairFor", () => {
  const adapter = new OpenCodeAdapter(ok("/usr/bin/opencode"), vi.fn());
  it("needs_auth → opencode auth login", () => {
    expect(adapter.repairFor("needs_auth")).toMatchObject({ kind: "run_command", command: "opencode auth login" });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/daemon && pnpm test -- opencode.readiness.test.ts`
Expected: fails.

- [ ] **Step 3: Implement the adapter checks**

Replace `apps/daemon/src/adapters/opencode.ts` with:

```ts
import type {
  AgentAdapter,
  AdapterSpawnInput,
  AdapterSpawnResult,
  AdapterAvailability,
  AdapterContextDelivery,
} from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary, type ResolveFn } from "./resolve.js";
import { runCheckCommand, type RunCheckResult } from "../readiness/exec.js";
import { sanitizeOutput } from "../readiness/sanitize.js";
import { installUrlFor, signInCommandFor } from "../readiness/repair-links.js";
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

const ANSI = /\[[0-9;]*[A-Za-z]/g;
// Current `opencode auth list` prints a TUI-like list plus a footer such as:
//   └  3 credentials
// Parse the count instead of provider labels; labels can contain spaces, domains,
// and auth method suffixes and may include account/provider-identifying text.
const CRED_COUNT = /^[\s│└┌─]*?(\d+)\s+credentials\s*$/im;
const ZERO_CRED_FOOTER = /^[\s│└┌─]*?0\s+credentials\s*$/im;

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const;
  readonly title = "opencode";
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`opencode not found. Set ORCA_OPENCODE_BIN or install opencode. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" },
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `opencode not found. Set ORCA_OPENCODE_BIN or install opencode. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "opencode --version", detail: "opencode not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"]);
    const version = parseVersion(r.stdout);
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "opencode --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "opencode --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "opencode auth list",
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["auth", "list", "--pure"]);
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "opencode auth list",
        detail: "timeout",
      };
    }
    if (r.exitCode !== 0) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "opencode auth list",
        exitCode: r.exitCode,
        errorOutput: sanitizeOutput(r.stderr || r.stdout),
        detail: "auth list failed",
      };
    }
    const cleaned = r.stdout.replace(ANSI, "");
    const countMatch = cleaned.match(CRED_COUNT);
    const credentialCount = countMatch ? Number(countMatch[1]) : 0;
    if (credentialCount <= 0 || ZERO_CRED_FOOTER.test(cleaned)) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: "opencode auth list",
        detail: "no credentials stored",
      };
    }
    return {
      name: "authenticated",
      ok: true,
      authStatus: "ready",
      command: "opencode auth list",
      detail: `authenticated (${credentialCount} credentials)`,
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("opencode");
      return url ? { kind: "install_url", url, label: "Install opencode" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("opencode");
      return command ? { kind: "run_command", command, label: "Sign in to opencode" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "opencode auth list", label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_OPENCODE_BIN"];
  return override ? [override] : ["opencode"];
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/daemon && pnpm test -- opencode.readiness.test.ts`
Expected: pass.

- [ ] **Step 5: Do not commit yet**

ShellManualAdapter also implements `AgentAdapter`. It needs the three new methods as no-ops. Continue to Task 11 which also covers Gemini + ShellManual.

---

## Task 11: Gemini adapter (new) + ShellManual stubs + commit Phase 1

**Assigned model:** Opus 4.7  
**Effort:** High

**Files:**
- Create: `apps/daemon/src/adapters/gemini.ts`
- Create: `apps/daemon/src/adapters/gemini.readiness.test.ts`
- Modify: `apps/daemon/src/adapters/shell-manual.ts` (add no-op readiness methods)

- [ ] **Step 1: Write the failing test for Gemini**

Create `apps/daemon/src/adapters/gemini.readiness.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiAdapter } from "./gemini.js";
import type { RunCheckFn } from "./gemini.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["gemini"] });

describe("GeminiAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "gemini 0.5.0", stderr: "", durationMs: 1, timedOut: false });
    const step = await new GeminiAdapter(ok("/usr/bin/gemini"), run, () => ({}), () => false).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("0.5.0");
  });

  it("returns missing on ENOENT", async () => {
    const step = await new GeminiAdapter(missing, vi.fn(), () => ({}), () => false).checkInstalled();
    expect(step.ok).toBe(false);
  });
});

describe("GeminiAdapter.checkAuth modes", () => {
  it("GEMINI_API_KEY → ready (gemini_api_key)", async () => {
    const env = () => ({ GEMINI_API_KEY: "secret" });
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), env, () => false);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toContain("gemini_api_key");
  });

  it("GOOGLE_API_KEY + GOOGLE_GENAI_USE_VERTEXAI=true → ready (vertex_api_key)", async () => {
    const env = () => ({ GOOGLE_API_KEY: "AIza-redacted", GOOGLE_GENAI_USE_VERTEXAI: "true" });
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), env, () => false);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toContain("vertex_api_key");
  });

  it("GOOGLE_CLOUD_PROJECT + LOCATION + ADC file → ready (vertex_adc)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "g-adc-"));
    const cred = path.join(tmp, "adc.json");
    writeFileSync(cred, "{}");
    const env = () => ({
      GOOGLE_CLOUD_PROJECT: "proj",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_APPLICATION_CREDENTIALS: cred,
    });
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), env, (p) => p === cred);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toContain("vertex_adc");
  });

  it("no env, no settings file → needs_auth", async () => {
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), () => ({}), () => false);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("settings.json says vertex-ai but no credentials → misconfigured", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "g-settings-"));
    const settings = path.join(tmp, "settings.json");
    writeFileSync(settings, JSON.stringify({ selectedAuthType: "vertex-ai" }));
    const env = () => ({});
    const a = new GeminiAdapter(
      ok("/usr/bin/gemini"),
      vi.fn(),
      env,
      (p) => p === settings,
      (p) => (p === settings ? JSON.stringify({ selectedAuthType: "vertex-ai" }) : ""),
    );
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });
});

describe("GeminiAdapter.repairFor", () => {
  const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), () => ({}), () => false);
  it("needs_auth includes requiresAppRestart for env-based fixes", () => {
    expect(a.repairFor("needs_auth")).toMatchObject({ requiresAppRestart: true });
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `cd apps/daemon && pnpm test -- gemini.readiness.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Create the Gemini adapter**

Create `apps/daemon/src/adapters/gemini.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type {
  AgentAdapter,
  AdapterSpawnInput,
  AdapterSpawnResult,
  AdapterAvailability,
  AdapterContextDelivery,
} from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary, type ResolveFn } from "./resolve.js";
import { runCheckCommand, type RunCheckResult } from "../readiness/exec.js";
import { sanitizeOutput } from "../readiness/sanitize.js";
import { installUrlFor, signInCommandFor } from "../readiness/repair-links.js";
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

type EnvReader = () => Record<string, string | undefined>;
type FileExists = (p: string) => boolean;
type FileReader = (p: string) => string;

export class GeminiAdapter implements AgentAdapter {
  readonly id = "gemini-cli" as const;
  readonly title = "Gemini CLI";
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
    private readonly envFn: EnvReader = () => process.env as Record<string, string | undefined>,
    private readonly existsFn: FileExists = existsSync,
    private readonly readFn: FileReader = (p) => readFileSync(p, "utf8"),
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`gemini not found. Set ORCA_GEMINI_CLI_BIN or install Gemini CLI. Tried: ${result.tried.join(", ")}`),
        { code: "command_not_found" },
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `gemini not found. Set ORCA_GEMINI_CLI_BIN or install Gemini CLI. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "gemini --version", detail: "gemini not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"]);
    const version = parseVersion(r.stdout);
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "gemini --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "gemini --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const env = this.envFn();
    const cmd = "gemini auth (configuration probe)";
    const home = env["HOME"] ?? os.homedir();
    const settingsPath = path.join(home, ".gemini", "settings.json");

    // 1. Gemini API key
    if (nonEmpty(env["GEMINI_API_KEY"])) {
      return readyStep(cmd, "gemini_api_key");
    }

    // Parse settings if present (used by modes 2 + 4)
    let settings: { selectedAuthType?: string } | null = null;
    if (this.existsFn(settingsPath)) {
      try {
        settings = JSON.parse(this.readFn(settingsPath));
      } catch {
        settings = null;
      }
    }

    // 2. Vertex API key (express mode)
    //    Gemini SDK + CLI use GOOGLE_API_KEY together with GOOGLE_GENAI_USE_VERTEXAI=true
    //    to select Vertex AI in express mode. Settings.json is a secondary signal.
    const usingVertexFromEnv =
      isTruthyEnvFlag(env["GOOGLE_GENAI_USE_VERTEXAI"]) || settings?.selectedAuthType === "vertex-ai";
    if (nonEmpty(env["GOOGLE_API_KEY"]) && usingVertexFromEnv) {
      return readyStep(cmd, "vertex_api_key");
    }

    // 3. Vertex ADC / service account
    const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GOOGLE_CLOUD_PROJECT_ID"];
    const location = env["GOOGLE_CLOUD_LOCATION"];
    const credEnv = env["GOOGLE_APPLICATION_CREDENTIALS"];
    const adcDefault = path.join(home, ".config", "gcloud", "application_default_credentials.json");
    if (project && location) {
      const credPath = credEnv ?? (this.existsFn(adcDefault) ? adcDefault : null);
      if (credPath && this.existsFn(credPath)) {
        return readyStep(cmd, "vertex_adc");
      }
    }

    // 4. OAuth (Google login)
    if (settings?.selectedAuthType === "oauth-personal") {
      const cache = path.join(home, ".gemini", "oauth_creds.json");
      if (this.existsFn(cache)) {
        return readyStep(cmd, "oauth");
      }
      // partial match: settings says oauth, no credential cache → misconfigured
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: cmd,
        detail: "settings.json selectedAuthType=oauth-personal but credential cache missing",
      };
    }

    // Partial vertex configuration but no creds → misconfigured
    if (settings?.selectedAuthType === "vertex-ai") {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: cmd,
        detail: "settings.json selects vertex-ai but no credentials found",
      };
    }

    return {
      name: "authenticated",
      ok: false,
      authStatus: "needs_auth",
      command: cmd,
      detail: "no Gemini credentials detected",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("gemini-cli");
      return url ? { kind: "install_url", url, label: "Install Gemini CLI" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("gemini-cli");
      return command
        ? { kind: "run_command", command, label: "Sign in to Gemini CLI", requiresAppRestart: true }
        : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "gemini", label: "Retry after fixing config", requiresAppRestart: true };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_GEMINI_CLI_BIN"];
  return override ? [override] : ["gemini"];
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}

function nonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

function isTruthyEnvFlag(v: string | undefined): boolean {
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes";
}

function readyStep(command: string, method: string): CheckStep {
  return {
    name: "authenticated",
    ok: true,
    authStatus: "ready",
    command,
    detail: `configuration detected; not smoke-tested (${method})`,
  };
}
```

Before landing this task, verify the OAuth cache filename against the current Gemini CLI source. If `~/.gemini/oauth_creds.json` has drifted, update the constant and the `oauth-personal` test fixture in this task; do not silently fall back to a generic `settings.json exists` heuristic.

- [ ] **Step 4: Add ShellManual no-op stubs**

Edit `apps/daemon/src/adapters/shell-manual.ts`. Append these three methods to the class body:

```ts
async checkInstalled() {
  return { name: "installed" as const, ok: true, command: "shell" };
}
async checkAuth() {
  return { name: "authenticated" as const, ok: true, authStatus: "ready" as const, command: "shell" };
}
repairFor() {
  return undefined;
}
```

Add the import at the top of that file:

```ts
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";
```

- [ ] **Step 5: Register Gemini in bootstrap**

Open `apps/daemon/src/registry/bootstrap.test.ts` (and the corresponding source) to find where `ClaudeCodeAdapter`, `CodexAdapter`, and `OpenCodeAdapter` are registered. Add `GeminiAdapter` next to them:

In the source file that registers built-in adapters (search the codebase via `grep -rn "new CodexAdapter" apps/daemon/src` — typically `apps/daemon/src/index.ts` or `apps/daemon/src/daemon-context.ts`), add:

```ts
import { GeminiAdapter } from "./adapters/gemini.js";
// ...
adapterRegistry.register(new GeminiAdapter());
```

If `registry/bootstrap.test.ts` asserts the set of registered adapters, update the expected set to include `gemini-cli`.

- [ ] **Step 6: Run all daemon tests + typecheck**

Run: `cd apps/daemon && pnpm typecheck && pnpm test`
Expected: typecheck clean (adapter interface fully implemented everywhere); all tests pass.

- [ ] **Step 7: Now extend the AgentAdapter interface (Task 7 deferred work)**

Edit `apps/daemon/src/adapters/types.ts`. Add the import + extend the interface:

```ts
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export interface AgentAdapter {
  id: AdapterId;
  title: string;
  contextDelivery: AdapterContextDelivery;
  resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult>;
  probeAvailability(): Promise<AdapterAvailability>;

  checkInstalled(): Promise<CheckStep & { version?: string }>;
  checkAuth(): Promise<CheckStep>;
  repairFor(status: AgentReadinessStatus): RepairAction | undefined;
}
```

Run: `cd apps/daemon && pnpm typecheck && pnpm test`
Expected: green — every adapter already implements the three methods from Tasks 8–11.

- [ ] **Step 8: Commit Phase 1 (adapters + interface)**

```bash
git add apps/daemon/src/adapters apps/daemon/src/readiness apps/daemon/src/registry packages/contracts/src/index.ts packages/contracts/src/index.test.ts packages/contracts/dist
git commit -m "feat(daemon): per-agent readiness checks (claude/codex/opencode/gemini)"
```

Note: contracts dist may already be committed in Task 1. If `git status` shows nothing under `packages/contracts`, drop those paths from the `git add`.

---

## Task 12: ReadinessService

**Assigned model:** GPT 5.5  
**Effort:** High

**Files:**
- Create: `apps/daemon/src/readiness/service.ts`
- Create: `apps/daemon/src/readiness/service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/daemon/src/readiness/service.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "../db.js";
import { runMigrations, defaultMigrationsDir } from "../migrations.js";
import { seedAgents, setAgentConnected, listAgents } from "../agents.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { AgentAdapter } from "../adapters/types.js";
import { ReadinessService, UnknownAgentError } from "./service.js";
import type { AgentReadinessStatus, CheckStep } from "@orca/contracts";

function makeAdapter(id: string, opts: {
  install: CheckStep & { version?: string };
  auth: CheckStep;
  throws?: boolean;
}): AgentAdapter {
  return {
    id: id as never,
    title: id,
    contextDelivery: { mode: "preview_only", maxBytes: 32768 },
    async resolveSpawn() { throw new Error("unused"); },
    async probeAvailability() { return { status: "available" as const }; },
    async checkInstalled() {
      if (opts.throws) throw new Error("boom");
      return opts.install;
    },
    async checkAuth() { return opts.auth; },
    repairFor(s: AgentReadinessStatus) {
      if (s === "ready") return undefined;
      return { kind: "run_command" as const, command: `${id} fix`, label: "Fix" };
    },
  };
}

let db: Database.Database;
beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-svc-"));
  db = openDatabase({
    dataDir: dir, port: 0, logLevel: "silent",
    sessionOutputTailBytes: 1024, sessionStopGraceMs: 100, sessionWsBufferLimitBytes: 1024,
    memoryExtractionMaxInputBytes: 1024, memoryExtractionTimeoutMs: 1000,
    getAuthToken: () => "t",
  });
  runMigrations(db, defaultMigrationsDir());
  seedAgents(db);
});

describe("ReadinessService.checkAgent", () => {
  it("install ok + auth ready → status ready, persisted", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("claude-code", {
      install: { name: "installed", ok: true, command: "claude --version", version: "1.2.3" },
      auth: { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
    }));
    setAgentConnected(db, "claude-code", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("claude-code");
    expect(report.status).toBe("ready");
    expect(report.steps).toHaveLength(2);
    const row = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(row.readiness?.status).toBe("ready");
  });

  it("install fails → status missing, auth skipped", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex", {
      install: { name: "installed", ok: false, command: "codex --version", detail: "not found" },
      auth: { name: "authenticated", ok: false, authStatus: "needs_auth", command: "codex login status" },
    }));
    setAgentConnected(db, "codex", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("codex");
    expect(report.status).toBe("missing");
    expect(report.steps).toHaveLength(1);
    expect(report.repair).toBeDefined();
  });

  it("authStatus needs_auth → status needs_auth, repair set", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex", {
      install: { name: "installed", ok: true, command: "codex --version" },
      auth: { name: "authenticated", ok: false, authStatus: "needs_auth", command: "codex login status" },
    }));
    setAgentConnected(db, "codex", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("codex");
    expect(report.status).toBe("needs_auth");
    expect(report.repair?.command).toBe("codex fix");
  });

  it("adapter throws → persisted failed report (not stale)", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("opencode", {
      install: { name: "installed", ok: true, command: "opencode --version" },
      auth: { name: "authenticated", ok: true, authStatus: "ready", command: "opencode auth list" },
      throws: true,
    }));
    setAgentConnected(db, "opencode", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("opencode");
    expect(report.status).toBe("failed");
    const row = listAgents(db).find((a) => a.id === "opencode")!;
    expect(row.readiness?.status).toBe("failed");
  });

  it("unknown agent throws UnknownAgentError", async () => {
    const svc = new ReadinessService(db, new AdapterRegistry());
    await expect(svc.checkAgent("nope")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("dedups concurrent calls for the same id", async () => {
    let count = 0;
    const registry = new AdapterRegistry();
    registry.register({
      ...makeAdapter("claude-code", {
        install: { name: "installed", ok: true, command: "claude --version" },
        auth: { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
      }),
      async checkInstalled() {
        count++;
        await new Promise((r) => setTimeout(r, 50));
        return { name: "installed" as const, ok: true, command: "claude --version" };
      },
    });
    setAgentConnected(db, "claude-code", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    await Promise.all([svc.checkAgent("claude-code"), svc.checkAgent("claude-code")]);
    expect(count).toBe(1);
  });
});

describe("ReadinessService.checkSelected", () => {
  it("runs only connected agents in parallel", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("claude-code", {
      install: { name: "installed", ok: true, command: "claude --version" },
      auth: { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
    }));
    registry.register(makeAdapter("codex", {
      install: { name: "installed", ok: true, command: "codex --version" },
      auth: { name: "authenticated", ok: false, authStatus: "needs_auth", command: "codex login status" },
    }));
    setAgentConnected(db, "claude-code", true);
    setAgentConnected(db, "codex", true);
    // gemini-cli + opencode left disconnected
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const reports = await svc.checkSelected();
    expect(reports.map((r) => r.agentId).sort()).toEqual(["claude-code", "codex"]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/daemon && pnpm test -- readiness/service.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement the service**

Create `apps/daemon/src/readiness/service.ts`:

```ts
import type Database from "better-sqlite3";
import type { AgentReadinessReport, AgentReadinessStatus, CheckStep } from "@orca/contracts";
import { AdapterRegistry } from "../adapters/registry.js";
import { listAgents, persistReadiness } from "../agents.js";
import { sanitizeOutput } from "./sanitize.js";

export class UnknownAgentError extends Error {
  constructor(public readonly id: string) {
    super(`Unknown adapter: ${id}`);
    this.name = "UnknownAgentError";
  }
}

export class NotConnectedError extends Error {
  constructor(public readonly id: string) {
    super(`Agent not connected: ${id}`);
    this.name = "NotConnectedError";
  }
}

const AGENT_BUDGET_MS = 12_000;

export class ReadinessService {
  private readonly inFlight = new Map<string, Promise<AgentReadinessReport>>();

  constructor(
    private readonly db: Database.Database,
    private readonly registry: AdapterRegistry,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  checkAgent(agentId: string): Promise<AgentReadinessReport> {
    const existing = this.inFlight.get(agentId);
    if (existing) return existing;
    const p = this.runOne(agentId).finally(() => this.inFlight.delete(agentId));
    this.inFlight.set(agentId, p);
    return p;
  }

  async checkSelected(): Promise<AgentReadinessReport[]> {
    const connected = listAgents(this.db).filter((a) => a.connected);
    const outcomes = await Promise.allSettled(connected.map((a) => this.checkAgent(a.id)));
    return outcomes.map((o, i) => {
      if (o.status === "fulfilled") return o.value;
      return this.persistedFailedReport(connected[i]!.id, o.reason);
    });
  }

  private async runOne(agentId: string): Promise<AgentReadinessReport> {
    const adapter = this.registry.get(agentId);
    if (!adapter) throw new UnknownAgentError(agentId);

    const checkedAt = this.clock();
    try {
      const report = await this.withBudget(agentId, adapter, checkedAt);
      persistReadiness(this.db, report, checkedAt);
      return report;
    } catch (err) {
      return this.persistedFailedReport(agentId, err);
    }
  }

  private async withBudget(
    agentId: string,
    adapter: ReturnType<AdapterRegistry["get"]> & {},
    checkedAt: string,
  ): Promise<AgentReadinessReport> {
    let budgetTimer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.runChecks(agentId, adapter, checkedAt),
        new Promise<AgentReadinessReport>((_, reject) => {
          budgetTimer = setTimeout(() => reject(new Error("agent budget exceeded")), AGENT_BUDGET_MS);
        }),
      ]);
    } finally {
      // Note: budget timeout does not cancel adapter work — adapters do not yet accept
      // AbortSignal. The losing branch continues and is GC'd when its promise settles.
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  }

  private async runChecks(
    agentId: string,
    adapter: NonNullable<ReturnType<AdapterRegistry["get"]>>,
    checkedAt: string,
  ): Promise<AgentReadinessReport> {
    const installed = await adapter.checkInstalled();
    const steps: CheckStep[] = [installed];

    if (!installed.ok) {
      const status: AgentReadinessStatus = "missing";
      return {
        agentId,
        status,
        steps,
        repair: adapter.repairFor(status),
        checkedAt,
        version: installed.version,
      };
    }

    const auth = await adapter.checkAuth();
    steps.push(auth);

    const status: AgentReadinessStatus =
      auth.authStatus === "ready"
        ? "ready"
        : auth.authStatus === "needs_auth"
          ? "needs_auth"
          : "misconfigured";

    return {
      agentId,
      status,
      steps,
      repair: adapter.repairFor(status),
      checkedAt,
      version: installed.version,
    };
  }

  private persistedFailedReport(agentId: string, reason: unknown): AgentReadinessReport {
    const checkedAt = this.clock();
    const message = reason instanceof Error ? reason.message : String(reason);
    const adapter = this.registry.get(agentId);
    const repair =
      adapter?.repairFor("failed") ??
      { kind: "run_command" as const, command: "", label: "Retry" };

    const report: AgentReadinessReport = {
      agentId,
      status: "failed",
      steps: [
        {
          name: "installed",
          ok: false,
          command: "(check)",
          detail: sanitizeOutput(message),
          errorOutput: sanitizeOutput(message),
        },
      ],
      repair,
      checkedAt,
    };
    persistReadiness(this.db, report, checkedAt);
    return report;
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd apps/daemon && pnpm test -- readiness/service.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/readiness/service.ts apps/daemon/src/readiness/service.test.ts
git commit -m "feat(daemon): ReadinessService runs and persists checks"
```

---

## Task 13: HTTP routes + extend GET /v1/agents

**Assigned model:** GPT 5.4  
**Effort:** Medium

**Files:**
- Modify: `apps/daemon/src/server.ts`
- Modify: `apps/daemon/src/server.test.ts`
- Modify: `apps/daemon/src/daemon-context.ts` (wire ReadinessService into the route handlers, parallel to how other services are wired)

- [ ] **Step 1: Write the failing tests**

**Critical:** route tests must **not** invoke real local CLIs. Inject a fake `AdapterRegistry` populated with mock adapters that return canned `CheckStep` results. The existing `startServer()` helper builds an `AdapterRegistry`; extend it to accept an override so tests can pass a fake.

Append to `apps/daemon/src/server.test.ts`:

```ts
import { AdapterRegistry } from "./adapters/registry.js";
import type { AgentAdapter } from "./adapters/types.js";

function fakeAdapter(id: string, ready: boolean): AgentAdapter {
  return {
    id: id as never,
    title: id,
    contextDelivery: { mode: "preview_only", maxBytes: 32768 },
    async resolveSpawn() { throw new Error("unused"); },
    async probeAvailability() { return { status: "available" as const }; },
    async checkInstalled() {
      return { name: "installed", ok: true, command: `${id} --version`, version: "1.0.0" };
    },
    async checkAuth() {
      return ready
        ? { name: "authenticated", ok: true, authStatus: "ready", command: `${id} auth`, detail: "authenticated" }
        : { name: "authenticated", ok: false, authStatus: "needs_auth", command: `${id} auth`, detail: "not signed in" };
    },
    repairFor() { return undefined; },
  };
}

function fakeRegistry(): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register(fakeAdapter("claude-code", true));
  r.register(fakeAdapter("codex", false));
  r.register(fakeAdapter("opencode", true));
  r.register(fakeAdapter("gemini-cli", false));
  return r;
}

describe("agent readiness routes (with fake adapters)", () => {
  it("GET /v1/agents includes readiness field", async () => {
    const { server, token } = await startServer({ adapterRegistry: fakeRegistry() });
    const res = await server.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: Array<{ id: string; readiness: unknown }> };
    for (const a of body.agents) {
      expect(a).toHaveProperty("readiness");
    }
  });

  it("POST /v1/agents/readiness:check runs connected agents only", async () => {
    const { server, token, db } = await startServer({ adapterRegistry: fakeRegistry() });
    db.prepare(`UPDATE agents SET connected = 1 WHERE id = ?`).run("claude-code");
    const res = await server.inject({
      method: "POST",
      url: "/v1/agents/readiness:check",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reports: Array<{ agentId: string; status: string }> };
    expect(body.reports.map((r) => r.agentId)).toEqual(["claude-code"]);
    expect(body.reports[0].status).toBe("ready");
  });

  it("POST /v1/agents/:id/readiness:check 404s on unknown id", async () => {
    const { server, token } = await startServer({ adapterRegistry: fakeRegistry() });
    const res = await server.inject({
      method: "POST",
      url: "/v1/agents/does-not-exist/readiness:check",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /v1/agents/:id/readiness:check 400s on not-connected", async () => {
    const { server, token, db } = await startServer({ adapterRegistry: fakeRegistry() });
    db.prepare(`UPDATE agents SET connected = 0 WHERE id = ?`).run("codex");
    const res = await server.inject({
      method: "POST",
      url: "/v1/agents/codex/readiness:check",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /v1/agents/:id/readiness:check accepts empty body", async () => {
    const { server, token, db } = await startServer({ adapterRegistry: fakeRegistry() });
    db.prepare(`UPDATE agents SET connected = 1 WHERE id = ?`).run("claude-code");
    const res = await server.inject({
      method: "POST",
      url: "/v1/agents/claude-code/readiness:check",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

`startServer()` is the existing helper in `server.test.ts`. Extend it to:
1. Expose `db` on the returned object (if not already).
2. Accept an optional `{ adapterRegistry?: AdapterRegistry }` argument; when provided, use it instead of the default registry — pass it through to wherever the server constructs `ReadinessService`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/daemon && pnpm test -- server.test.ts`
Expected: fails — routes don't exist.

- [ ] **Step 3: Wire ReadinessService into the server**

Edit `apps/daemon/src/server.ts`. Near the top imports:

```ts
import { ReadinessService, UnknownAgentError, NotConnectedError } from "./readiness/service.js";
import { CheckReadinessAllResponse, CheckReadinessOneResponse } from "@orca/contracts";
```

In the `buildServer` function (or wherever services are constructed — match existing pattern), instantiate the service alongside others:

```ts
const readinessService = new ReadinessService(db, adapterRegistry);
```

Add the two routes (place them next to the existing `/v1/agents` PATCH route). Both routes accept an empty body — do **not** attach a Zod body schema; Fastify defaults to accepting empty/missing payloads when no schema is set:

```ts
server.post("/v1/agents/readiness:check", async (_req, _reply) => {
  const reports = await readinessService.checkSelected();
  return CheckReadinessAllResponse.parse({ reports });
});

server.post<{ Params: { id: string } }>(
  "/v1/agents/:id/readiness:check",
  async (req, reply) => {
    const { id } = req.params;
    try {
      const agent = listAgents(db).find((a) => a.id === id);
      if (!agent) {
        reply.code(404);
        return { error: "not_found" };
      }
      if (!agent.connected) {
        reply.code(400);
        return { error: "not_connected" };
      }
      const report = await readinessService.checkAgent(id);
      return CheckReadinessOneResponse.parse({ report });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        reply.code(404);
        return { error: "not_found" };
      }
      if (err instanceof NotConnectedError) {
        reply.code(400);
        return { error: "not_connected" };
      }
      throw err;
    }
  },
);
```

The existing `GET /v1/agents` handler already calls `listAgents(db)` and returns the rows. Now that `Agent` includes `readiness`, no change is required there — but verify by re-running the existing tests.

- [ ] **Step 4: Run the daemon test suite**

Run: `cd apps/daemon && pnpm test`
Expected: all tests pass including the new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/server.test.ts apps/daemon/src/daemon-context.ts
git commit -m "feat(daemon): expose readiness check routes"
```

---

## Task 14: Desktop API client

**Assigned model:** Codex 5.3  
**Effort:** Low

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Modify: `apps/desktop/src/api.test.ts` (append cases)

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/api.test.ts`:

```ts
import { runReadinessCheck, runReadinessCheckForAgent } from "./api";

describe("readiness api", () => {
  it("runReadinessCheck POSTs and returns reports", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          reports: [
            {
              agentId: "claude-code",
              status: "ready",
              steps: [],
              checkedAt: "2026-05-22T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const reports = await runReadinessCheck();
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe("ready");
  });

  it("runReadinessCheckForAgent POSTs to per-agent endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          report: {
            agentId: "codex",
            status: "needs_auth",
            steps: [],
            repair: { kind: "run_command", command: "codex login", label: "Sign in" },
            checkedAt: "2026-05-22T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const report = await runReadinessCheckForAgent("codex");
    expect(report.status).toBe("needs_auth");
    const call = fetchMock.mock.calls[0][0];
    expect(call).toContain("/v1/agents/codex/readiness:check");
  });
});
```

(The exact `fetchMock` plumbing should match the patterns already in `api.test.ts` — reuse the existing test helpers.)

- [ ] **Step 2: Run and confirm fail**

Run: `cd apps/desktop && pnpm test -- api.test.ts`
Expected: fails — functions not exported.

- [ ] **Step 3: Add the API functions**

Append to `apps/desktop/src/api.ts`:

```ts
import {
  CheckReadinessAllResponse,
  CheckReadinessOneResponse,
  type AgentReadinessReport,
} from "@orca/contracts";

export async function runReadinessCheck(): Promise<AgentReadinessReport[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/agents/readiness:check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: "{}",
  });
  if (!res.ok) throw new ApiError(`Readiness check failed (${res.status})`);
  const body = await parseResponse(res, CheckReadinessAllResponse);
  return body.reports;
}

export async function runReadinessCheckForAgent(id: string): Promise<AgentReadinessReport> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(
    `${baseUrl}/v1/agents/${encodeURIComponent(id)}/readiness:check`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: "{}",
    },
  );
  if (!res.ok) throw new ApiError(`Readiness check for ${id} failed (${res.status})`);
  const body = await parseResponse(res, CheckReadinessOneResponse);
  return body.report;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/desktop && pnpm test -- api.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts
git commit -m "feat(desktop): readiness API client functions"
```

---

## Task 15: `RepairBlock` component

**Assigned model:** Sonnet 4.6  
**Effort:** Medium

**Files:**
- Create: `apps/desktop/src/onboarding/RepairBlock.tsx`
- Create: `apps/desktop/src/onboarding/RepairBlock.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/onboarding/RepairBlock.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepairBlock } from "./RepairBlock";

describe("RepairBlock", () => {
  it("renders the command in a <code> block and copies it on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <RepairBlock
        repair={{ kind: "run_command", command: "codex login", label: "Sign in to Codex" }}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(screen.getByTestId("repair-command")).toHaveTextContent("codex login");
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("codex login");
  });

  it("renders install_url with a clickable Install button", () => {
    const onOpenUrl = vi.fn();
    render(
      <RepairBlock
        repair={{ kind: "install_url", url: "https://example.com", label: "Install Gemini CLI" }}
        onOpenUrl={onOpenUrl}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("shows 'Restart Orca' hint when requiresAppRestart is true", () => {
    render(
      <RepairBlock
        repair={{
          kind: "run_command",
          command: "export GEMINI_API_KEY=...",
          label: "Set API key",
          requiresAppRestart: true,
        }}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(screen.getByText(/restart orca/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `cd apps/desktop && pnpm test -- RepairBlock.test.tsx`
Expected: fails — component does not exist.

- [ ] **Step 3: Create the component**

Create `apps/desktop/src/onboarding/RepairBlock.tsx`:

```tsx
import type { RepairAction } from "@orca/contracts";

interface RepairBlockProps {
  repair: RepairAction;
  onOpenUrl: (url: string) => void;
}

export function RepairBlock({ repair, onOpenUrl }: RepairBlockProps) {
  if (repair.kind === "install_url" && repair.url) {
    return (
      <div className="repair-block">
        <button type="button" onClick={() => onOpenUrl(repair.url!)}>
          {repair.label}
        </button>
      </div>
    );
  }
  if (repair.kind === "run_command" && repair.command) {
    return (
      <div className="repair-block">
        <code data-testid="repair-command" aria-label={repair.label}>{repair.command}</code>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(repair.command!)}
        >
          Copy
        </button>
        {repair.requiresAppRestart && (
          <span className="repair-block-hint">Restart Orca after running this.</span>
        )}
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/desktop && pnpm test -- RepairBlock.test.tsx`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/onboarding/RepairBlock.tsx apps/desktop/src/onboarding/RepairBlock.test.tsx
git commit -m "feat(desktop): RepairBlock component"
```

---

## Task 16: `ReadinessRow` component

**Assigned model:** Sonnet 4.6  
**Effort:** Medium

**Files:**
- Create: `apps/desktop/src/onboarding/ReadinessRow.tsx`
- Create: `apps/desktop/src/onboarding/ReadinessRow.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/onboarding/ReadinessRow.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReadinessRow } from "./ReadinessRow";

const baseAgent = {
  id: "claude-code",
  name: "Claude Code",
  shortLabel: "Anthropic · CLI",
  description: "Deep planning",
  swatch: "#D97757",
  recommended: true,
  connected: true,
  sortOrder: 10,
  createdAt: "2026-05-22T00:00:00.000Z",
  updatedAt: "2026-05-22T00:00:00.000Z",
  readiness: null,
};

describe("ReadinessRow", () => {
  it("renders 'Checking' when status is checking", () => {
    render(<ReadinessRow agent={baseAgent} state="checking" onRetry={vi.fn()} onOpenUrl={vi.fn()} />);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it("renders 'Ready' with version on ready", () => {
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          readiness: {
            agentId: "claude-code",
            status: "ready",
            steps: [],
            checkedAt: "2026-05-22T00:00:00.000Z",
            version: "1.2.3",
          },
        }}
        state="settled"
        onRetry={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByText(/1\.2\.3/)).toBeInTheDocument();
  });

  it("renders Retry button on needs_auth", () => {
    const onRetry = vi.fn();
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          readiness: {
            agentId: "claude-code",
            status: "needs_auth",
            steps: [],
            repair: { kind: "run_command", command: "claude auth login", label: "Sign in" },
            checkedAt: "2026-05-22T00:00:00.000Z",
          },
        }}
        state="settled"
        onRetry={onRetry}
        onOpenUrl={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledWith("claude-code");
  });

  it("Gemini ready row includes the 'configuration detected' qualifier", () => {
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          id: "gemini-cli",
          name: "Gemini CLI",
          readiness: {
            agentId: "gemini-cli",
            status: "ready",
            steps: [
              {
                name: "authenticated",
                ok: true,
                authStatus: "ready",
                command: "gemini auth (configuration probe)",
                detail: "configuration detected; not smoke-tested (gemini_api_key)",
              },
            ],
            checkedAt: "2026-05-22T00:00:00.000Z",
          },
        }}
        state="settled"
        onRetry={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(screen.getByText(/configuration detected; not smoke-tested/i)).toBeInTheDocument();
  });

  it("disables Retry with tooltip when requiresAppRestart is true", () => {
    render(
      <ReadinessRow
        agent={{
          ...baseAgent,
          id: "gemini-cli",
          readiness: {
            agentId: "gemini-cli",
            status: "needs_auth",
            steps: [],
            repair: {
              kind: "run_command",
              command: "export GEMINI_API_KEY=...",
              label: "Set API key",
              requiresAppRestart: true,
            },
            checkedAt: "2026-05-22T00:00:00.000Z",
          },
        }}
        state="settled"
        onRetry={vi.fn()}
        onOpenUrl={vi.fn()}
      />,
    );
    const retry = screen.getByRole("button", { name: /retry/i });
    expect(retry).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `cd apps/desktop && pnpm test -- ReadinessRow.test.tsx`
Expected: fails.

- [ ] **Step 3: Create the component**

Create `apps/desktop/src/onboarding/ReadinessRow.tsx`:

```tsx
import type { Agent, AgentReadinessReport } from "@orca/contracts";
import { RepairBlock } from "./RepairBlock";

export type RowState = "checking" | "settled";

interface ReadinessRowProps {
  agent: Agent;
  state: RowState;
  onRetry: (id: string) => void;
  onOpenUrl: (url: string) => void;
}

export function ReadinessRow({ agent, state, onRetry, onOpenUrl }: ReadinessRowProps) {
  const r = agent.readiness;
  const status = state === "checking" ? "checking" : r?.status ?? "unchecked";
  const requiresRestart = r?.repair?.requiresAppRestart === true;

  return (
    <div className="readiness-row" role="status" aria-live="polite" data-status={status}>
      <div className="readiness-row-head">
        <span className="readiness-row-name">{agent.name}</span>
        <span className="readiness-row-status">{labelFor(status)}</span>
        {r?.version && <span className="readiness-row-version">{r.version}</span>}
      </div>
      {state === "settled" && r?.steps?.map((s, i) => (
        <div key={i} className="readiness-row-step">
          {s.ok ? "✓" : "✗"} {s.detail ?? s.name}
        </div>
      ))}
      {state === "settled" && r?.repair && (
        <RepairBlock repair={r.repair} onOpenUrl={onOpenUrl} />
      )}
      {state === "settled" && status !== "ready" && (
        <button
          type="button"
          onClick={() => onRetry(agent.id)}
          disabled={requiresRestart}
          title={requiresRestart ? "Restart Orca first" : undefined}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function labelFor(status: string): string {
  switch (status) {
    case "checking": return "Checking…";
    case "ready": return "Ready";
    case "missing": return "Not installed";
    case "needs_auth": return "Not signed in";
    case "misconfigured": return "Misconfigured";
    case "failed": return "Check failed";
    default: return "Unchecked";
  }
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/desktop && pnpm test -- ReadinessRow.test.tsx`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/onboarding/ReadinessRow.tsx apps/desktop/src/onboarding/ReadinessRow.test.tsx
git commit -m "feat(desktop): ReadinessRow component"
```

---

## Task 17: `ReadinessPanel` component

**Assigned model:** Sonnet 4.6  
**Effort:** High

**Files:**
- Create: `apps/desktop/src/onboarding/ReadinessPanel.tsx`
- Create: `apps/desktop/src/onboarding/ReadinessPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/onboarding/ReadinessPanel.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReadinessPanel } from "./ReadinessPanel";

const agents = [
  { id: "claude-code", name: "Claude Code", connected: true, recommended: true, sortOrder: 10, shortLabel: "x", description: "x", swatch: "#000", createdAt: "2026-05-22T00:00:00.000Z", updatedAt: "2026-05-22T00:00:00.000Z", readiness: null },
];

const mockRunAll = vi.fn();
const mockRunOne = vi.fn();
const mockOpenUrl = vi.fn();

beforeEach(() => {
  mockRunAll.mockReset();
  mockRunOne.mockReset();
});

describe("ReadinessPanel", () => {
  it("calls runReadinessCheck on mount and renders a row per agent", async () => {
    mockRunAll.mockResolvedValue([
      { agentId: "claude-code", status: "ready", steps: [], checkedAt: "2026-05-22T00:00:00.000Z", version: "1.2.3" },
    ]);
    render(
      <ReadinessPanel
        agents={agents as never}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockRunAll).toHaveBeenCalled());
    expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
  });

  it("Retry on a row calls runOne and replaces only that row's report", async () => {
    mockRunAll.mockResolvedValue([
      { agentId: "claude-code", status: "needs_auth", steps: [], repair: { kind: "run_command", command: "claude auth login", label: "Sign in" }, checkedAt: "2026-05-22T00:00:00.000Z" },
    ]);
    mockRunOne.mockResolvedValue({ agentId: "claude-code", status: "ready", steps: [], checkedAt: "2026-05-22T00:01:00.000Z", version: "1.2.3" });
    render(
      <ReadinessPanel
        agents={agents as never}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockRunAll).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(mockRunOne).toHaveBeenCalledWith("claude-code"));
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
  });

  it("uses cached <60s reports without auto-rechecking", async () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    render(
      <ReadinessPanel
        agents={[
          { ...agents[0], readiness: { agentId: "claude-code", status: "ready", steps: [], checkedAt: recent, version: "1.2.3" } } as never,
        ]}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={vi.fn()}
      />,
    );
    expect(mockRunAll).not.toHaveBeenCalled();
    expect(screen.getByText(/last checked/i)).toBeInTheDocument();
  });

  it("emits onChange with readyCount so parent can gate Continue", async () => {
    mockRunAll.mockResolvedValue([
      { agentId: "claude-code", status: "ready", steps: [], checkedAt: "2026-05-22T00:00:00.000Z" },
    ]);
    const onChange = vi.fn();
    render(
      <ReadinessPanel
        agents={agents as never}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={onChange}
      />,
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ readyCount: 1, settled: true }),
    );
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `cd apps/desktop && pnpm test -- ReadinessPanel.test.tsx`
Expected: fails.

- [ ] **Step 3: Create the component**

Create `apps/desktop/src/onboarding/ReadinessPanel.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentReadinessReport } from "@orca/contracts";
import { ReadinessRow } from "./ReadinessRow";

const CACHE_TTL_MS = 60_000;

interface ReadinessPanelProps {
  agents: Agent[];
  runAll: () => Promise<AgentReadinessReport[]>;
  runOne: (id: string) => Promise<AgentReadinessReport>;
  onOpenUrl: (url: string) => void;
  onChange: (state: { readyCount: number; settled: boolean }) => void;
}

export function ReadinessPanel({ agents, runAll, runOne, onOpenUrl, onChange }: ReadinessPanelProps) {
  const connected = useMemo(() => agents.filter((a) => a.connected), [agents]);
  const lastEmitted = useRef<{ readyCount: number; settled: boolean } | null>(null);

  const cacheFresh = connected.every(
    (a) => a.readiness && Date.now() - new Date(a.readiness.checkedAt).getTime() < CACHE_TTL_MS,
  );

  const [reports, setReports] = useState<Record<string, AgentReadinessReport | null>>(() => {
    const init: Record<string, AgentReadinessReport | null> = {};
    for (const a of connected) init[a.id] = a.readiness ?? null;
    return init;
  });
  const [checking, setChecking] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const a of connected) init[a.id] = !cacheFresh;
    return init;
  });

  useEffect(() => {
    if (cacheFresh) return;
    let cancelled = false;
    runAll()
      .then((res) => {
        if (cancelled) return;
        const next: Record<string, AgentReadinessReport | null> = {};
        for (const r of res) next[r.agentId] = r;
        setReports((prev) => ({ ...prev, ...next }));
      })
      .finally(() => {
        if (!cancelled) {
          setChecking((prev) => {
            const next: Record<string, boolean> = {};
            for (const k of Object.keys(prev)) next[k] = false;
            return next;
          });
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settled = Object.values(checking).every((v) => !v);
  const readyCount = Object.values(reports).filter((r) => r?.status === "ready").length;

  useEffect(() => {
    const next = { readyCount, settled };
    const prev = lastEmitted.current;
    if (prev && prev.readyCount === next.readyCount && prev.settled === next.settled) return;
    lastEmitted.current = next;
    onChange(next);
  }, [readyCount, settled, onChange]);

  function handleRetry(id: string) {
    setChecking((prev) => ({ ...prev, [id]: true }));
    runOne(id)
      .then((report) => setReports((prev) => ({ ...prev, [id]: report })))
      .finally(() => setChecking((prev) => ({ ...prev, [id]: false })));
  }

  return (
    <div className="readiness-panel">
      {cacheFresh && <div className="readiness-last-checked">Last checked: just now</div>}
      {connected.map((agent) => (
        <ReadinessRow
          key={agent.id}
          agent={{ ...agent, readiness: reports[agent.id] ?? null }}
          state={checking[agent.id] ? "checking" : "settled"}
          onRetry={handleRetry}
          onOpenUrl={onOpenUrl}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd apps/desktop && pnpm test -- ReadinessPanel.test.tsx`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/onboarding/ReadinessPanel.tsx apps/desktop/src/onboarding/ReadinessPanel.test.tsx
git commit -m "feat(desktop): ReadinessPanel orchestrates per-agent checks"
```

---

## Task 18: Wire `ReadinessPanel` into `OnboardingView`

**Assigned model:** Sonnet 4.6  
**Effort:** High

**Files:**
- Modify: `apps/desktop/src/onboarding/OnboardingView.tsx`
- Modify: `apps/desktop/src/onboarding/OnboardingView.test.tsx`

- [ ] **Step 1: Update tests**

Open `apps/desktop/src/onboarding/OnboardingView.test.tsx`. The existing file uses `createRoot`, `act`, `container`, and helper functions instead of Testing Library globals. Keep that style unless you deliberately convert the whole file. Extend the existing `vi.mock("../api", ...)` to include `runReadinessCheck` and `runReadinessCheckForAgent`, then add cases like:

```tsx
it("step 2 mounts the readiness panel and disables Continue until ≥1 ready", async () => {
  vi.mocked(api.runReadinessCheck).mockResolvedValue([
    { agentId: "claude-code", status: "needs_auth", steps: [], repair: { kind: "run_command", command: "claude auth login", label: "Sign in" }, checkedAt: "2026-05-22T00:00:00.000Z" },
  ]);
  await render(vi.fn());
  clickByText("Get started");
  act(() => {
    (container.querySelector('button[data-agent-id="claude-code"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  clickByText("Continue");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(api.runReadinessCheck).toHaveBeenCalled();
  const cont = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Continue",
  ) as HTMLButtonElement;
  expect(cont.disabled).toBe(true);
});

it("when 0 ready and all settled, shows 'Continue anyway'", async () => {
  vi.mocked(api.runReadinessCheck).mockResolvedValue([
    { agentId: "claude-code", status: "missing", steps: [], checkedAt: "2026-05-22T00:00:00.000Z" },
  ]);
  const onComplete = vi.fn();
  await render(onComplete);
  clickByText("Get started");
  act(() => {
    (container.querySelector('button[data-agent-id="claude-code"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  clickByText("Continue");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  clickByText("Continue anyway");
  expect(onComplete).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `cd apps/desktop && pnpm test -- OnboardingView.test.tsx`
Expected: fails — new behavior not implemented.

- [ ] **Step 3: Update `OnboardingView`**

Replace the step-2 section in `apps/desktop/src/onboarding/OnboardingView.tsx`:

Add imports:

```ts
import { runReadinessCheck, runReadinessCheckForAgent } from "../api";
import { ReadinessPanel } from "./ReadinessPanel";
import { openExternal } from "../utils/openExternal"; // see Step 4 below
```

Replace the existing step-2 effect that does the fake 800 ms delay with state for `readyCount`/`settled` **and a connection-save gate**. Readiness must not run until `updateAgentConnection()` has persisted the selected rows, because the daemon endpoint checks only `connected = 1` agents.

```ts
const [readinessState, setReadinessState] = useState({ readyCount: 0, settled: false });
const [connectionsSaved, setConnectionsSaved] = useState(false);
```

Add this effect for step 2:

```ts
useEffect(() => {
  if (step !== 2) return;
  let cancelled = false;
  setConnectionsSaved(false);
  setReadinessState({ readyCount: 0, settled: false });
  (async () => {
    try {
      const updated = await Promise.all(
        agents.map((a) => updateAgentConnection(a.id, !!selected[a.id])),
      );
      if (cancelled) return;
      setAgents(updated);
      setConnectionsSaved(true);
    } catch (err) {
      if (cancelled) return;
      setLoadError(err instanceof Error ? err.message : "Failed to save selections");
      setStep(1);
    }
  })();
  return () => { cancelled = true; };
  // Run once when entering step 2. `agents` and `selected` are captured from the
  // user's step-1 choices; including `agents` would loop after `setAgents(updated)`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [step]);
```

And replace the step-2 footer content with:

```tsx
{step === 2 && (
  <>
    <button
      type="button"
      className="ob-btn ob-btn--quiet"
      onClick={() => setStep(1)}
    >
      <ChevronLeftIcon />
      Back
    </button>
    <div style={{ flex: 1 }} />
    {readinessState.settled && readinessState.readyCount === 0 && (
      <button
        type="button"
        className="ob-btn ob-btn--secondary"
        onClick={() => onComplete(agents.filter((a) => selected[a.id]).map((a) => a.id))}
      >
        Continue anyway
      </button>
    )}
    <button
      type="button"
      className="ob-btn ob-btn--primary"
      onClick={() => onComplete(agents.filter((a) => selected[a.id]).map((a) => a.id))}
      disabled={!readinessState.settled || readinessState.readyCount === 0}
    >
      Continue
      <ArrowRightIcon />
    </button>
  </>
)}
```

Replace the body of step 2 (the `<SetupPanel />` call) with:

```tsx
{step === 2 && connectionsSaved && (
  <ReadinessPanel
    agents={agents.filter((a) => selected[a.id] && a.connected)}
    runAll={runReadinessCheck}
    runOne={runReadinessCheckForAgent}
    onOpenUrl={openExternal}
    onChange={setReadinessState}
  />
)}
```

Before `connectionsSaved`, render a small saving state (`Saving agent selections…`) rather than the old fake setup delay. Delete the now-unused `SetupPanel` function, the 800 ms `setTimeout`, and the now-unused `.setup-*` CSS rules in `onboarding.css`. Keep `.onboarding-prose--narrow`; it is still used.

- [ ] **Step 4: Add `openExternal` helper**

Create `apps/desktop/src/utils/openExternal.ts`:

```ts
import { openUrl } from "@tauri-apps/plugin-opener";

export function openExternal(url: string): void {
  void openUrl(url);
}
```

If `@tauri-apps/plugin-opener` is not already in `apps/desktop/package.json`, add it: `cd apps/desktop && pnpm add @tauri-apps/plugin-opener@^2`. Also add the Rust side:

```toml
# apps/desktop/src-tauri/Cargo.toml
tauri-plugin-opener = "2"
```

And register the plugin in `apps/desktop/src-tauri/src/lib.rs`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
```

- [ ] **Step 5: Run and confirm pass**

Run: `cd apps/desktop && pnpm test`
Expected: all desktop tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/onboarding/OnboardingView.tsx apps/desktop/src/onboarding/OnboardingView.test.tsx apps/desktop/src/onboarding/onboarding.css apps/desktop/src/utils/openExternal.ts apps/desktop/package.json apps/desktop/pnpm-lock.yaml apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): replace onboarding fake delay with readiness check"
```

---

## Task 19: `NoReadyAgentsBanner` + mount in `App.tsx`

**Assigned model:** Sonnet 4.6  
**Effort:** Medium

**Files:**
- Create: `apps/desktop/src/chrome/NoReadyAgentsBanner.tsx`
- Create: `apps/desktop/src/chrome/NoReadyAgentsBanner.test.tsx`
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/chrome/NoReadyAgentsBanner.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NoReadyAgentsBanner } from "./NoReadyAgentsBanner";

describe("NoReadyAgentsBanner", () => {
  it("is hidden when at least one connected agent is ready", () => {
    render(
      <NoReadyAgentsBanner
        agents={[
          // @ts-expect-error partial test fixture
          { id: "claude-code", connected: true, readiness: { status: "ready" } },
        ]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is visible when zero connected agents are ready", () => {
    render(
      <NoReadyAgentsBanner
        agents={[
          // @ts-expect-error partial test fixture
          { id: "claude-code", connected: true, readiness: { status: "needs_auth" } },
        ]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/no agents are ready/i);
  });

  it("dismiss hides the banner this session", () => {
    const onDismiss = vi.fn();
    render(
      <NoReadyAgentsBanner
        agents={[
          // @ts-expect-error partial test fixture
          { id: "claude-code", connected: true, readiness: { status: "missing" } },
        ]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `cd apps/desktop && pnpm test -- NoReadyAgentsBanner.test.tsx`
Expected: fails.

- [ ] **Step 3: Create the component**

Create `apps/desktop/src/chrome/NoReadyAgentsBanner.tsx`:

```tsx
import { useState } from "react";
import type { Agent } from "@orca/contracts";

interface NoReadyAgentsBannerProps {
  agents: Agent[];
  onDismiss?: () => void;
}

export function NoReadyAgentsBanner({ agents, onDismiss }: NoReadyAgentsBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const connected = agents.filter((a) => a.connected);
  const anyReady = connected.some((a) => a.readiness?.status === "ready");
  if (anyReady || connected.length === 0 || dismissed) return null;

  return (
    <div role="status" className="banner banner--warn">
      <span>No agents are ready. Open Settings → Agents to fix.</span>
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
          onDismiss?.();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Mount in `App.tsx`**

Edit `apps/desktop/src/App.tsx`. Add `Agent` as a type to the existing `@orca/contracts` import and add the banner import:

```ts
import { NoReadyAgentsBanner } from "./chrome/NoReadyAgentsBanner";
import type { Agent } from "@orca/contracts";
```

Add an `agents` state next to existing state hooks:

```ts
const [agents, setAgents] = useState<Agent[]>([]);
```

Add a refresh helper and use it for both bootstrapping and post-onboarding refresh:

```ts
async function refreshAgents() {
  try {
    setAgents(await listAgents());
  } catch {
    // connection status banner communicates the problem
  }
}
```

In the existing bootstrap effect that decides `needs-onboarding` vs `complete`, call `setAgents(rows)` from the same `listAgents()` result. In `OnboardingView` completion, refresh before switching to complete:

```tsx
<OnboardingView
  onComplete={async () => {
    await refreshAgents();
    setOnboardingState("complete");
  }}
/>
```

There is no current `agent.connection_changed` domain event. Do not invent one in this milestone; the banner refreshes on app bootstrap, after onboarding completion, and on any existing periodic agent refresh added here.

Render the banner just below the existing `<Titlebar />`:

```tsx
{onboardingState === "complete" && <NoReadyAgentsBanner agents={agents} />}
```

- [ ] **Step 5: Run and confirm pass**

Run: `cd apps/desktop && pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/chrome/NoReadyAgentsBanner.tsx apps/desktop/src/chrome/NoReadyAgentsBanner.test.tsx apps/desktop/src/App.tsx
git commit -m "feat(desktop): NoReadyAgentsBanner for empty-ready state"
```

---

## Task 20: Gated real auth-status smoke tests

**Assigned model:** Codex 5.3  
**Effort:** Low

**Files:**
- Create: `apps/daemon/src/adapters/claude-code.auth-smoke.test.ts`
- Create: `apps/daemon/src/adapters/codex.auth-smoke.test.ts`
- Create: `apps/daemon/src/adapters/opencode.auth-smoke.test.ts`

- [ ] **Step 1: Write the gated test files**

Each follows the same shape. Example — `apps/daemon/src/adapters/claude-code.auth-smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { sanitizeOutput } from "../readiness/sanitize.js";

const runGated = process.env["ORCA_RUN_REAL_SMOKE"] === "1" ? describe : describe.skip;

runGated("claude-code auth status (real)", () => {
  it("classifies into ready | needs_auth | misconfigured within budget", async () => {
    const adapter = new ClaudeCodeAdapter();
    const start = Date.now();
    const step = await adapter.checkAuth();
    expect(Date.now() - start).toBeLessThan(6000);
    expect(["ready", "needs_auth", "misconfigured"]).toContain(step.authStatus);
    if (step.errorOutput) {
      expect(step.errorOutput).toBe(sanitizeOutput(step.errorOutput));
    }
  });
});
```

Create the analogous files for `codex.auth-smoke.test.ts` (calls `CodexAdapter`) and `opencode.auth-smoke.test.ts` (calls `OpenCodeAdapter`). Skip Gemini — its auth is heuristic and has no command surface.

- [ ] **Step 2: Verify the tests skip by default**

Run: `cd apps/daemon && pnpm test`
Expected: the auth-smoke describe blocks appear as skipped; no failures.

- [ ] **Step 3: Optional — run them locally**

Run: `cd apps/daemon && ORCA_RUN_REAL_SMOKE=1 pnpm test -- auth-smoke`
Expected: passes when the relevant CLI is installed; otherwise reports `misconfigured` (which is still a passing classification per the test).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/adapters/*.auth-smoke.test.ts
git commit -m "test(daemon): gated real auth-status smoke tests"
```

---

## Wrap-up

Run the full test suite to confirm nothing regressed:

```bash
pnpm -r typecheck && pnpm -r test
```

Manually walk through onboarding end-to-end (use `pnpm dev` from `apps/desktop`):

1. Fresh install (delete the local data dir).
2. Welcome → Connect agents → select all 4.
3. Confirm step 2 shows real per-agent rows.
4. Force a failure (rename your `claude` binary, sign out of codex, unset Gemini env, etc.) and confirm the row surfaces the right repair command and the "Continue anyway" UX appears when nothing is ready.
5. Click Retry — confirm only that row reruns.
6. Continue → confirm `NoReadyAgentsBanner` appears in the main app when 0 ready.
