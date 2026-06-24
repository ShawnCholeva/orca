# Inspectable Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `HarnessTransition` carry a strict `TelemetryFacet` (cost, latency, model, outcome, interventions, rejected alternatives), capture worker-agent token+cost via an OTEL push channel, make outcomes categorical, and expose a `/harness-metrics` projection + control-plane replay + failure attribution over the transition log.

**Architecture:** Tighten the last opaque facet (`telemetry`) on the existing `HarnessTransition` spine. Worker tokens flow Claude/Codex CLI → OTEL (HTTP/JSON) → a minimal OTLP receiver embedded in the daemon's Fastify server → a per-session cost accumulator → `TelemetryFacet.cost` attached at the step-complete transition. Metrics/replay/attribution are read-only folds over `harness_transitions` (+ existing provenance tables), each graceful-degrading when a source facet (e.g. `StateDepsFacet`, not built) is absent.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), `better-sqlite3` (WAL), zod (`@orca/contracts`), Fastify, vitest. OTLP over **HTTP/JSON** (no protobuf dependency).

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-06-24-inspectable-axis-design.md`. Recon shapes: `.superpowers/sdd/inspectable-recon-notes.md`.
- Contracts idiom: `export const X = z.<schema>; export type X = z.infer<typeof X>;`, objects `.strict()`, timestamps `z.string().datetime()`, ids bounded non-empty. `TelemetryFacet` mirrors `EvidenceFacet`'s style (`harness/index.ts:34-48`).
- **Contract-tightening lesson (Phases 2–3):** when a task tightens `HarnessTransition.telemetry` in contracts, the SAME task MUST update `RecordTransitionInput.telemetry` in `apps/daemon/src/harness-transitions/usecases.ts`, run `pnpm --filter @orca/daemon typecheck`, and `pnpm --filter @orca/contracts build` so the daemon dist sees it.
- **Fail-closed default everywhere** (unknown session/goal → safe/empty; absent usage → `cost=null`, never `0`). Graceful-degrade: a metric with no source facet returns `null` + a `reason`, never `0`.
- Daemon subsystem idiom: prepared-statement caching keyed on DB identity + exported `resetPreparedStatements()`; route registrars (`registerXRoutes(server, {db})`); stage events in `db.transaction(...)()` then publish after commit.
- Migrations: append the bare filename to `migrationFiles` in `apps/daemon/src/migrations.ts`; create `apps/daemon/migrations/NNNN_<name>.sql` with a leading comment. **Next free number is `0043`.** Snapshot tests enumerating filenames: `apps/daemon/src/migrations.test.ts` (THREE occurrences ~L170/302/589), `apps/daemon/test/migrations-0006.test.ts` (~L182). `src/migrations/suggested-orchestration.test.ts` asserts tables/columns (toContain), not filenames — extend only if a new table is added.
- Test: `pnpm --filter @orca/daemon test` / `pnpm --filter @orca/contracts test` (vitest); real on-disk SQLite (`openDatabase(createConfig(mkdtempSync(...)))` + `runMigrations`), `SpyBus`, injected `now`/`idFactory`, reset every touched subsystem's prepared statements in `afterEach`.
- Known pre-existing flakes (NOT regressions): `http-surface.test.ts`, `human-review.test.ts` (now carry a 15s per-test timeout; still re-run in isolation if load-flaky).
- Branch: create `feat/inspectable-axis` off `main`.

## Design decisions (locked)

- **D1** — Full P1–P3 in this plan.
- **D2** — Graceful-degrade: absent-source metrics report `{ value: null, reason }`.
- **D3** — Worker tokens via OTEL **HTTP/JSON**, ingested by a daemon-embedded OTLP receiver. Claude via env; Codex via `[otel]` in `config.toml`; antigravity → `cost=null`.
- **D4** — Static `model → {usd_per_1k_in, usd_per_1k_out}` price map in code. `TelemetryFacet.cost` nullable.
- **D5** — Replay = read-only control-plane trajectory reconstruction (NOT full event-sourcing).
- **D6** — Auth: the OTLP exporter sends the daemon Bearer token via `OTEL_EXPORTER_OTLP_HEADERS`; the receiver route stays behind the existing auth hook (no exemption hole). Receiver bound to loopback.

---

# Phase P1 — TelemetryFacet + cost + worker-token OTEL + failure codes

### Task 1: `TelemetryFacet` contract + `RecordTransitionInput.telemetry` alignment

**Files:**
- Modify: `packages/contracts/src/harness/index.ts`
- Modify: `apps/daemon/src/harness-transitions/usecases.ts`
- Test: `packages/contracts/src/harness/index.test.ts` (extend)

**Interfaces:**
- Produces: `TransitionOutcome` (`z.enum`), `FailureCode` (`z.enum`), `CostEntry`, `TelemetryFacet`. Tightens `HarnessTransition.telemetry` from `z.record(z.unknown()).nullable()` to `TelemetryFacet.nullable()`.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/harness/index.test.ts`:

