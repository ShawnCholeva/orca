# Per-adapter Hook-Readiness Contract Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert silent third-party-CLI hook drift into a loud, enumerable signal — a per-adapter declared hook contract checked at boot (hard-fail) and surfaced on-demand via a route.

**Architecture:** Each provider declares its hook-surface assumptions as plain data via a new `hookContract()` method on `ShadowProvider`. A leaf checker module regenerates each provider's emitted hook config and asserts the declared events/files/payload-fields/spawn-args actually appear (self-conformance). The boot path hard-fails on a mismatch; an on-demand route layers CLI-version-pin drift and honest `unverified` status on top, reading the already-persisted readiness version (no new subprocess).

**Tech Stack:** TypeScript (Node, ESM `.js` import specifiers), Fastify, better-sqlite3, Vitest. Daemon package `@orca/daemon` under `apps/daemon`.

## Global Constraints

- **No behavior change to orchestration.** This only adds a readiness/contract check; it must not alter how hooks are emitted or how goals run.
- **No live third-party process.** The checker only regenerates Orca's own emitted config and compares declared data; it never spawns `claude`/`codex`/`agy`.
- **No `packages/contracts` change, no migration, no DB schema change.** The route returns a plain object (mirroring `GET /v1/harness/registry`), and the report is stateless (computed on-demand).
- **Version-pin policy:** flag drift on **minor/major** difference, **ignore patch** (`0.136.0 → 0.136.1` stays `ok`; `0.136 → 0.140` → `degraded`).
- **Do not invent verified-against versions.** Only Codex has a live-spike-pinned version (`0.136.0`) in existing comments. Claude and antigravity entries use `verifiedAgainstVersion: null` (the mechanism is ready the moment a human pins one); do not fabricate a Claude/agy version.
- ESM imports use `.js` specifiers (e.g. `import { resolveShadowProvider } from "./registry.js"`).
- Run daemon tests with: `pnpm --filter @orca/daemon test <path>`.

---

### Task 1: Contract types + per-provider declarations

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/providers/types.ts` (add `HookSurface`, `HookAssumption`, `hookContract()` to `ShadowProvider`)
- Modify: `apps/daemon/src/orchestrator-llm/providers/claude.ts` (implement `hookContract()`)
- Modify: `apps/daemon/src/orchestrator-llm/providers/codex.ts` (implement `hookContract()`)
- Modify: `apps/daemon/src/orchestrator-llm/providers/antigravity.ts` (implement `hookContract()`)
- Test: `apps/daemon/src/orchestrator-llm/providers/hook-contract-declarations.test.ts` (create)

**Interfaces:**
- Produces: `type HookSurface = "orchestrator" | "worker"`; `interface HookAssumption` (fields below); `ShadowProvider.hookContract(): HookAssumption[]` implemented by all three providers.

`HookAssumption` shape (consumed by Tasks 2 & 3):
```ts
export type HookSurface = "orchestrator" | "worker";

export interface HookAssumption {
  provider: ShadowAdapterId;
  surface: HookSurface;
  event: string | null;
  file: string | null;
  payloadFields: string[];
  assertSpawnArg: string | null;
  firingContext: string;
  verifiedAgainstVersion: string | null;
  verified: boolean;
  note: string;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/orchestrator-llm/providers/hook-contract-declarations.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveShadowProvider } from "./registry.js";

