# Antigravity Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google's Antigravity as a full-parity Orca agent adapter matching Claude Code and Codex functionality.

**Architecture:** Add `antigravity` to shared contracts, then wire a daemon adapter, readiness checks, seeded agent metadata, execution-mode defaults, model catalog entries, and shadow-session provider. Antigravity completed-turn capture must use Stop hooks plus transcript data, not pane polling/scraping.

**Tech Stack:** TypeScript, Zod contracts, Vitest, Fastify daemon routes, tmux-backed pty sessions, Antigravity `agy` CLI hooks.

---

## File Structure

- Modify `packages/contracts/src/adapters/ids.ts`: add `antigravity` to `AdapterId`.
- Modify `packages/contracts/src/workflows/index.ts`: add `orca/google` to `ModelProviderId`.
- Modify `packages/contracts/src/index.test.ts` and `packages/contracts/src/__tests__/workflow-contracts.test.ts`: contract assertions.
- Create `apps/daemon/src/adapters/antigravity.ts`: Antigravity adapter implementation.
- Create `apps/daemon/src/adapters/antigravity.readiness.test.ts`: readiness and repair tests.
- Modify `apps/daemon/src/adapters/model-catalog.ts`: provider mapping and model list.
- Modify `apps/daemon/src/adapters/registry.test.ts`: registry list expectation.
- Modify `apps/daemon/src/registry/bootstrap.ts` and `apps/daemon/src/registry/bootstrap.test.ts`: register adapter.
- Modify `apps/daemon/src/agents.ts` and `apps/daemon/src/agents.test.ts`: seed agent.
- Modify `apps/daemon/src/adapters/execution-modes.ts` and `apps/daemon/src/index.adapter-modes.test.ts`: execution-mode default.
- Modify `apps/daemon/src/readiness/repair-links.ts`: install/sign-in repair metadata.
- Modify `apps/daemon/src/workflows/operators/registry.ts`: Antigravity capabilities.
- Modify `apps/daemon/src/workflows/orchestration-transport/provider-catalog.ts` and `.test.ts`: expose agent-backed Google provider metadata without adding a direct API provider.
- Modify `apps/daemon/src/workflows/orchestration-transport/policy.ts` and `.test.ts`: route Google orchestration through hidden interactive/human review.
- Create `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`: shadow provider and transcript-backed hook relay contents.
- Create `apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts`: shadow provider tests.
- Modify `apps/daemon/src/orchestrator-llm/providers/types.ts`: extend `ShadowAdapterId`.
- Modify `apps/daemon/src/orchestrator-llm/providers/registry.ts` and `.test.ts`: register shadow provider.
- Modify `apps/daemon/src/shadow-hooks/routes.ts` and `.test.ts`: preserve Antigravity hook failure text.
- Modify `apps/daemon/src/orchestrator-llm/shadow-session.ts`: add optional `antigravityBin` override.
- Modify `apps/daemon/src/orchestrator-llm/model-provider-llm-client.ts` and tests: route `orca/google` to `antigravity`.
- Modify `apps/daemon/src/server.ts`: pass `ORCA_ANTIGRAVITY_BIN` to shadow session manager and avoid two-provider narrowing.
- Add optional `apps/daemon/src/adapters/antigravity.auth-smoke.test.ts`: gated real CLI auth smoke.

---

### Task 1: Contracts For Antigravity IDs

**Files:**
- Modify: `packages/contracts/src/adapters/ids.ts`
- Modify: `packages/contracts/src/workflows/index.ts`
- Modify: `packages/contracts/src/index.test.ts`
- Modify: `packages/contracts/src/__tests__/workflow-contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add to `packages/contracts/src/index.test.ts` in the existing adapter-id test block:

```ts
expect(AdapterId.parse("antigravity")).toBe("antigravity");
```

Add to `packages/contracts/src/__tests__/workflow-contracts.test.ts` in the provider display-name test:

```ts
expect(getModelProviderDisplayName("orca/google")).toBe("Google");
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @orca/contracts test -- index.test.ts workflow-contracts.test.ts
```

Expected: FAIL because `antigravity` and `orca/google` are not accepted.

- [ ] **Step 3: Extend contract enums**

Change `packages/contracts/src/adapters/ids.ts`:

```ts
export const AdapterId = z.enum(["claude-code", "codex", "antigravity"]);
export type AdapterId = z.infer<typeof AdapterId>;
```

Change `packages/contracts/src/workflows/index.ts`:

```ts
export const ModelProviderId = z.enum([
  "orca/anthropic",
  "orca/openai",
  "orca/google"
]);
```

Update `getModelProviderDisplayName()`:

```ts
export function getModelProviderDisplayName(providerId: ModelProviderId): string {
  switch (providerId) {
    case "orca/anthropic":
      return "Claude";
    case "orca/openai":
      return "OpenAI";
    case "orca/google":
      return "Google";
  }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @orca/contracts test -- index.test.ts workflow-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/adapters/ids.ts packages/contracts/src/workflows/index.ts packages/contracts/src/index.test.ts packages/contracts/src/__tests__/workflow-contracts.test.ts
git commit -m "feat(contracts): add Antigravity adapter id"
```

---

### Task 2: Antigravity Adapter Readiness

**Files:**
- Create: `apps/daemon/src/adapters/antigravity.ts`
- Create: `apps/daemon/src/adapters/antigravity.readiness.test.ts`
- Modify: `apps/daemon/src/readiness/repair-links.ts`

- [ ] **Step 1: Write failing readiness tests**

Create `apps/daemon/src/adapters/antigravity.readiness.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AntigravityAdapter } from "./antigravity.js";
import type { RunCheckFn } from "./antigravity.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["agy"] });