```ts
import { TelemetryFacet, FailureCode } from "./index.js";

describe("TelemetryFacet", () => {
  it("accepts a cost+outcome facet", () => {
    const t = TelemetryFacet.parse({
      cost: { tokens_in: 1200, tokens_out: 340, usd: 0.0123 },
      latency_ms: 880, model: "claude-opus-4-8", provider_id: "anthropic", provider_version: null,
      prompt_ref: null, raw_output_ref: null,
      rejected_alternatives: [{ option: "codex", reason: "lower fit score" }],
      human_interventions: [{ kind: "approval", ref: "appr-1" }],
      outcome: { status: "succeeded", failure_code: null },
    });
    expect(t.cost?.usd).toBeCloseTo(0.0123);
    expect(t.outcome.status).toBe("succeeded");
  });
  it("allows null cost (no usage source)", () => {
    const t = TelemetryFacet.parse({
      cost: null, latency_ms: null, model: null, provider_id: null, provider_version: null,
      prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
      outcome: { status: "failed", failure_code: "timeout" },
    });
    expect(t.cost).toBeNull();
  });
  it("rejects an unknown failure_code", () => {
    expect(FailureCode.safeParse("kaboom").success).toBe(false);
  });
  it("is accepted as the telemetry facet on a transition", () => {
    const tr = HarnessTransition.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: null, boundary: "step_complete",
      risk: null, evidence: null, stateDeps: null,
      telemetry: { cost: null, latency_ms: 5, model: null, provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
        outcome: { status: "succeeded", failure_code: null } },
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    expect(tr.telemetry?.outcome.status).toBe("succeeded");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/contracts test`
Expected: FAIL — `TelemetryFacet`/`FailureCode` not exported.

- [ ] **Step 3: Add the schemas + tighten the facet**

In `packages/contracts/src/harness/index.ts`, add ABOVE the `HarnessTransition` declaration:

```ts
export const TransitionStatus = z.enum(["succeeded", "failed", "escalated", "denied"]);
export type TransitionStatus = z.infer<typeof TransitionStatus>;

// Categorical, clusterable failure codes (mirrors the extraction enum, migrations/0005).
export const FailureCode = z.enum([
  "invalid_output", "timeout", "session_not_terminal", "output_unavailable",
  "source_truncated", "goal_archived", "session_archived", "daemon_restart",
  "guardrail_denied", "evidence_veto", "provider_error", "internal_error",
]);
export type FailureCode = z.infer<typeof FailureCode>;

export const CostEntry = z
  .object({
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  })
  .strict();
export type CostEntry = z.infer<typeof CostEntry>;

export const TelemetryFacet = z
  .object({
    cost: CostEntry.nullable(),
    latency_ms: z.number().int().nonnegative().nullable(),
    model: z.string().max(128).nullable(),
    provider_id: z.string().max(64).nullable(),
    provider_version: z.string().max(128).nullable(),
    prompt_ref: z.string().max(512).nullable(),
    raw_output_ref: z.string().max(512).nullable(),
    rejected_alternatives: z
      .array(z.object({ option: z.string().max(256), reason: z.string().max(512) }).strict())
      .max(64)
      .default([]),
    human_interventions: z
      .array(z.object({ kind: z.string().max(64), ref: z.string().max(128) }).strict())
      .max(64)
      .default([]),
    outcome: z
      .object({ status: TransitionStatus, failure_code: FailureCode.nullable() })
      .strict(),
  })
  .strict();
export type TelemetryFacet = z.infer<typeof TelemetryFacet>;
```

Change the `telemetry` line inside `HarnessTransition` from `telemetry: z.record(z.unknown()).nullable(),` to `telemetry: TelemetryFacet.nullable(),`. Update the comment above `HarnessTransition` so it no longer lists `telemetry` as opaque (only `stateDeps` remains opaque).

- [ ] **Step 4: Align the daemon input type (the contract-tightening lesson)**

In `apps/daemon/src/harness-transitions/usecases.ts`: add `TelemetryFacet` to the `import type { ... } from "@orca/contracts";` line, and change `RecordTransitionInput`'s `telemetry?: Record<string, unknown> | null;` to `telemetry?: TelemetryFacet | null;` (leave `stateDeps` as `Record<string, unknown> | null`).

- [ ] **Step 5: Build contracts, run both typechecks + tests**

Run, in order:
- `pnpm --filter @orca/contracts test` → GREEN
- `pnpm --filter @orca/contracts build`
- `pnpm --filter @orca/daemon typecheck` → CLEAN

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/harness/index.ts packages/contracts/src/harness/index.test.ts apps/daemon/src/harness-transitions/usecases.ts
git commit -m "feat(contracts): TelemetryFacet + failure-code enum; align RecordTransitionInput.telemetry"
```

---

### Task 2: Static model price map + USD computation

**Files:**
- Create: `apps/daemon/src/harness-telemetry/cost.ts`
- Test: `apps/daemon/src/harness-telemetry/cost.test.ts`

**Interfaces:**
- Consumes: `CostEntry` from `@orca/contracts`.
- Produces: `computeCost(model: string, tokensIn: number, tokensOut: number): CostEntry` (usd from the price map; unknown model → usd 0 with tokens preserved, plus an exported `isPricedModel(model): boolean`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-telemetry/cost.test.ts
import { describe, expect, it } from "vitest";
import { computeCost, isPricedModel } from "./cost.js";

describe("computeCost", () => {
  it("prices a known model from the static map", () => {
    const c = computeCost("claude-opus-4-8", 1_000_000, 1_000_000);
    expect(c.tokens_in).toBe(1_000_000);
    expect(c.tokens_out).toBe(1_000_000);
    expect(c.usd).toBeGreaterThan(0);
  });
  it("preserves tokens but yields usd 0 for an unknown model", () => {
    const c = computeCost("totally-unknown-model", 500, 500);
    expect(c.usd).toBe(0);
    expect(c.tokens_in).toBe(500);
    expect(isPricedModel("totally-unknown-model")).toBe(false);
  });
  it("is linear in tokens", () => {
    const a = computeCost("claude-opus-4-8", 100, 0);
    const b = computeCost("claude-opus-4-8", 200, 0);
    expect(b.usd).toBeCloseTo(a.usd * 2, 9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-telemetry/cost`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the price map + computation**