describe("hookContract declarations", () => {
  it("Codex declares a verified worker PermissionRequest with payload fields and the bypass spawn arg", () => {
    const entries = resolveShadowProvider("codex").hookContract();
    const perm = entries.find((e) => e.surface === "worker" && e.event === "PermissionRequest");
    expect(perm).toBeDefined();
    expect(perm!.verified).toBe(true);
    expect(perm!.file).toBe("hooks.json");
    expect(perm!.payloadFields).toEqual(
      expect.arrayContaining(["tool_name", "tool_input", "session_id", "turn_id"]),
    );
    expect(perm!.assertSpawnArg).toBe("--dangerously-bypass-hook-trust");
    expect(perm!.verifiedAgainstVersion).toBe("0.136.0");
  });

  it("Antigravity declares Stop verified but the worker permission surface unverified", () => {
    const entries = resolveShadowProvider("antigravity").hookContract();
    const stop = entries.find((e) => e.surface === "orchestrator" && e.event === "Stop");
    const worker = entries.find((e) => e.surface === "worker");
    expect(stop!.verified).toBe(true);
    expect(worker!.verified).toBe(false);
    expect(worker!.event).toBeNull();
    expect(worker!.note).toMatch(/unknown/i);
  });

  it("Claude declares verified orchestrator + worker Stop and PermissionRequest entries", () => {
    const entries = resolveShadowProvider("claude-code").hookContract();
    expect(entries.some((e) => e.surface === "orchestrator" && e.event === "Stop")).toBe(true);
    expect(entries.some((e) => e.surface === "worker" && e.event === "PermissionRequest")).toBe(true);
    expect(entries.every((e) => e.provider === "claude-code")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test hook-contract-declarations`
Expected: FAIL — `hookContract` is not a function / type errors (method not yet on interface).

- [ ] **Step 3: Add the types to `types.ts`**

In `apps/daemon/src/orchestrator-llm/providers/types.ts`, add near the top (after the existing `ShadowAdapterId` type):
```ts
export type HookSurface = "orchestrator" | "worker";

/**
 * A single declared assumption about a third-party CLI hook surface this
 * provider depends on. Plain data, co-located with the provider so it cannot
 * silently drift from the code that emits the hook. Checked at boot
 * (self-conformance) and surfaced on-demand (version-pin / unverified).
 */
export interface HookAssumption {
  /** Adapter this assumption belongs to. */
  provider: ShadowAdapterId;
  /** Which emitter surface produces it: hookConfig ("orchestrator") vs workerHookConfig ("worker"). */
  surface: HookSurface;
  /** Hook event name we depend on (e.g. "Stop", "PermissionRequest"); null = unknown. */
  event: string | null;
  /** relPath the hook is wired into (asserted present in emitted config); null = unknown. */
  file: string | null;
  /** Payload fields the emitted config textually references (asserted present). */
  payloadFields: string[];
  /** Spawn arg asserted present in spawnArgs (worker surface only); null = none. */
  assertSpawnArg: string | null;
  /** Documentation only: "interactive-tui-only" | "unattended" | "unknown" | … */
  firingContext: string;
  /** CLI version this surface was last human-verified against; drives version-pin. null = none pinned. */
  verifiedAgainstVersion: string | null;
  /** false = honest unknown (skipped by self-conformance, surfaced as "unverified", never green). */
  verified: boolean;
  /** Provenance note (verification source, or the open unknowns). */
  note: string;
}
```

Then add the method to the `ShadowProvider` interface (after `workerHookConfig(...)`):
```ts
  /** Declared hook-surface assumptions for this provider (see HookAssumption). */
  hookContract(): HookAssumption[];
```

- [ ] **Step 4: Implement `hookContract()` in `claude.ts`**

In `apps/daemon/src/orchestrator-llm/providers/claude.ts`, add `HookAssumption` to the type import and add this method to `ClaudeShadowProvider` (e.g. after `workerHookConfig`):
```ts
  hookContract(): HookAssumption[] {
    return [
      {
        provider: "claude-code", surface: "orchestrator", event: "Stop",
        file: ".claude/settings.local.json", payloadFields: [], assertSpawnArg: null,
        firingContext: "interactive-tui-only", verifiedAgainstVersion: null, verified: true,
        note: "Orchestrator shadow Stop hook (buildShadowHookSettings). No pinned version.",
      },
      {
        provider: "claude-code", surface: "worker", event: "Stop",
        file: "settings.json", payloadFields: [], assertSpawnArg: "--settings",
        firingContext: "interactive-tui-only", verifiedAgainstVersion: null, verified: true,
        note: "Worker Stop hook (buildAgentHookSettings), wired via --settings. No pinned version.",
      },
      {
        provider: "claude-code", surface: "worker", event: "PermissionRequest",
        file: "settings.json", payloadFields: [], assertSpawnArg: "--settings",
        firingContext: "interactive-tui-only", verifiedAgainstVersion: null, verified: true,
        note: "Worker PermissionRequest hook (timeout 1800). No pinned version.",
      },
    ];
  }
```
Update the import line to include `HookAssumption`:
```ts
import type {
  HookAssumption,
  ProviderTerminalFailure,
  ShadowCaptureMode,
  ShadowHookConfig,
  ShadowLaunch,
  ShadowProvider,
  ShadowTurnParse,
} from "./types.js";
```

- [ ] **Step 5: Implement `hookContract()` in `codex.ts`**

In `apps/daemon/src/orchestrator-llm/providers/codex.ts`, add `HookAssumption` to the type import and add to `CodexShadowProvider`:
```ts
  hookContract(): HookAssumption[] {
    return [
      {
        provider: "codex", surface: "orchestrator", event: "Stop",
        file: ".codex/hooks.json", payloadFields: [], assertSpawnArg: null,
        firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0", verified: true,
        note: "Orchestrator Stop hook; Codex hooks fire only in the interactive TUI, never `codex exec`. Verified codex-cli 0.136.0.",
      },
      {
        provider: "codex", surface: "worker", event: "Stop",
        file: "hooks.json", payloadFields: [], assertSpawnArg: "--dangerously-bypass-hook-trust",
        firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0", verified: true,
        note: "Worker Stop hook at CODEX_HOME root. Verified codex-cli 0.136.0.",
      },
      {
        provider: "codex", surface: "worker", event: "PermissionRequest",
        file: "hooks.json",
        payloadFields: ["tool_name", "tool_input", "session_id", "turn_id"],
        assertSpawnArg: "--dangerously-bypass-hook-trust",
        firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0", verified: true,
        note: "Worker PermissionRequest; Codex omits tool_use_id so the relay synthesizes a correlation id from session_id+turn_id+sha1(tool_name,tool_input). Verified codex-cli 0.136.0.",
      },
    ];
  }
```
Update the import to include `HookAssumption` alongside the existing `ProviderTerminalFailure`, etc.

- [ ] **Step 6: Implement `hookContract()` in `antigravity.ts`**

In `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`, add `HookAssumption` to the type import and add to `AntigravityShadowProvider`:
```ts
  hookContract(): HookAssumption[] {
    return [
      {
        provider: "antigravity", surface: "orchestrator", event: "Stop",
        file: ".agents/hooks.json", payloadFields: [], assertSpawnArg: null,
        firingContext: "unattended", verifiedAgainstVersion: null, verified: true,
        note: "Orchestrator Stop hook (.agents/hooks.json → orca-stop-hook.cjs); turn capture works. No pinned version.",
      },
      {
        provider: "antigravity", surface: "worker", event: null,
        file: null, payloadFields: [], assertSpawnArg: null,
        firingContext: "unknown", verifiedAgainstVersion: null, verified: false,
        note: "Worker permission flow UNVERIFIED — 4 unknowns: event name, hook-file JSON shape + on-disk path, discovery mechanism, stdout decision schema. See FUTURE_WORK Phase 1.",
      },
    ];
  }
```
Update the import to include `HookAssumption`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test hook-contract-declarations`
Expected: PASS (3 tests).

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors (the new interface method is implemented by all three providers).

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/types.ts \
        apps/daemon/src/orchestrator-llm/providers/claude.ts \
        apps/daemon/src/orchestrator-llm/providers/codex.ts \
        apps/daemon/src/orchestrator-llm/providers/antigravity.ts \
        apps/daemon/src/orchestrator-llm/providers/hook-contract-declarations.test.ts
git commit -m "feat(0.3): declare per-adapter hook contracts on ShadowProvider"
```

---

### Task 2: Self-conformance checker + boot guard

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/providers/hook-contract.ts`
- Modify: `apps/daemon/src/index.ts` (call the boot guard after `assertHarnessRegistryConformance`)
- Test: `apps/daemon/src/orchestrator-llm/providers/hook-contract.conformance.test.ts` (create)

**Interfaces:**
- Consumes: `HookAssumption`, `HookSurface`, `ShadowProvider`, `resolveShadowProvider` (Task 1 / existing registry).
- Produces:
  - `conformanceError(provider: ShadowProvider, a: HookAssumption): string | null` — null if the entry conforms, else a precise message.
  - `assertHookContractConformance(): void` — throws if any verified entry across all providers fails conformance.
  - `PROVIDER_IDS: ShadowAdapterId[]` — the three ids, exported for reuse by Task 3.
  - `emittedFor(provider, surface): { files: {relPath:string;contents:string}[]; spawnArgs: string[] }` — exported for reuse by Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/orchestrator-llm/providers/hook-contract.conformance.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { conformanceError, assertHookContractConformance } from "./hook-contract.js";
import { resolveShadowProvider } from "./registry.js";
import type { HookAssumption } from "./types.js";

describe("hook contract self-conformance", () => {
  it("all three providers' declared contracts conform to their emitted config", () => {
    expect(() => assertHookContractConformance()).not.toThrow();
  });

  it("flags a declared event that is not in the emitted config", () => {
    const provider = resolveShadowProvider("codex");
    const bogus: HookAssumption = {
      provider: "codex", surface: "worker", event: "TotallyMadeUpEvent",
      file: "hooks.json", payloadFields: [], assertSpawnArg: null,
      firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0",
      verified: true, note: "fixture",
    };
    expect(conformanceError(provider, bogus)).toMatch(/TotallyMadeUpEvent/);
  });

  it("flags a declared payload field absent from the emitted config", () => {
    const provider = resolveShadowProvider("codex");
    const bogus: HookAssumption = {
      provider: "codex", surface: "worker", event: "PermissionRequest",
      file: "hooks.json", payloadFields: ["no_such_field"], assertSpawnArg: null,
      firingContext: "interactive-tui-only", verifiedAgainstVersion: "0.136.0",
      verified: true, note: "fixture",
    };
    expect(conformanceError(provider, bogus)).toMatch(/no_such_field/);
  });

  it("skips unverified entries (no emitted config to check)", () => {
    const provider = resolveShadowProvider("antigravity");
    const unverified: HookAssumption = {
      provider: "antigravity", surface: "worker", event: null, file: null,
      payloadFields: [], assertSpawnArg: null, firingContext: "unknown",
      verifiedAgainstVersion: null, verified: false, note: "fixture",
    };
    expect(conformanceError(provider, unverified)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test hook-contract.conformance`
Expected: FAIL — cannot find module `./hook-contract.js`.

- [ ] **Step 3: Create the checker module**

Create `apps/daemon/src/orchestrator-llm/providers/hook-contract.ts`:
```ts
import { resolveShadowProvider } from "./registry.js";
import type { HookAssumption, HookSurface, ShadowAdapterId, ShadowProvider } from "./types.js";

export const PROVIDER_IDS: ShadowAdapterId[] = ["claude-code", "codex", "antigravity"];

// Synthetic args used to regenerate emitted config for structural conformance.
// Values are arbitrary — only the emitted structure (event keys / file paths /
// payload-field references / spawn args) is asserted, never these literals.
const SYNTHETIC = {
  goalId: "conformance-goal",
  sessionId: "conformance-session",
  resolverCommand: ["node", "resolver.js"],
  configDir: "/tmp/orca-conformance",
};

export interface EmittedConfig {
  files: { relPath: string; contents: string }[];
  spawnArgs: string[];
}

export function emittedFor(provider: ShadowProvider, surface: HookSurface): EmittedConfig {
  if (surface === "orchestrator") {
    const cfg = provider.hookConfig({ goalId: SYNTHETIC.goalId, resolverCommand: SYNTHETIC.resolverCommand });
    return { files: cfg.files, spawnArgs: [] };
  }
  const cfg = provider.workerHookConfig({
    goalId: SYNTHETIC.goalId,
    sessionId: SYNTHETIC.sessionId,
    resolverCommand: SYNTHETIC.resolverCommand,
    configDir: SYNTHETIC.configDir,
  });
  return { files: cfg.files, spawnArgs: cfg.spawnArgs };
}

/** Returns a precise drift message, or null if the entry conforms. Unverified entries are skipped. */
export function conformanceError(provider: ShadowProvider, a: HookAssumption): string | null {
  if (!a.verified) return null;
  const where = `${a.provider}/${a.surface}/${a.event ?? "?"}`;
  const emitted = emittedFor(provider, a.surface);
  const file = a.file ? emitted.files.find((f) => f.relPath === a.file) : undefined;
  if (a.file && !file) return `hook contract drift: ${where} — declared file '${a.file}' not emitted`;
  const contents = file ? file.contents : "";
  if (a.event && !contents.includes(a.event)) {
    return `hook contract drift: ${where} — event '${a.event}' not found in ${a.file}`;
  }
  for (const field of a.payloadFields) {
    if (!contents.includes(field)) {
      return `hook contract drift: ${where} — declared field '${field}' not found in ${a.file}`;
    }
  }
  if (a.assertSpawnArg && !emitted.spawnArgs.includes(a.assertSpawnArg)) {
    return `hook contract drift: ${where} — spawn arg '${a.assertSpawnArg}' not emitted`;
  }
  return null;
}

/** Boot guard: throws loud if any verified entry across all providers fails conformance. */
export function assertHookContractConformance(): void {
  const errors: string[] = [];
  for (const id of PROVIDER_IDS) {
    const provider = resolveShadowProvider(id);
    for (const entry of provider.hookContract()) {
      const err = conformanceError(provider, entry);
      if (err) errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new Error(`hook contract conformance failed:\n  ${errors.join("\n  ")}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test hook-contract.conformance`
Expected: PASS (4 tests). If "all three providers conform" fails, a declaration in Task 1 disagrees with the emitted config — fix the declaration, not the checker.

- [ ] **Step 5: Wire the boot guard into `index.ts`**

In `apps/daemon/src/index.ts`, add the import near the other harness import (line ~26):
```ts
import { assertHookContractConformance } from './orchestrator-llm/providers/hook-contract.js';
```
Then, immediately after the existing `assertHarnessRegistryConformance` try/catch block (the one ending ~line 89), add:
```ts
  try {
    assertHookContractConformance();
  } catch (err) {
    console.error('[orca-daemon] Hook contract conformance failed — aborting startup:', err);
    process.exit(1);
  }
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/hook-contract.ts \
        apps/daemon/src/orchestrator-llm/providers/hook-contract.conformance.test.ts \
        apps/daemon/src/index.ts
git commit -m "feat(0.3): self-conformance checker + boot guard for hook contracts"
```

---

### Task 3: On-demand report builder (status + version-pin)

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/providers/hook-contract.ts` (add `checkHookContracts` + status logic)
- Test: `apps/daemon/src/orchestrator-llm/providers/hook-contract.report.test.ts` (create)

**Interfaces:**
- Consumes: `PROVIDER_IDS`, `conformanceError`, `resolveShadowProvider`, `HookAssumption`, `ShadowAdapterId`.
- Produces:
  - `type HookContractStatus = "ok" | "degraded" | "unverified" | "unknown" | "nonconformant"`
  - `interface HookContractReportEntry { provider; surface; event; file; firingContext; verified; verifiedAgainstVersion; installedVersion: string | null; status: HookContractStatus; detail?: string }`
  - `checkHookContracts(args: { versions: Partial<Record<ShadowAdapterId, string | null>> }): { contracts: HookContractReportEntry[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/orchestrator-llm/providers/hook-contract.report.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { checkHookContracts } from "./hook-contract.js";

describe("checkHookContracts", () => {
  it("codex worker PermissionRequest is ok when installed minor/major matches verified", () => {
    const { contracts } = checkHookContracts({ versions: { codex: "0.136.4" } });
    const e = contracts.find((c) => c.provider === "codex" && c.event === "PermissionRequest");
    expect(e!.status).toBe("ok"); // patch differs, minor/major same → ignored
    expect(e!.installedVersion).toBe("0.136.4");
  });

  it("codex degrades when installed minor moves off verified", () => {
    const { contracts } = checkHookContracts({ versions: { codex: "0.140.0" } });
    const e = contracts.find((c) => c.provider === "codex" && c.event === "PermissionRequest");
    expect(e!.status).toBe("degraded");
    expect(e!.detail).toMatch(/re-verify/i);
  });

  it("reports unknown when no installed version is available", () => {
    const { contracts } = checkHookContracts({ versions: {} });
    const e = contracts.find((c) => c.provider === "codex" && c.event === "PermissionRequest");
    expect(e!.status).toBe("unknown");
  });

  it("antigravity worker permission surface is unverified regardless of version", () => {
    const { contracts } = checkHookContracts({ versions: { antigravity: "1.2.3" } });
    const e = contracts.find((c) => c.provider === "antigravity" && c.surface === "worker");
    expect(e!.status).toBe("unverified");
  });

  it("entries with no pinned verified version stay ok when conformant", () => {
    const { contracts } = checkHookContracts({ versions: { "claude-code": "9.9.9" } });
    const e = contracts.find((c) => c.provider === "claude-code" && c.event === "Stop");
    expect(e!.status).toBe("ok"); // verifiedAgainstVersion is null → drift not assessed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test hook-contract.report`
Expected: FAIL — `checkHookContracts` is not exported.

- [ ] **Step 3: Add the report builder to `hook-contract.ts`**

Append to `apps/daemon/src/orchestrator-llm/providers/hook-contract.ts`:
```ts
export type HookContractStatus = "ok" | "degraded" | "unverified" | "unknown" | "nonconformant";

export interface HookContractReportEntry {
  provider: ShadowAdapterId;
  surface: HookSurface;
  event: string | null;
  file: string | null;
  firingContext: string;
  verified: boolean;
  verifiedAgainstVersion: string | null;
  installedVersion: string | null;
  status: HookContractStatus;
  detail?: string;
}

/** Extract "major.minor" from a clean version string, or null if unparseable. */
function majorMinor(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return m ? `${m[1]}.${m[2]}` : null;
}

function statusFor(
  provider: ShadowProvider,
  a: HookAssumption,
  installedVersion: string | null,
): HookContractReportEntry {
  const base = {
    provider: a.provider, surface: a.surface, event: a.event, file: a.file,
    firingContext: a.firingContext, verified: a.verified,
    verifiedAgainstVersion: a.verifiedAgainstVersion, installedVersion,
  };
  if (!a.verified) {
    return { ...base, status: "unverified", detail: a.note };
  }
  const conformErr = conformanceError(provider, a);
  if (conformErr) {
    return { ...base, status: "nonconformant", detail: conformErr };
  }
  // Version-pin: only assess drift when BOTH a pinned version and an installed
  // version are known and parseable; otherwise we cannot judge drift.
  if (a.verifiedAgainstVersion === null) return { ...base, status: "ok" };
  if (installedVersion === null) return { ...base, status: "unknown" };
  const want = majorMinor(a.verifiedAgainstVersion);
  const have = majorMinor(installedVersion);
  if (want === null || have === null) return { ...base, status: "unknown" };
  if (want !== have) {
    return {
      ...base, status: "degraded",
      detail: `verified against ${a.verifiedAgainstVersion}, running ${installedVersion} — re-verify`,
    };
  }
  return { ...base, status: "ok" };
}

export function checkHookContracts(args: {
  versions: Partial<Record<ShadowAdapterId, string | null>>;
}): { contracts: HookContractReportEntry[] } {
  const contracts: HookContractReportEntry[] = [];
  for (const id of PROVIDER_IDS) {
    const provider = resolveShadowProvider(id);
    const installed = args.versions[id] ?? null;
    for (const entry of provider.hookContract()) {
      contracts.push(statusFor(provider, entry, installed));
    }
  }
  return { contracts };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test hook-contract.report`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/hook-contract.ts \
        apps/daemon/src/orchestrator-llm/providers/hook-contract.report.test.ts
git commit -m "feat(0.3): on-demand hook-contract report with version-pin status"
```

---

### Task 4: Introspection route `GET /v1/harness/hook-contracts`

**Files:**
- Modify: `apps/daemon/src/harness-transitions/routes.ts` (add the route)
- Test: `apps/daemon/src/harness-transitions/hook-contracts-route.test.ts` (create)

**Interfaces:**
- Consumes: `checkHookContracts` (Task 3); `listAgents(db)` (existing, `apps/daemon/src/agents.ts`) which returns rows with `id` and `version?: string`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/harness-transitions/hook-contracts-route.test.ts`, copying the db/server harness from `apps/daemon/src/harness-transitions/routes.test.ts` verbatim (it uses `openDatabase(cfg(dir))` + `runMigrations`, not `seedAgents` — `listAgents` returning `[]` is fine here, since agy's `unverified` comes from `verified:false`, not from a version):
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { registerHarnessTransitionRoutes } from "./routes.js";

const dirs: string[] = [];
function cfg(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1<<20,
    sessionStopGraceMs: 5000, sessionWsBufferLimitBytes: 1<<20, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node","x.js"], getAuthToken: () => "t" };
}
let db: Database.Database; let server: FastifyInstance;
beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-hook-contracts-")); dirs.push(dir);
  db = openDatabase(cfg(dir)); runMigrations(db, defaultMigrationsDir());
  server = Fastify(); registerHarnessTransitionRoutes(server, { db }); await server.ready();
});
afterEach(async () => { await server.close(); closeDatabase(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("GET /v1/harness/hook-contracts", () => {
  it("enumerates per-provider hook contract entries with a status each", async () => {
    const res = await server.inject({ method: "GET", url: "/v1/harness/hook-contracts" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { contracts: Array<{ provider: string; surface: string; status: string }> };
    expect(body.contracts.length).toBeGreaterThan(0);
    const agyWorker = body.contracts.find((c) => c.provider === "antigravity" && c.surface === "worker");
    expect(agyWorker!.status).toBe("unverified");
    for (const c of body.contracts) {
      expect(["ok", "degraded", "unverified", "unknown", "nonconformant"]).toContain(c.status);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test hook-contracts-route`
Expected: FAIL — route returns 404 (not yet registered).

- [ ] **Step 3: Add the route to `routes.ts`**

In `apps/daemon/src/harness-transitions/routes.ts`, add imports at the top:
```ts
import { checkHookContracts } from "../orchestrator-llm/providers/hook-contract.js";
import { listAgents } from "../agents.js";
import type { ShadowAdapterId } from "../orchestrator-llm/providers/types.js";
```
Then register the route inside `registerHarnessTransitionRoutes`, next to the existing `/v1/harness/registry` handler:
```ts
  server.get("/v1/harness/hook-contracts", async () => {
    const versions: Partial<Record<ShadowAdapterId, string | null>> = {};
    for (const agent of listAgents(db)) {
      versions[agent.id as ShadowAdapterId] = agent.readiness?.version ?? null;
    }
    return checkHookContracts({ versions });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orca/daemon test hook-contracts-route`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: no errors. (`listAgents(db)` returns `Agent[]`; the installed version lives at `agent.readiness?.version`, sourced from the persisted `readiness_version` column — there is no top-level `agent.version`.)

- [ ] **Step 6: Run the full provider + harness test suites**

Run: `pnpm --filter @orca/daemon test orchestrator-llm/providers harness-transitions`
Expected: PASS (all hook-contract + existing provider + harness route tests green).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/harness-transitions/routes.ts \
        apps/daemon/src/harness-transitions/hook-contracts-route.test.ts
git commit -m "feat(0.3): GET /v1/harness/hook-contracts introspection route"
```

---

## Final verification (after all tasks)

- [ ] `pnpm --filter @orca/daemon typecheck` — clean.
- [ ] `pnpm --filter @orca/daemon test orchestrator-llm/providers harness-transitions` — green.
- [ ] Sanity: temporarily break a declared event (e.g. rename codex worker `PermissionRequest` → `Permission` in `codex.ts`'s `hookContract()`), run `pnpm --filter @orca/daemon test hook-contract.conformance`, confirm the "all three providers conform" test FAILS with a precise drift message, then revert. (Confirms the guard has teeth.)

## Spec coverage check

- Declared per-(provider × surface × event) entries → Task 1.
- Boot self-conformance hard-fail → Task 2 (`assertHookContractConformance` + `index.ts`).
- On-demand version-pin / unverified / unknown / nonconformant statuses → Task 3.
- Runtime-enumerable introspection route → Task 4.
- Honest agy split (Stop verified, worker unverified) → Task 1 declarations + Task 3 status + Task 4 route assertion.
- Minor/major version policy → Task 3 `majorMinor`.
- Stateless / no DB / no contracts change / no migration → none added (Global Constraints).