function a(run: RunCheckFn, resolved = ok("/usr/bin/agy")) {
  return new AntigravityAdapter(resolved, run);
}

describe("AntigravityAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "agy 2.0.1",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("2.0.1");
    expect(run).toHaveBeenCalledWith("/usr/bin/agy", ["--version"], expect.anything());
  });

  it("returns missing on ENOENT", async () => {
    const step = await new AntigravityAdapter(missing, vi.fn()).checkInstalled();
    expect(step.ok).toBe(false);
    expect(step.command).toBe("agy --version");
  });
});

describe("AntigravityAdapter.checkAuth", () => {
  it("short prompt success means ready", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ORCA_AUTH_OK",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/agy",
      ["-p", "Reply exactly: ORCA_AUTH_OK"],
      expect.objectContaining({ timeoutMs: 8000 }),
    );
  });

  it("auth wording means needs_auth", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Please sign in with Google to continue.",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("unexpected failure means misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "keyring failed",
      durationMs: 1,
      timedOut: false,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });

  it("timeout means misconfigured", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: undefined,
      stdout: "",
      stderr: "",
      durationMs: 8000,
      timedOut: true,
    });
    const step = await a(run).checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });
});

describe("AntigravityAdapter.repairFor", () => {
  const adapter = new AntigravityAdapter(ok("/usr/bin/agy"), vi.fn());

  it("missing points to install docs", () => {
    expect(adapter.repairFor("missing")).toMatchObject({
      kind: "install_url",
      label: "Install Antigravity",
    });
  });

  it("needs_auth runs agy", () => {
    expect(adapter.repairFor("needs_auth")).toMatchObject({
      kind: "run_command",
      command: "agy",
      label: "Sign in to Antigravity",
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @orca/daemon test -- src/adapters/antigravity.readiness.test.ts
```

Expected: FAIL because `./antigravity.js` does not exist.

- [ ] **Step 3: Implement adapter**

Create `apps/daemon/src/adapters/antigravity.ts`:

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
import { runCheckCommand, inheritCredEnv, type RunCheckResult } from "../readiness/exec.js";
import { sanitizeOutput } from "../readiness/sanitize.js";
import { installUrlFor, signInCommandFor } from "../readiness/repair-links.js";
import { parseVersion } from "../readiness/version.js";
import type { AgentReadinessStatus, CheckStep, RepairAction, ExecutionMode } from "@orca/contracts";
import { adapterSupportsModel } from "./model-catalog.js";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

const AUTH_PROBE_PROMPT = "Reply exactly: ORCA_AUTH_OK";
const NOT_AUTHENTICATED =
  /\bnot (?:yet |currently )?(?:logged in|signed in|authenticated)\b|\b(?:please (?:log|sign) in|login required|authentication required|unauthorized)\b|google sign-in|sign in with google/i;

export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity" as const;
  readonly title = "Antigravity";
  readonly supportedExecutionModes: ExecutionMode[] = ["shadow_session", "one_shot"];
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  supportsModel(modelId: string): boolean {
    return adapterSupportsModel(this.id, modelId);
  }

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`agy not found. Set ORCA_ANTIGRAVITY_BIN or install Antigravity. Tried: ${result.tried.join(", ")}`),
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
        detail: `agy not found. Set ORCA_ANTIGRAVITY_BIN or install Antigravity. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "agy --version", detail: "agy not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"], { env: inheritCredEnv() });
    const version = parseVersion(r.stdout, "agy");
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "agy --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "agy --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "agy --version failed",
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["-p", AUTH_PROBE_PROMPT], {
      env: inheritCredEnv(),
      timeoutMs: 8000,
    });
    const combined = `${r.stdout}\n${r.stderr}`;
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        detail: "timeout",
      };
    }
    if (r.exitCode === 0 && /\bORCA_AUTH_OK\b/.test(combined)) {
      return {
        name: "authenticated",
        ok: true,
        authStatus: "ready",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        detail: "authenticated",
      };
    }
    if (NOT_AUTHENTICATED.test(combined)) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        exitCode: r.exitCode,
        detail: "not signed in",
      };
    }
    return {
      name: "authenticated",
      ok: false,
      authStatus: "misconfigured",
      command: `agy -p "${AUTH_PROBE_PROMPT}"`,
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "unexpected auth probe output",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("antigravity");
      return url ? { kind: "install_url", url, label: "Install Antigravity" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("antigravity");
      return command ? { kind: "run_command", command, label: "Sign in to Antigravity" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: `agy -p "${AUTH_PROBE_PROMPT}"`, label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_ANTIGRAVITY_BIN"];
  return override ? [override] : ["agy"];
}
```

Modify `apps/daemon/src/readiness/repair-links.ts`:

```ts
export type KnownAdapterId = "claude-code" | "codex" | "antigravity";

const INSTALL_URLS: Record<KnownAdapterId, string> = {
  "claude-code": "https://docs.anthropic.com/claude/docs/claude-code",
  codex: "https://github.com/openai/codex",
  antigravity: "https://www.antigravity.google/docs/cli-getting-started",
};

const SIGN_IN_COMMANDS: Record<KnownAdapterId, string> = {
  "claude-code": "claude auth login",
  codex: "codex login",
  antigravity: "agy",
};
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/adapters/antigravity.readiness.test.ts src/readiness/repair-links.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/antigravity.ts apps/daemon/src/adapters/antigravity.readiness.test.ts apps/daemon/src/readiness/repair-links.ts
git commit -m "feat(daemon): add Antigravity readiness adapter"
```

---

### Task 3: Register And Seed Antigravity

**Files:**
- Modify: `apps/daemon/src/registry/bootstrap.ts`
- Modify: `apps/daemon/src/registry/bootstrap.test.ts`
- Modify: `apps/daemon/src/adapters/registry.test.ts`
- Modify: `apps/daemon/src/agents.ts`
- Modify: `apps/daemon/src/agents.test.ts`
- Modify: `apps/daemon/src/adapters/execution-modes.ts`
- Modify: `apps/daemon/src/index.adapter-modes.test.ts`

- [ ] **Step 1: Write failing registry/seed tests**

Update `apps/daemon/src/adapters/registry.test.ts` to import `AntigravityAdapter`, register it in `makeRegistry()`, and expect three ids:

```ts
import { AntigravityAdapter } from "./antigravity.js";

registry.register(new AntigravityAdapter(available));

expect(ids).toEqual(["antigravity", "claude-code", "codex"]);
```

Update `apps/daemon/src/registry/bootstrap.test.ts`:

```ts
expect(adapters.get("antigravity")).toBeDefined();
```

Update `apps/daemon/src/agents.test.ts` in the seed/list test:

```ts
expect(listAgents(db).map((a) => a.id)).toEqual(["claude-code", "codex", "antigravity"]);
```

Update `apps/daemon/src/index.adapter-modes.test.ts` loops from:

```ts
for (const id of ["claude-code", "codex"]) {
```

to:

```ts
for (const id of ["claude-code", "codex", "antigravity"]) {
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @orca/daemon test -- src/adapters/registry.test.ts src/registry/bootstrap.test.ts src/agents.test.ts src/index.adapter-modes.test.ts
```

Expected: FAIL because Antigravity is not registered or seeded.

- [ ] **Step 3: Register adapter**

Modify `apps/daemon/src/registry/bootstrap.ts`:

```ts
import { AntigravityAdapter } from '../adapters/antigravity.js';
```

Register after Codex:

```ts
adapters.register(new ClaudeCodeAdapter());
adapters.register(new CodexAdapter());
adapters.register(new AntigravityAdapter());
```

- [ ] **Step 4: Seed agent metadata**

Add to `SEED_AGENTS` in `apps/daemon/src/agents.ts`:

```ts
{
  id: "antigravity",
  name: "Antigravity",
  short_label: "Google · CLI",
  description: "Google agent runtime for long-horizon planning, coding, and multi-surface work.",
  swatch: "#4285F4",
  recommended: 1,
  sort_order: 30,
},
```

- [ ] **Step 5: Add execution-mode default**

Modify `ADAPTER_EXECUTION_MODE_DEFAULTS` in `apps/daemon/src/adapters/execution-modes.ts`:

```ts
antigravity: {
  adapterId: "antigravity",
  enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
  disabledExecutionModes: [
    { mode: "one_shot", reason: "Antigravity orchestration uses interactive shadow sessions, not direct one-shot probes" },
  ],
},
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/adapters/registry.test.ts src/registry/bootstrap.test.ts src/agents.test.ts src/index.adapter-modes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/registry/bootstrap.ts apps/daemon/src/registry/bootstrap.test.ts apps/daemon/src/adapters/registry.test.ts apps/daemon/src/agents.ts apps/daemon/src/agents.test.ts apps/daemon/src/adapters/execution-modes.ts apps/daemon/src/index.adapter-modes.test.ts
git commit -m "feat(daemon): register Antigravity adapter"
```

---

### Task 4: Model Catalog And Operator Routing

**Files:**
- Modify: `apps/daemon/src/adapters/model-catalog.ts`
- Modify: `apps/daemon/src/adapters/agent-adapters.test.ts`
- Modify: `apps/daemon/src/workflows/operators/registry.ts`
- Modify: `apps/daemon/src/workflows/operators/registry.test.ts`
- Modify: `apps/daemon/src/orchestrator-llm/model-provider-llm-client.ts`
- Modify: `apps/daemon/src/orchestrator-llm/model-provider-llm-client.test.ts`
- Modify: `apps/desktop/src/create-goal-flow/orchestratorDefaults.ts`
- Modify: `apps/desktop/src/create-goal-flow/orchestratorDefaults.test.ts`
- Modify: `apps/daemon/src/workflows/orchestration-transport/provider-catalog.ts`
- Modify: `apps/daemon/src/workflows/orchestration-transport/provider-catalog.test.ts`
- Modify: `apps/daemon/src/workflows/orchestration-transport/policy.ts`
- Modify: `apps/daemon/src/workflows/orchestration-transport/policy.test.ts`
- Modify: `apps/daemon/src/server.test.ts`

- [ ] **Step 1: Write failing model catalog tests**

Add assertions in `apps/daemon/src/adapters/agent-adapters.test.ts`:

```ts
import { MODELS_BY_AGENT_ID, PROVIDER_BY_AGENT_ID, adapterSupportsModel } from "./model-catalog.js";

it("maps Antigravity to Google provider metadata", () => {
  expect(PROVIDER_BY_AGENT_ID.antigravity).toBe("orca/google");
  expect(MODELS_BY_AGENT_ID.antigravity?.map((m) => m.id)).toEqual([
    "gemini-3.5-flash",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-flash",
  ]);
  expect(adapterSupportsModel("antigravity", "gemini-3.5-flash")).toBe(true);
});
```

Update `apps/daemon/src/orchestrator-llm/model-provider-llm-client.test.ts`:

```ts
expect(adapterIdForProvider("orca/google")).toBe("antigravity");
```

Also add a routed-client assertion in the existing shadow-routing test:

```ts
await routed.request({ goalId: "g", adapterId: "antigravity", modelId: "gemini-3.5-flash", systemPrompt: "s", userPrompt: "u" });
expect(shadow.request).toHaveBeenCalledTimes(3);
expect(shadow.request.mock.calls.map(([input]) => input.adapterId)).toContain("antigravity");
```

Update `apps/desktop/src/create-goal-flow/orchestratorDefaults.test.ts`:

```ts
expect(defaultModelForProvider({
  id: "orca/google",
  displayName: "Google",
  models: [
    { id: "gemini-3.1-pro-high", displayName: "Gemini 3.1 Pro (high)", capabilities: [] },
    { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", capabilities: [] },
  ],
})).toMatchObject({ id: "gemini-3.5-flash" });
```

Update `apps/daemon/src/workflows/orchestration-transport/provider-catalog.test.ts`:

```ts
it("includes connected agent-backed providers without a direct API provider", async () => {
  const registry = new ModelProviderRegistry();
  registry.register(provider("orca/openai", "OpenAI", true));
  const catalog = await buildOrchestrationProviderCatalog(registry, {
    allowedProviderIds: new Set(["orca/google"]),
    modelOverrides: new Map([
      [
        "orca/google",
        [{ id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", capabilities: ["tool_use"] }],
      ],
    ]),
  });
  expect(catalog).toEqual([
    {
      id: "orca/google",
      displayName: "Google",
      selectable: true,
      automatedAvailable: true,
      models: [{ id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", capabilities: ["tool_use"] }],
    },
  ]);
});
```

Update `apps/daemon/src/workflows/orchestration-transport/policy.test.ts`:

```ts
expect(resolveTransportPlan("orca/google")).toEqual(["hidden_interactive", "human_review"]);
```

Update `apps/daemon/src/server.test.ts` connected-agent provider test by adding a sibling case:

```ts
it("GET /v1/model-providers exposes Antigravity when connected", async () => {
  const db = getDatabase();
  seedAgents(db);
  db.prepare(`UPDATE agents SET connected = 1 WHERE id = ?`).run("antigravity");

  const response = await server.inject({
    method: "GET",
    url: "/v1/model-providers",
    headers: AUTH_HEADERS,
  });

  expect(response.statusCode).toBe(200);
  const body = ListModelProvidersResponse.parse(JSON.parse(response.body));
  expect(body.providers.map((provider) => provider.id)).toEqual(["orca/google"]);
  expect(body.providers[0]?.models.map((model) => model.id)).toEqual([
    "gemini-3.5-flash",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-flash",
  ]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @orca/daemon test -- src/adapters/agent-adapters.test.ts src/orchestrator-llm/model-provider-llm-client.test.ts src/workflows/orchestration-transport/provider-catalog.test.ts src/workflows/orchestration-transport/policy.test.ts src/server.test.ts
pnpm --filter @orca/desktop test -- src/create-goal-flow/orchestratorDefaults.test.ts
```

Expected: FAIL because Google mappings do not exist.

- [ ] **Step 3: Add model catalog mappings**

Modify `apps/daemon/src/adapters/model-catalog.ts`:

```ts
export const PROVIDER_BY_AGENT_ID: Record<string, ModelProviderId | undefined> = {
  "claude-code": "orca/anthropic",
  codex: "orca/openai",
  antigravity: "orca/google",
};
```

Add:

```ts
antigravity: [
  {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    capabilities: ["reasoning", "long_context", "tool_use", "code_editing"],
  },
  {
    id: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro (high)",
    capabilities: ["reasoning", "long_context", "tool_use", "code_editing"],
  },
  {
    id: "gemini-3.1-pro-low",
    displayName: "Gemini 3.1 Pro (low)",
    capabilities: ["reasoning", "tool_use", "code_editing"],
  },
  {
    id: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    capabilities: ["fast", "tool_use", "code_editing"],
  },
],
```

- [ ] **Step 4: Add operator and provider routing**

Modify `apps/daemon/src/workflows/operators/registry.ts`:

```ts
const AGENT_CAPABILITIES: Record<string, string[]> = {
  "claude-code": ["repo_navigation", "architecture", "refactoring", "planning", "code_editing"],
  codex: ["implementation", "patching", "test_fixing", "code_editing"],
  antigravity: ["repo_navigation", "planning", "implementation", "test_fixing", "code_editing"],
};
```

Modify `adapterIdForProvider()` in `apps/daemon/src/orchestrator-llm/model-provider-llm-client.ts`:

```ts
export function adapterIdForProvider(providerId: ModelProviderId): string {
  switch (providerId) {
    case "orca/anthropic":
      return "claude-code";
    case "orca/openai":
      return "codex";
    case "orca/google":
      return "antigravity";
  }
}
```

Modify `PRODUCT_DISPLAY_NAMES` in `apps/daemon/src/workflows/orchestration-transport/provider-catalog.ts`:

```ts
const PRODUCT_DISPLAY_NAMES: Record<ModelProviderId, string> = {
  "orca/openai": "OpenAI",
  "orca/anthropic": "Claude",
  "orca/google": "Google",
};
```

Modify `buildOrchestrationProviderCatalog()` so virtual agent-backed providers from `modelOverrides` are included even when no direct API provider is registered:

```ts
  const direct = providers
    .filter((provider) => !allowedProviderIds || allowedProviderIds.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      displayName: PRODUCT_DISPLAY_NAMES[provider.id],
      selectable: true,
      automatedAvailable: provider.available,
      readinessReason: capReason(provider.reason),
      models: (modelOverrides?.get(provider.id) ?? provider.models).map((model) => ({
        id: model.id,
        displayName: model.displayName,
        capabilities: [...model.capabilities],
      }))
    }));

  const directIds = new Set(direct.map((provider) => provider.id));
  const virtual = [...(modelOverrides?.entries() ?? [])]
    .filter(([providerId]) => !directIds.has(providerId))
    .filter(([providerId]) => !allowedProviderIds || allowedProviderIds.has(providerId))
    .map(([providerId, models]) => ({
      id: providerId,
      displayName: PRODUCT_DISPLAY_NAMES[providerId],
      selectable: true as const,
      automatedAvailable: true,
      models: models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        capabilities: [...model.capabilities],
      })),
    }));

  return [...direct, ...virtual];
```

Modify `apps/daemon/src/workflows/orchestration-transport/policy.ts`:

```ts
export function resolveTransportPlan(
  providerId: ModelProviderId
): OrchestrationTransport[] {
  switch (providerId) {
    case "orca/openai":
      return ["one_shot", "hidden_interactive", "human_review"];
    case "orca/anthropic":
      return ["hidden_interactive", "human_review"];
    case "orca/google":
      return ["hidden_interactive", "human_review"];
  }
}
```

Modify `providerIdForAdapter()` so shadow providers own all agent-provider mappings:

```ts
function providerIdForAdapter(adapterId: string): ModelProviderId | undefined {
  if (adapterId !== "claude-code" && adapterId !== "codex" && adapterId !== "antigravity") return undefined;
  return resolveShadowProvider(adapterId as ShadowAdapterId).modelProviderId as ModelProviderId;
}
```

Modify `RoutedOrchestratorLlmClient.request()` in `apps/daemon/src/orchestrator-llm/model-provider-llm-client.ts`:

```ts
if (input.adapterId === "claude-code" || input.adapterId === "codex" || input.adapterId === "antigravity") {
  return this.shadowClient.request(input);
}
return this.providerClient.request(input);
```

- [ ] **Step 5: Add frontend default model**

Modify `apps/desktop/src/create-goal-flow/orchestratorDefaults.ts`:

```ts
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  "orca/anthropic": "claude-haiku-4-5",
  "orca/openai": "gpt-5.4-mini",
  "orca/google": "gemini-3.5-flash",
};
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/adapters/agent-adapters.test.ts src/workflows/operators/registry.test.ts src/orchestrator-llm/model-provider-llm-client.test.ts src/workflows/orchestration-transport/provider-catalog.test.ts src/workflows/orchestration-transport/policy.test.ts src/server.test.ts
pnpm --filter @orca/desktop test -- src/create-goal-flow/orchestratorDefaults.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/adapters/model-catalog.ts apps/daemon/src/adapters/agent-adapters.test.ts apps/daemon/src/workflows/operators/registry.ts apps/daemon/src/workflows/operators/registry.test.ts apps/daemon/src/orchestrator-llm/model-provider-llm-client.ts apps/daemon/src/orchestrator-llm/model-provider-llm-client.test.ts apps/daemon/src/workflows/orchestration-transport/provider-catalog.ts apps/daemon/src/workflows/orchestration-transport/provider-catalog.test.ts apps/daemon/src/workflows/orchestration-transport/policy.ts apps/daemon/src/workflows/orchestration-transport/policy.test.ts apps/daemon/src/server.test.ts apps/desktop/src/create-goal-flow/orchestratorDefaults.ts apps/desktop/src/create-goal-flow/orchestratorDefaults.test.ts
git commit -m "feat(daemon): add Antigravity model catalog"
```

---

### Task 5: Shadow Provider With Transcript-Backed Stop Hooks

**Files:**
- Create: `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`
- Create: `apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts`
- Modify: `apps/daemon/src/orchestrator-llm/providers/types.ts`
- Modify: `apps/daemon/src/orchestrator-llm/providers/registry.ts`
- Modify: `apps/daemon/src/orchestrator-llm/providers/registry.test.ts`
- Modify: `apps/daemon/src/shadow-hooks/routes.ts`
- Modify: `apps/daemon/src/shadow-hooks/routes.test.ts`
- Modify: `apps/daemon/src/orchestrator-llm/shadow-session.ts`
- Modify: `apps/daemon/src/orchestrator-llm/shadow-session.test.ts`

- [ ] **Step 1: Write failing shadow provider tests**

Create `apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AntigravityShadowProvider } from "./antigravity.js";

describe("AntigravityShadowProvider", () => {
  it("launches agy or override", () => {
    const provider = new AntigravityShadowProvider();
    expect(provider.launch({}).bin).toBe("agy");
    expect(provider.launch({ binOverride: "/bin/agy" }).bin).toBe("/bin/agy");
  });

  it("uses hook capture", () => {
    const provider = new AntigravityShadowProvider();
    expect(provider.captureMode()).toEqual({ kind: "hook" });
  });

  it("writes hooks.json and relay script under .agents", () => {
    const provider = new AntigravityShadowProvider();
    const cfg = provider.hookConfig({ goalId: "g1", port: 17333, authToken: "tok" });
    expect(cfg.files.map((f) => f.relPath).sort()).toEqual([
      ".agents/hooks.json",
      ".agents/orca-stop-hook.cjs",
    ]);
    const hooks = JSON.parse(cfg.files.find((f) => f.relPath === ".agents/hooks.json")!.contents);
    expect(hooks["orca-shadow-stop"].Stop[0].command).toBe("node .agents/orca-stop-hook.cjs");
    expect(cfg.files.find((f) => f.relPath === ".agents/orca-stop-hook.cjs")!.contents).toContain("transcriptPath");
  });

  it("parses orca action blocks", () => {
    const provider = new AntigravityShadowProvider();
    const parsed = provider.turnParser().parseAction('done\\n<orca:action>{"kind":"wait"}</orca:action>');
    expect(parsed).toBe('{"kind":"wait"}');
  });
});
```

Update `apps/daemon/src/orchestrator-llm/providers/registry.test.ts`:

```ts
it("returns the antigravity provider exposing the interface members", () => {
  const provider = resolveShadowProvider("antigravity");
  expect(provider.id).toBe("antigravity");
  expect(provider.modelProviderId).toBe("orca/google");
  expect(provider.captureMode()).toEqual({ kind: "hook" });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @orca/daemon test -- src/orchestrator-llm/providers/antigravity.test.ts src/orchestrator-llm/providers/registry.test.ts
```

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Extend shadow provider types and registry**

Modify `apps/daemon/src/orchestrator-llm/providers/types.ts`:

```ts
export type ShadowAdapterId = "claude-code" | "codex" | "antigravity";
```

Modify `apps/daemon/src/orchestrator-llm/providers/registry.ts`:

```ts
import { AntigravityShadowProvider } from "./antigravity.js";

const PROVIDERS: Record<ShadowAdapterId, ShadowProvider> = {
  "claude-code": new ClaudeShadowProvider(),
  codex: new CodexShadowProvider(),
  antigravity: new AntigravityShadowProvider(),
};
```

- [ ] **Step 4: Implement Antigravity shadow provider**

Create `apps/daemon/src/orchestrator-llm/providers/antigravity.ts`:

```ts
import { extractActionBlock } from "../sentinel.js";
import type {
  ShadowCaptureMode,
  ShadowHookConfig,
  ShadowLaunch,
  ShadowProvider,
  ShadowTurnParse,
} from "./types.js";

const AUTH_OR_QUOTA =
  /\bnot\s+(?:signed|logged)\s+in\b|\bauth(?:entication)?\s+(?:required|expired|failed)\b|\brate limit\b|\bquota\b|\busage limit\b/i;

export class AntigravityShadowProvider implements ShadowProvider {
  readonly id = "antigravity" as const;
  readonly displayName = "Antigravity";
  readonly modelProviderId = "orca/google";

  launch(deps: { binOverride?: string }): ShadowLaunch {
    return { bin: deps.binOverride ?? process.env["ORCA_ANTIGRAVITY_BIN"] ?? "agy" };
  }

  hookConfig(args: { goalId: string; port: number; authToken: string }): ShadowHookConfig {
    return {
      files: [
        {
          relPath: ".agents/hooks.json",
          contents: JSON.stringify(buildAntigravityHookSettings(), null, 2),
        },
        {
          relPath: ".agents/orca-stop-hook.cjs",
          contents: buildStopHookRelay(args),
        },
      ],
    };
  }

  captureMode(): ShadowCaptureMode {
    return { kind: "hook" };
  }

  turnParser(): ShadowTurnParse {
    return {
      parseAction: (turnText) => extractActionBlock(turnText),
      detectError: (turnText) => {
        if (AUTH_OR_QUOTA.test(turnText)) return new Error("antigravity auth, quota, or usage failure");
        return null;
      },
    };
  }
}

function buildAntigravityHookSettings(): unknown {
  return {
    "orca-shadow-stop": {
      Stop: [
        {
          type: "command",
          command: "node .agents/orca-stop-hook.cjs",
          timeout: 10,
        },
      ],
    },
  };
}

function buildStopHookRelay(args: { goalId: string; port: number; authToken: string }): string {
  const url = `http://127.0.0.1:${args.port}/v1/shadow-hooks/stop?goalId=${encodeURIComponent(args.goalId)}`;
  const token = args.authToken.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  return `const fs = require("node:fs");

const ORCA_URL = \`${url}\`;
const ORCA_TOKEN = \`${token}\`;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const failure = Boolean(input.error) || input.fullyIdle === false || input.terminationReason === "error";
    const text = failure ? String(input.error || input.terminationReason || "antigravity stop failure") : readLatestAssistantText(input.transcriptPath);
    const target = failure ? ORCA_URL + "&failure=1" : ORCA_URL;
    await fetch(target, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ORCA_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ last_assistant_message: text }),
    });
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  } catch (err) {
    await fetch(ORCA_URL + "&failure=1", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ORCA_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ last_assistant_message: err instanceof Error ? err.message : String(err) }),
    }).catch(() => undefined);
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  }
});

function readLatestAssistantText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  const rawTranscript = fs.readFileSync(transcriptPath, "utf8");
  const lines = rawTranscript.trim().split(/\\r?\\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const text = textFromEntry(entry);
      if (text) return text;
    } catch {
      continue;
    }
  }
  return "";
}

function textFromEntry(entry) {
  const candidates = [
    entry?.assistant,
    entry?.message,
    entry?.content,
    entry?.text,
    entry?.modelMessage,
    entry?.model_message,
  ];
  if (entry?.role && !/assistant|model/i.test(String(entry.role))) return "";
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (text) return text;
  }
  return "";
}

function normalizeText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join("\\n");
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return normalizeText(value.content);
    if (typeof value.message === "string") return value.message;
  }
  return "";
}
`;
}
```

- [ ] **Step 5: Preserve hook failure text**

Add a route test in `apps/daemon/src/shadow-hooks/routes.test.ts`:

```ts
it("passes hook failure text through to resolvePending", async () => {
  const calls: Array<{ goalId: string; result: { text: string; failure: boolean } }> = [];
  const server = Fastify();
  registerShadowHookRoutes(server, {
    resolvePending: (goalId, result) => calls.push({ goalId, result }),
  });
  const res = await server.inject({
    method: "POST",
    url: "/v1/shadow-hooks/stop?goalId=g1&failure=1",
    payload: { last_assistant_message: "quota exceeded" },
  });
  expect(res.statusCode).toBe(200);
  expect(calls).toEqual([{ goalId: "g1", result: { text: "quota exceeded", failure: true } }]);
});
```

Modify `apps/daemon/src/shadow-hooks/routes.ts` so the existing body parsing path remains:

```ts
const body = (request.body ?? {}) as { last_assistant_message?: string };
deps.resolvePending(goalId, {
  text: body.last_assistant_message ?? "",
  failure: q.failure === "1",
});
```

Modify `resolvePending()` in `apps/daemon/src/orchestrator-llm/shadow-session.ts`:

```ts
if (result.failure) {
  this.settlePending(goalId, pending, {
    error: new Error(result.text || "shadow orchestrator StopFailure"),
  });
  return;
}
```

- [ ] **Step 6: Add shadow-session binary override**

Modify `ShadowSessionDeps` in `apps/daemon/src/orchestrator-llm/shadow-session.ts`:

```ts
antigravityBin?: string;
```

Modify `binOverride()`:

```ts
const overrides: Record<ShadowAdapterId, string | undefined> = {
  "claude-code": this.deps.claudeBin,
  codex: this.deps.codexBin,
  antigravity: this.deps.antigravityBin,
};
```

- [ ] **Step 7: Run tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/orchestrator-llm/providers/antigravity.test.ts src/orchestrator-llm/providers/registry.test.ts src/orchestrator-llm/shadow-session.test.ts src/shadow-hooks/routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/providers/antigravity.ts apps/daemon/src/orchestrator-llm/providers/antigravity.test.ts apps/daemon/src/orchestrator-llm/providers/types.ts apps/daemon/src/orchestrator-llm/providers/registry.ts apps/daemon/src/orchestrator-llm/providers/registry.test.ts apps/daemon/src/shadow-hooks/routes.ts apps/daemon/src/shadow-hooks/routes.test.ts apps/daemon/src/orchestrator-llm/shadow-session.ts apps/daemon/src/orchestrator-llm/shadow-session.test.ts
git commit -m "feat(daemon): add Antigravity shadow provider"
```

---

### Task 6: Server And Orchestrator Wiring

**Files:**
- Modify: `apps/daemon/src/server.ts`
- Modify: `apps/daemon/src/orchestrator-llm/shadow-llm-client.ts`
- Modify: `apps/daemon/src/orchestrator-chat/usecases.ts`
- Modify: `apps/daemon/src/server.test.ts`
- Modify: `apps/daemon/src/orchestrator-llm/shadow-llm-client.test.ts`
- Modify: `apps/daemon/src/orchestrator-chat/usecases.test.ts`

- [ ] **Step 1: Write failing routing tests**

Update `apps/daemon/src/orchestrator-llm/shadow-llm-client.test.ts`:

```ts
it("passes antigravity adapter id through to the manager", async () => {
  const calls: Array<{ input: { adapterId?: string } }> = [];
  const client = new ShadowSessionOrchestratorLlmClient({
    ask: async (_goalId, input) => {
      calls.push({ input });
      return { text: '{"kind":"wait"}' };
    },
  });
  await client.request({
    goalId: "g",
    adapterId: "antigravity",
    modelId: "gemini-3.5-flash",
    systemPrompt: "s",
    userPrompt: "u",
  });
  expect(calls[0].input.adapterId).toBe("antigravity");
});
```

Update server tests that assert provider branching to include:

```ts
expect(adapterIdForProvider("orca/google")).toBe("antigravity");
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @orca/daemon test -- src/orchestrator-llm/shadow-llm-client.test.ts src/orchestrator-chat/usecases.test.ts src/server.test.ts
```

Expected: FAIL where code narrows all non-Codex adapters to Claude.

- [ ] **Step 3: Preserve Antigravity adapter ids**

Modify `apps/daemon/src/orchestrator-llm/shadow-llm-client.ts`:

```ts
adapterId: input.adapterId === "codex" || input.adapterId === "antigravity" ? input.adapterId : "claude-code",
```

Modify `apps/daemon/src/orchestrator-chat/usecases.ts`:

```ts
function toShadowAdapterId(providerId: ModelProviderId): ShadowAdapterId {
  const adapterId = adapterIdForProvider(providerId);
  if (adapterId === "codex" || adapterId === "antigravity") return adapterId;
  return "claude-code";
}
```

Modify `apps/daemon/src/server.ts` shadow-session construction:

```ts
antigravityBin: process.env["ORCA_ANTIGRAVITY_BIN"] ?? "agy",
```

Replace provider-to-shadow ternaries:

```ts
shadowSessions.spawn(goalId, adapterId === "codex" ? "codex" : "claude-code")
```

with:

```ts
shadowSessions.spawn(goalId, adapterId === "codex" || adapterId === "antigravity" ? adapterId : "claude-code")
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/orchestrator-llm/shadow-llm-client.test.ts src/orchestrator-chat/usecases.test.ts src/server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/orchestrator-llm/shadow-llm-client.ts apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/server.test.ts apps/daemon/src/orchestrator-llm/shadow-llm-client.test.ts apps/daemon/src/orchestrator-chat/usecases.test.ts
git commit -m "feat(daemon): route Antigravity shadow sessions"
```

---

### Task 7: Optional Real CLI Smoke

**Files:**
- Create: `apps/daemon/src/adapters/antigravity.auth-smoke.test.ts`

- [ ] **Step 1: Add gated smoke test**

Create `apps/daemon/src/adapters/antigravity.auth-smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AntigravityAdapter } from "./antigravity.js";

const runReal = process.env.ORCA_RUN_REAL_SMOKE === "1";

describe.skipIf(!runReal)("Antigravity real auth smoke", () => {
  it("checks installed and auth status against the real agy CLI", async () => {
    const adapter = new AntigravityAdapter();
    const installed = await adapter.checkInstalled();
    expect(installed.ok).toBe(true);
    const auth = await adapter.checkAuth();
    expect(["ready", "needs_auth", "misconfigured"]).toContain(auth.authStatus);
  });
});
```

- [ ] **Step 2: Run skipped smoke**

Run:

```bash
pnpm --filter @orca/daemon test -- src/adapters/antigravity.auth-smoke.test.ts
```

Expected: PASS with the suite skipped unless `ORCA_RUN_REAL_SMOKE=1`.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/adapters/antigravity.auth-smoke.test.ts
git commit -m "test(daemon): add Antigravity auth smoke"
```

---

### Task 8: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run package tests**

Run:

```bash
pnpm --filter @orca/contracts test
pnpm --filter @orca/daemon test
pnpm --filter @orca/desktop test
```

Expected: all tests pass.

- [ ] **Step 2: Run typechecks**

Run:

```bash
pnpm --filter @orca/contracts typecheck
pnpm --filter @orca/daemon typecheck
pnpm --filter @orca/desktop typecheck
```

Expected: all typechecks pass.

- [ ] **Step 3: Run builds**

Run:

```bash
pnpm --filter @orca/contracts build
pnpm --filter @orca/daemon build
pnpm --filter @orca/desktop build
```

Expected: all builds pass.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git log --oneline --max-count=8
```

Expected: worktree is clean after commits, and recent commits show the Antigravity implementation tasks.