```ts
// apps/daemon/src/harness-telemetry/cost.ts
import type { CostEntry } from "@orca/contracts";

// Static USD-per-1K-token price map (updated by edit; see spec D4). Prefix match on model id.
// Values are illustrative current list prices; adjust as pricing changes.
const PRICE_PER_1K: Array<{ prefix: string; in: number; out: number }> = [
  { prefix: "claude-opus", in: 0.015, out: 0.075 },
  { prefix: "claude-sonnet", in: 0.003, out: 0.015 },
  { prefix: "claude-haiku", in: 0.0008, out: 0.004 },
  { prefix: "gpt-5", in: 0.00125, out: 0.01 },
  { prefix: "o3", in: 0.002, out: 0.008 },
  { prefix: "gpt-4o", in: 0.0025, out: 0.01 },
];

function priceFor(model: string): { in: number; out: number } | undefined {
  return PRICE_PER_1K.find((p) => model.startsWith(p.prefix));
}

export function isPricedModel(model: string): boolean {
  return priceFor(model) !== undefined;
}

export function computeCost(model: string, tokensIn: number, tokensOut: number): CostEntry {
  const p = priceFor(model);
  const usd = p ? (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out : 0;
  return { tokens_in: tokensIn, tokens_out: tokensOut, usd };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-telemetry/cost`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-telemetry/cost.ts apps/daemon/src/harness-telemetry/cost.test.ts
git commit -m "feat(daemon): static model price map + usd cost computation"
```

---

### Task 3: OTEL ingest SPIKE (recon-first — prove emission + capture the wire shape)

> **RECON-FIRST.** Whether the Claude Code / Codex CLIs actually emit OTLP to a local receiver, and the exact HTTP/JSON envelope they send, is NOT verifiable from the Orca source. This task is a time-boxed spike that establishes the ground truth Tasks 4–6 depend on. It writes a findings doc, not production code. If emission cannot be made to work, STOP and report NEEDS_CONTEXT (the plan's later cost tasks then degrade to `cost=null`, like antigravity).

**Files:**
- Create: `.superpowers/sdd/otel-spike-findings.md` (notes, not shipped code)

- [ ] **Step 1: Stand up a throwaway OTLP/JSON sink**

Write a ~30-line standalone Node script (in a scratch dir, NOT the repo `src`) that listens on `127.0.0.1:4318` and logs the body + `content-type` of any `POST /v1/metrics` and `POST /v1/logs`. (OTLP/HTTP default paths: `/v1/metrics`, `/v1/logs`, `/v1/traces`.)

- [ ] **Step 2: Drive a real Claude Code worker with telemetry env**

Launch a one-shot Claude Code run with:
`CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_METRICS_INCLUDE_SESSION_ID=true OTEL_METRIC_EXPORT_INTERVAL=5000 claude -p "say hi"`
Capture: does the sink receive `claude_code.token.usage` / `claude_code.cost.usage`? Record the EXACT JSON path to the token value, the unit/attribute carrying token type (input/output), and where `session.id` appears (resource vs datapoint attribute). Quote a real captured datapoint.

- [ ] **Step 3: Drive a real Codex worker with `[otel]`**

Create a temp `CODEX_HOME` with `config.toml` containing:
```toml
[otel]
exporter = "otlp-http"
log_user_prompt = false
```
plus `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` as the docs require, run `codex exec "say hi"` (and, if interactive is how Orca spawns, note any difference). Capture whether `codex.sse_event` log records arrive with token counts on `response.completed`; quote the JSON path to input/output/total tokens and the `session_id` attribute.

- [ ] **Step 4: Write findings**

Record in `.superpowers/sdd/otel-spike-findings.md`: for EACH provider — (a) does it emit to a local HTTP/JSON OTLP endpoint? (b) the exact JSON pointer to tokens_in / tokens_out; (c) the exact location of the session id; (d) signal type (metric vs log) and default path; (e) any auth/header behavior. Conclude GO / PARTIAL(provider list) / NO-GO. If NO-GO for a provider, that provider's cost will be `null` (graceful-degrade) and Task 6 skips its wiring.

- [ ] **Step 5: Gate**

If at least Claude Code is GO, proceed to Task 4. If NEITHER emits, STOP and report NEEDS_CONTEXT — do not build a receiver against an unverified shape. No commit (findings file is scratch).

---

### Task 4: OTLP/JSON receiver — parse worker token/cost keyed by session id

**Files:**
- Create: `apps/daemon/src/harness-telemetry/otlp-receiver.ts`
- Test: `apps/daemon/src/harness-telemetry/otlp-receiver.test.ts`

**Interfaces:**
- Consumes: the JSON shapes captured in Task 3 (`.superpowers/sdd/otel-spike-findings.md`).
- Produces: `parseOtlpTokens(body: unknown): Array<{ sessionId: string; tokensIn: number; tokensOut: number; model?: string }>` — a pure parser that extracts per-session token deltas from an OTLP/JSON metrics-or-logs envelope, ignoring everything else. Fail-safe: malformed/irrelevant → `[]`.

- [ ] **Step 1: Write the failing test**

Use the REAL captured envelope from Task 3 as the fixture (paste the actual JSON the spike captured). Illustrative structure (REPLACE with the captured shape):

```ts
// apps/daemon/src/harness-telemetry/otlp-receiver.test.ts
import { describe, expect, it } from "vitest";
import { parseOtlpTokens } from "./otlp-receiver.js";

// FIXTURE: replace with the actual envelope captured in Task 3's findings.
const claudeMetrics = { /* resourceMetrics: [...] captured verbatim */ };

describe("parseOtlpTokens", () => {
  it("extracts per-session input/output tokens from a Claude OTLP metrics envelope", () => {
    const rows = parseOtlpTokens(claudeMetrics);
    const r = rows.find((x) => x.sessionId === "<session-id-from-fixture>");
    expect(r?.tokensIn).toBeGreaterThan(0);
  });
  it("returns [] on malformed input (fail-safe)", () => {
    expect(parseOtlpTokens({ nope: true })).toEqual([]);
    expect(parseOtlpTokens(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-telemetry/otlp-receiver`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser** against the captured shape

Implement `parseOtlpTokens` to walk the captured OTLP/JSON structure (resourceMetrics→scopeMetrics→metrics datapoints for Claude `claude_code.token.usage`, summing by `session.id` + token-type attribute; and/or resourceLogs→logRecords for Codex `codex.sse_event`). Wrap all access in try/catch-style optional chaining; any shape mismatch yields `[]`. Keep it a PURE function (no DB, no I/O) so it's unit-testable against fixtures. (Exact field pointers come from Task 3 — do not guess.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-telemetry/otlp-receiver`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-telemetry/otlp-receiver.ts apps/daemon/src/harness-telemetry/otlp-receiver.test.ts
git commit -m "feat(daemon): OTLP/JSON token parser (pure, fail-safe) for worker usage"
```

---

### Task 5: Per-session cost accumulator + receiver route

**Files:**
- Create: `apps/daemon/src/harness-telemetry/accumulator.ts`
- Test: `apps/daemon/src/harness-telemetry/accumulator.test.ts`
- Modify: `apps/daemon/src/server.ts` (mount the OTLP route + register the accumulator)

**Interfaces:**
- Consumes: `parseOtlpTokens` (Task 4), `computeCost` (Task 2).
- Produces: `SessionCostAccumulator` with `ingest(rows)` and `drain(sessionId): { tokensIn, tokensOut, model } | null` (returns and clears the accrued total for a session). Plus the route `POST /v1/otlp/v1/metrics` + `/v1/otlp/v1/logs` that feeds `ingest`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-telemetry/accumulator.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { SessionCostAccumulator } from "./accumulator.js";

let acc: SessionCostAccumulator;
beforeEach(() => { acc = new SessionCostAccumulator(); });

describe("SessionCostAccumulator", () => {
  it("sums token rows per session and drains them", () => {
    acc.ingest([{ sessionId: "s1", tokensIn: 100, tokensOut: 20, model: "claude-opus-4-8" }]);
    acc.ingest([{ sessionId: "s1", tokensIn: 50, tokensOut: 10 }]);
    acc.ingest([{ sessionId: "s2", tokensIn: 5, tokensOut: 5, model: "gpt-5" }]);
    const d1 = acc.drain("s1");
    expect(d1).toEqual({ tokensIn: 150, tokensOut: 30, model: "claude-opus-4-8" });
    expect(acc.drain("s1")).toBeNull(); // cleared
    expect(acc.drain("s2")?.tokensIn).toBe(5);
  });
  it("returns null draining an unknown session", () => {
    expect(acc.drain("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-telemetry/accumulator`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the accumulator**

```ts
// apps/daemon/src/harness-telemetry/accumulator.ts
type Row = { sessionId: string; tokensIn: number; tokensOut: number; model?: string };
type Acc = { tokensIn: number; tokensOut: number; model?: string };

// In-memory per-session token accumulator. OTEL metrics are delta-temporality
// streams; we sum deltas until a transition boundary drains the session total.
export class SessionCostAccumulator {
  private readonly bySession = new Map<string, Acc>();
  ingest(rows: Row[]): void {
    for (const r of rows) {
      const cur = this.bySession.get(r.sessionId) ?? { tokensIn: 0, tokensOut: 0 };
      cur.tokensIn += r.tokensIn;
      cur.tokensOut += r.tokensOut;
      if (r.model && !cur.model) cur.model = r.model;
      this.bySession.set(r.sessionId, cur);
    }
  }
  drain(sessionId: string): Acc | null {
    const cur = this.bySession.get(sessionId);
    if (!cur) return null;
    this.bySession.delete(sessionId);
    return cur;
  }
  peek(sessionId: string): Acc | null { return this.bySession.get(sessionId) ?? null; }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-telemetry/accumulator`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the OTLP route + share one accumulator**

In `apps/daemon/src/server.ts`: construct a single `const otlpAccumulator = new SessionCostAccumulator();` in the server-builder closure (near `daemonContext`). Add a route registrar (idiom from `registerHarnessTransitionRoutes`) or inline routes:

```ts
  // OTLP/JSON ingest (loopback worker telemetry). Auth via the global Bearer hook
  // (the OTEL exporter sends OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>).
  for (const path of ["/v1/otlp/v1/metrics", "/v1/otlp/v1/logs"]) {
    server.post(path, async (request, reply) => {
      try { otlpAccumulator.ingest(parseOtlpTokens(request.body)); } catch (e) { console.error("otlp ingest", e); }
      reply.status(200);
      return {};
    });
  }
```

Export `otlpAccumulator` from the closure so Task 7 (transition attach) can `drain(sessionId)`. Add imports for `SessionCostAccumulator` and `parseOtlpTokens`.

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter @orca/daemon test -- harness-telemetry && pnpm --filter @orca/daemon typecheck`

```bash
git add apps/daemon/src/harness-telemetry/accumulator.ts apps/daemon/src/harness-telemetry/accumulator.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): per-session cost accumulator + OTLP ingest route"
```

---

### Task 6: Wire worker spawns to emit OTEL to the receiver

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/providers/claude.ts` (worker hook config `env`)
- Modify: `apps/daemon/src/orchestrator-llm/providers/codex.ts` (`config.toml` `[otel]`)
- Test: `apps/daemon/src/orchestrator-llm/providers/telemetry-env.test.ts`

**Interfaces:**
- Consumes: the daemon's loopback OTLP base URL + auth token (thread via `workerHookConfig` args or env).
- Produces: Claude workers spawn with `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*` env (merged at `worker-session.ts:120`); Codex workers get `[otel] exporter="otlp-http"` in `config.toml`. Antigravity unchanged (no usage source).

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/orchestrator-llm/providers/telemetry-env.test.ts
import { describe, expect, it } from "vitest";
import { ClaudeShadowProvider } from "./claude.js";
import { CodexShadowProvider } from "./codex.js";

const args = { goalId: "g", sessionId: "s", resolverCommand: ["node", "r.js"], configDir: "/tmp/cfg",
  otlpBaseUrl: "http://127.0.0.1:8787/v1/otlp", authToken: "tok" };

describe("worker OTEL telemetry wiring", () => {
  it("Claude worker env enables telemetry pointed at the daemon receiver", () => {
    const cfg = ClaudeShadowProvider.prototype.workerHookConfig.call(new ClaudeShadowProvider(), args);
    expect(cfg.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(cfg.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toContain("/v1/otlp");
    expect(cfg.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    expect(cfg.env?.OTEL_EXPORTER_OTLP_HEADERS).toContain("tok");
  });
  it("Codex config.toml includes an [otel] otlp-http block", () => {
    const cfg = CodexShadowProvider.prototype.workerHookConfig.call(new CodexShadowProvider(), args);
    const toml = cfg.files.find((f) => f.relPath === "config.toml")?.contents ?? "";
    expect(toml).toContain("[otel]");
    expect(toml).toContain("otlp-http");
  });
});
```

> Confirm the real `workerHookConfig` arg object — extend its type to carry `otlpBaseUrl` + `authToken` (threaded from `worker-session.ts` where it's called; the daemon knows its own port + token). Adjust the test to the real construction (the providers may be instantiated differently — mirror existing provider tests).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- telemetry-env`
Expected: FAIL — env/toml not set.

- [ ] **Step 3: Thread the OTLP URL + token and set env/config**

- Extend the `workerHookConfig` args type with `otlpBaseUrl: string; authToken: string;` and pass them from `worker-session.ts` (the daemon supplies its loopback base `http://127.0.0.1:${port}/v1/otlp` + `config.getAuthToken()`).
- Claude (`providers/claude.ts` `workerHookConfig`): add to the returned `env`:
  `CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_ENDPOINT: args.otlpBaseUrl, OTEL_EXPORTER_OTLP_HEADERS: \`Authorization=Bearer ${args.authToken}\`, OTEL_METRICS_INCLUDE_SESSION_ID: "true", OTEL_METRIC_EXPORT_INTERVAL: "5000"`.
- Codex (`providers/codex.ts` `workerHookConfig`): append to the `config.toml` `contents` string:
  `\n[otel]\nexporter = "otlp-http"\nlog_user_prompt = false\n` and add `OTEL_EXPORTER_OTLP_ENDPOINT` + headers to its `env` (per Task 3 findings on how Codex reads the endpoint).
- Use the EXACT env/attribute names Task 3 verified actually drive emission; if the spike found a different knob, use that.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- telemetry-env && pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/claude.ts apps/daemon/src/orchestrator-llm/providers/codex.ts apps/daemon/src/orchestrator-llm/providers/telemetry-env.test.ts apps/daemon/src/workflows/orchestrator/worker-session.ts
git commit -m "feat(daemon): wire Claude/Codex worker spawns to emit OTEL to the daemon receiver"
```

---

### Task 7: Attach `TelemetryFacet` at the step-complete transition

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (the two `step_complete` `recordHarnessTransition` sites: ~1599, ~2293)
- Test: extend `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

**Interfaces:**
- Consumes: `otlpAccumulator.drain(sessionId)` (Task 5), `computeCost` (Task 2), `TelemetryFacet` (Task 1).
- Produces: each `step_complete` transition records a `TelemetryFacet` with `cost` (from the drained worker tokens for that step's session, or `null`), `latency_ms` (step duration if available), `model`, and `outcome { status, failure_code }`.

- [ ] **Step 1: Write the failing test**

Add to `service.agent-step.test.ts` a case that pre-seeds the accumulator for the step's session (or injects a stub accumulator) and asserts the recorded `step_complete` transition's `telemetry.cost.tokens_in` matches, and `telemetry.outcome.status === "succeeded"`. (Mirror existing transition-assertion tests; use `listTransitionsByGoal(db, "goal-1").find(t => t.boundary === "step_complete")`.)

```ts
it("attaches a TelemetryFacet with worker cost to the step_complete transition", async () => {
  const { db, bus, idFactory } = setupHarness();
  setupAgentStepRun(db, { guardrailsJson: "[]" });
  seedWorkspace(db); seedAgentSession(db);
  // inject accrued worker tokens for the agent session id used by setupAgentStepRun:
  testAccumulator.ingest([{ sessionId: "sess-judge", tokensIn: 1000, tokensOut: 200, model: "claude-opus-4-8" }]);
  const service = makeJudgeService(fakeMediator({ kind: "approve_step_complete" }), vi.fn(async () => "delivered" as const), { accumulator: testAccumulator });
  const responseText = "Done.\n```orca:step-complete\n" + JSON.stringify({ result: "implemented" }) + "\n```";
  await service.onAgentResponseDone(db, () => NOW, { sessionId: "sess-judge", adapterId: "claude-code", responseText }, { bus, idFactory });
  const t = listTransitionsByGoal(db, "goal-1").find((x) => x.boundary === "step_complete");
  expect(t?.telemetry?.cost?.tokens_in).toBe(1000);
  expect(t?.telemetry?.outcome.status).toBe("succeeded");
});
```

> The service must accept the accumulator via its existing deps/ctx (thread it as an optional dependency, defaulting to a no-op accumulator whose `drain` returns null, so existing tests/transitions get `cost: null`). Determine the real dependency-injection seam in `service.ts` (how `makeJudgeService` builds deps) and thread `accumulator` there.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- service.agent-step`
Expected: FAIL — telemetry is null/undefined today.

- [ ] **Step 3: Build the facet at the two sites**

Add a helper in `service.ts`:

```ts
function buildTelemetry(
  acc: { drain(sessionId: string): { tokensIn: number; tokensOut: number; model?: string } | null } | undefined,
  sessionId: string | undefined,
  status: TransitionStatus,
  failureCode: FailureCode | null,
  latencyMs: number | null
): TelemetryFacet {
  const drained = acc && sessionId ? acc.drain(sessionId) : null;
  const cost = drained && drained.model
    ? computeCost(drained.model, drained.tokensIn, drained.tokensOut)
    : null;
  return {
    cost, latency_ms: latencyMs, model: drained?.model ?? null,
    provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null,
    rejected_alternatives: [], human_interventions: [],
    outcome: { status, failure_code: failureCode },
  };
}
```

At both `step_complete` `recordHarnessTransition` calls, pass `telemetry: buildTelemetry(ctx.accumulator, <the step's session id>, <"succeeded"|"failed">, <failureCode or null>, <duration or null>)`. Map the step's session id via the run/step → `sessions.workflow_step_run_id` (or the session id already in scope at the judge path). For the evidence-veto site (~1599), set `status` from the evidence verdict (`failed`/`escalated` on veto, else `succeeded`) and `failure_code: "evidence_veto"` on veto.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- service.agent-step && pnpm --filter @orca/daemon typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): attach TelemetryFacet (cost+outcome) at step_complete transitions"
```

**End of P1.** Worker token/cost flows CLI→OTEL→receiver→accumulator→`TelemetryFacet`; outcomes are categorical.

---

# Phase P2 — `/harness-metrics` projection + unified provenance

### Task 8: `harness-metrics` fold usecase (six metrics, graceful-degrade)

**Files:**
- Create: `apps/daemon/src/harness-metrics/usecases.ts`
- Test: `apps/daemon/src/harness-metrics/usecases.test.ts`

**Interfaces:**
- Consumes: `listTransitionsByGoal` (`harness-transitions/usecases.js`).
- Produces: `computeHarnessMetrics(db, goalId): HarnessMetrics` where each of the six metrics is `{ value: number | null, reason?: string }`. Absent source facet → `{ value: null, reason }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/daemon/src/harness-metrics/usecases.test.ts
// (standard openTestDb harness; seed a goal + a few harness_transitions with/without facets)
import { describe, expect, it /* + db harness imports */ } from "vitest";
import { computeHarnessMetrics } from "./usecases.js";

describe("computeHarnessMetrics", () => {
  it("computes available metrics and nulls absent-facet metrics with a reason", () => {
    // seed: 3 transitions — one tool_gate w/ risk, one step_complete w/ evidence+telemetry, one bare
    const m = computeHarnessMetrics(db, "g");
    expect(m.trajectory_efficiency.value).not.toBeNull();
    expect(m.safety_compliance.value).not.toBeNull();      // RiskFacet present
    expect(m.verification_strength.value).not.toBeNull();  // EvidenceFacet present
    expect(m.state_consistency.value).toBeNull();          // StateDepsFacet absent
    expect(m.state_consistency.reason).toContain("StateDeps");
    expect(m.replayability.value).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/daemon test -- harness-metrics/usecases`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fold**

```ts
// apps/daemon/src/harness-metrics/usecases.ts
import type Database from "better-sqlite3";
import { listTransitionsByGoal } from "../harness-transitions/usecases.js";

export type Metric = { value: number | null; reason?: string };
export type HarnessMetrics = {
  trajectory_efficiency: Metric; verification_strength: Metric; recovery: Metric;
  state_consistency: Metric; safety_compliance: Metric; replayability: Metric;
};

export function computeHarnessMetrics(db: Database.Database, goalId: string): HarnessMetrics {
  const ts = listTransitionsByGoal(db, goalId, 10_000);
  const n = ts.length;
  const withRisk = ts.filter((t) => t.risk !== null);
  const withEvidence = ts.filter((t) => t.evidence !== null);
  const withStateDeps = ts.filter((t) => t.stateDeps !== null);
  const tokens = ts.reduce((s, t) => s + (t.telemetry?.cost?.tokens_in ?? 0) + (t.telemetry?.cost?.tokens_out ?? 0), 0);

  // Trajectory efficiency: transitions per ... here, a simple count + tokens summary.
  const trajectory_efficiency: Metric = n === 0 ? { value: null, reason: "no transitions" } : { value: tokens / n };

  // Verification strength: fraction of step_complete transitions carrying a passing evidence verdict.
  const stepCompletes = ts.filter((t) => t.boundary === "step_complete");
  const verification_strength: Metric = stepCompletes.length === 0
    ? { value: null, reason: "no step_complete transitions" }
    : { value: withEvidence.filter((t) => t.evidence?.verdict === "passed").length / stepCompletes.length };

  // Recovery: fraction of failed/escalated outcomes that were later followed by a succeeded transition.
  const failures = ts.filter((t) => t.telemetry?.outcome.status === "failed" || t.telemetry?.outcome.status === "escalated");
  const recovery: Metric = failures.length === 0
    ? { value: null, reason: "no failures recorded" }
    : { value: ts.some((t) => t.telemetry?.outcome.status === "succeeded") ? 1 : 0 };

  // State consistency: requires StateDepsFacet (Stateful/Phase 5) — absent today.
  const state_consistency: Metric = withStateDeps.length === 0
    ? { value: null, reason: "StateDepsFacet not yet emitted (Stateful axis pending)" }
    : { value: withStateDeps.filter((t) => (t.stateDeps as { conflict?: boolean }).conflict !== true).length / withStateDeps.length };

  // Safety compliance: fraction of gated actions honored (allow/require_approval) vs denied.
  const safety_compliance: Metric = withRisk.length === 0
    ? { value: null, reason: "no RiskFacet transitions" }
    : { value: withRisk.filter((t) => t.risk?.gate_decision !== "deny").length / withRisk.length };

  // Replayability: fraction of transitions whose facet set is "complete enough" (has telemetry).
  const replayability: Metric = n === 0
    ? { value: null, reason: "no transitions" }
    : { value: ts.filter((t) => t.telemetry !== null).length / n };

  return { trajectory_efficiency, verification_strength, recovery, state_consistency, safety_compliance, replayability };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/daemon test -- harness-metrics/usecases`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/harness-metrics/usecases.ts apps/daemon/src/harness-metrics/usecases.test.ts
git commit -m "feat(daemon): harness-metrics fold (six paper metrics, graceful-degrade)"
```

---

### Task 9: `GET /v1/goals/:goalId/harness-metrics` route

**Files:**
- Create: `apps/daemon/src/harness-metrics/routes.ts`
- Modify: `apps/daemon/src/server.ts` (register)
- Test: `apps/daemon/src/harness-metrics/routes.test.ts`

**Interfaces:**
- Consumes: `computeHarnessMetrics` (Task 8).
- Produces: `registerHarnessMetricsRoutes(server, { db })` mounting the GET route (404 on unknown goal, mirroring `harness-transitions/routes.ts`).

- [ ] **Step 1: Write the failing test** (mirror `harness-transitions/routes.test.ts` if present; assert 200 + metrics body for a seeded goal, 404 for unknown). 
- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @orca/daemon test -- harness-metrics/routes`
- [ ] **Step 3: Implement the registrar** mirroring `registerHarnessTransitionRoutes` (server.ts:185 / `harness-transitions/routes.ts:13-30`): goal-existence guard via `SELECT id FROM goals WHERE id = ?` → 404; else `return { metrics: computeHarnessMetrics(db, goalId) }`. Register it in `server.ts` next to `registerHarnessTransitionRoutes`.
- [ ] **Step 4: Run to verify it passes** + `pnpm --filter @orca/daemon typecheck`.
- [ ] **Step 5: Commit** `feat(daemon): /v1/goals/:goalId/harness-metrics route`.

---

### Task 10: Unified multi-hop provenance for a transition

**Files:**
- Create: `apps/daemon/src/harness-metrics/provenance.ts`
- Test: `apps/daemon/src/harness-metrics/provenance.test.ts`
- Modify: `apps/daemon/src/harness-metrics/routes.ts` (add `GET .../harness-transitions/:transitionId/provenance`)

**Interfaces:**
- Consumes: `workflow_decisions` (`influenced_by_json`, `alternatives_considered_json`), `workflow_guardrail_evaluations`, and the transition row.
- Produces: `buildProvenance(db, transitionId): { transition, decisions, alternatives, influencedBy, guardrailEvals }` — a multi-hop join reachable from one transition (the unification of the two provenance models).

- [ ] **Step 1: Write the failing test** — seed a transition tied (via workflowRunId/stepRunId) to a decision with `alternatives_considered_json`/`influenced_by_json` and a guardrail eval; assert `buildProvenance` returns all hops. 
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the join: load the transition; from its `workflowRunId`/`workflowStepRunId` load related `workflow_decisions` (parse the two JSON arrays via the existing parse helpers, decisions/usecases.ts:163-165 pattern) and `workflow_guardrail_evaluations`; return the assembled object. Fail-closed: missing transition → throw/`null` handled by the route as 404.
- [ ] **Step 4: Run to verify it passes** + typecheck.
- [ ] **Step 5: Commit** `feat(daemon): multi-hop provenance for a harness transition`.

**End of P2.** The transition log is queryable as metrics + multi-hop lineage.

---

# Phase P3 — replay + attribution + revived feedback

### Task 11: Control-plane replay

**Files:**
- Create: `apps/daemon/src/harness-metrics/replay.ts`
- Test: `apps/daemon/src/harness-metrics/replay.test.ts`
- Modify: `apps/daemon/src/harness-metrics/routes.ts` (add `GET .../harness-replay`)

**Interfaces:**
- Produces: `replayControlPlane(db, goalId): { steps: Array<{ seq, boundary, at, summary, facets }> }` — an ordered (by `created_at, id`) reconstruction of the transition trajectory, each step summarized from its facets (gate decision / evidence verdict / outcome). Read-only; no state mutation.

- [ ] **Step 1: Write the failing test** — seed several transitions out of insertion order; assert `replayControlPlane` returns them ordered with a per-step summary and that the order is deterministic. 
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** as an ordered fold over `listTransitionsByGoal` (already `ORDER BY created_at DESC, id ASC` — reverse for chronological), projecting each transition to a compact `{ seq, boundary, at: createdAt, summary, facets: { risk, evidence, telemetry } }`. `summary` derived: tool_gate→`risk.gate_decision`, step_complete→`evidence?.verdict ?? telemetry?.outcome.status`. 
- [ ] **Step 4: Run to verify it passes** + typecheck.
- [ ] **Step 5: Commit** `feat(daemon): control-plane replay (ordered transition reconstruction)`.

---

### Task 12: Failure attribution clustering

**Files:**
- Create: `apps/daemon/src/harness-metrics/attribution.ts`
- Test: `apps/daemon/src/harness-metrics/attribution.test.ts`
- Modify: `apps/daemon/src/harness-metrics/routes.ts` (add `GET .../harness-attribution`)

**Interfaces:**
- Produces: `attributeFailures(db, goalId): Array<{ failure_code, boundary, count, sample_transition_ids }>` — clusters failed transitions by `(failure_code, boundary)`, ordered by count desc. Uses `json_extract(telemetry_json, '$.outcome.failure_code')` and `'$.outcome.status'`.

- [ ] **Step 1: Write the failing test** — seed transitions with telemetry outcomes including several `failed` with codes `timeout`/`evidence_veto`; assert the clusters group + count correctly, ordered by frequency. 
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** a SQL aggregate:
  `SELECT json_extract(telemetry_json,'$.outcome.failure_code') AS failure_code, boundary, COUNT(*) AS count FROM harness_transitions WHERE goal_id = ? AND json_extract(telemetry_json,'$.outcome.status') IN ('failed','escalated','denied') GROUP BY failure_code, boundary ORDER BY count DESC` — plus a follow-up to collect up to 3 sample ids per cluster. Prepared-statement cached + `resetPreparedStatements`.
- [ ] **Step 4: Run to verify it passes** + typecheck.
- [ ] **Step 5: Commit** `feat(daemon): failure attribution clustering over transition outcomes`.

---

### Task 13: Revive recommendation feedback as a `human_intervention`

**Files:**
- Modify: `apps/daemon/src/recommendations/input.ts` (stop dead-ending `recentFeedback`)
- Modify: the relevant transition-recording site (attach revived feedback as a `human_intervention`) — likely `service.ts` where recommendations are acted on
- Test: `apps/daemon/src/harness-metrics/feedback-revive.test.ts`

**Interfaces:**
- Consumes: `recentFeedback` (assembled at `recommendations/input.ts:381`, currently read by nothing).
- Produces: feedback for a goal surfaces as `TelemetryFacet.human_interventions[] = { kind: "recommendation_feedback", ref: <feedbackId> }` on the relevant transition, AND is exposed via attribution (so feedback is no longer dead).

- [ ] **Step 1: Write the failing test** — seed recommendation feedback for a goal; drive the path that records a transition; assert the transition's `telemetry.human_interventions` contains a `recommendation_feedback` entry referencing the feedback id. 
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — read the goal's recent feedback at the transition-record site (reuse `listRecentFeedbackByGoal`), map each to `{ kind: "recommendation_feedback", ref: f.id }`, and include them in the `human_interventions` array passed to `buildTelemetry` (Task 7). Keep it bounded (the existing MAX 10). This is the minimal "revive": the dead field now feeds the inspectable record.
- [ ] **Step 4: Run to verify it passes** + typecheck.
- [ ] **Step 5: Commit** `feat(daemon): revive recommendation feedback as a telemetry human_intervention`.

**End of P3.** Replay, failure attribution, and the previously-dead feedback loop are live.

---

## Self-Review

**Spec coverage (against `2026-06-24-inspectable-axis-design.md`):**
- §4.1 TelemetryFacet contract + tightening → Task 1. ✓
- §4.1 cost/price map → Task 2. ✓
- §4.2 OTEL worker-token capture (receiver + spawn wiring + per-session→transition attribution) → Tasks 3 (spike), 4 (parser), 5 (receiver+accumulator), 6 (spawn env/config), 7 (attach). ✓
- §4.3 categorical failure codes → Task 1 (`FailureCode` enum in `outcome`); populated at Task 7 + clustered Task 12. ✓
- §4.4 `/harness-metrics` six-metric projection (graceful-degrade) + unified provenance → Tasks 8, 9, 10. ✓
- §4.5 replay + attribution + revived feedback → Tasks 11, 12, 13. ✓
- D2 graceful-degrade (state_consistency null+reason) → Task 8. ✓
- D6 auth via OTEL headers, no exemption → Task 5/6. ✓

**Recon-first / risk:** Task 3 is an explicit spike with a NEEDS_CONTEXT gate — the OTLP emission/wire-shape is the one unverified assumption; Tasks 4 and 6 use the spike's captured shapes verbatim rather than guessing. Codex entry point confirmed interactive (`args:[]`); if the spike shows interactive Codex won't emit, Codex degrades to `cost=null` (graceful) and Task 6 skips its wiring.

**Type consistency:** `TelemetryFacet`/`CostEntry`/`FailureCode`/`TransitionStatus` defined in Task 1 are used unchanged in Tasks 2, 7, 8, 12. `computeCost` (Task 2) → `buildTelemetry` (Task 7). `SessionCostAccumulator.drain` (Task 5) shape `{tokensIn,tokensOut,model?}` matches `buildTelemetry`'s `acc` param (Task 7) and the test injection. `computeHarnessMetrics` `Metric` shape (Task 8) is consumed by Task 9's route.

**Migrations:** no new migration is strictly required (the `telemetry_json` column already exists and stores the whole facet; `failure_code` lives inside it, queried via `json_extract`). If during execution a dedicated indexed column proves necessary for attribution performance, add `0043_transition_failure_code.sql` and extend the three snapshot enumerations — otherwise none is needed.

**Known recon-first for execution:** Task 3 (OTEL emission spike) MUST run before Tasks 4–6; its findings file is the source of truth for the wire shapes.
