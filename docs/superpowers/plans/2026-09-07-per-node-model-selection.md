# Per-node model selection & CLI-derived model catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a workflow node's model choice real — authored per node, resolved against the model catalog the installed CLI actually ships, and delivered to the spawned process instead of being recorded and discarded.

**Architecture:** A node authors either a pinned `{modelId, contextVariant, effort}` triple or a reference to a requirement profile; both resolve to one `ResolvedModelChoice` before dispatch. Model metadata is extracted from the installed claude-code bundle, cached by CLI version, and falls back to a checked-in seed. The resolved choice is persisted on the session row so it survives the create-then-start hop, then translated to per-adapter spawn args.

**Tech Stack:** TypeScript, zod (contracts), better-sqlite3 (daemon), vitest, React (desktop).

**Spec:** `docs/superpowers/specs/2026-09-07-per-node-model-selection-design.md`

## Global Constraints

- **No migration for template JSON.** Legacy `{adapterId, modelId}` entries must keep parsing via a zod `.transform`. `loadRunTemplate` re-parses `template_snapshot_json` for every in-flight run; a required new field would throw on history that append-only rules forbid rewriting.
- **Effort is never left unset on an adapter that has one.** Resolution fills it from the model's catalog `default_effort`. `ResolvedModelChoice.effort` is null only for an adapter with no effort axis (antigravity).
- **Always pass both `--model` and `--effort`.** Passing `--model` alone leaves the ambient `~/.claude/settings.json` `effortLevel` governing.
- **No silent fall-through to ambient host config.** If no model resolves, dispatch fails loudly. `resolveStepDispatch` already throws `no ready agent`; that stays.
- **`advisor_rank` is for ordering only** — never an absolute score, never surfaced to the user as one.
- **Catalog source is always visible**: `"extracted" | "cached" | "seed"`. A stale catalog is shown as stale, never presented as current.
- **v1 scope:** claude-code gets picker + effort + extraction. codex/antigravity get the spawn plumbing and a hand-listed id set, no effort UI.
- Migrations live in `apps/daemon/migrations/NNNN_name.sql` and must be registered in the `migrationFiles` array in `apps/daemon/src/migrations.ts`. The latest is `0066_step_run_blocked_code.sql`.
- Test commands: `pnpm --filter @orca/contracts exec vitest run <file>`, `pnpm --filter @orca/daemon exec vitest run <file>`, `pnpm --filter @orca/desktop exec vitest run <file>`.

---

### Task 1: Effort and resolved-choice contracts

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts:278-285`
- Test: `packages/contracts/src/workflows/model-selection.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `EffortLevel`, `ResolvedModelChoice`, `NodeModelSelection`, and a `StepAgentChoice` that accepts both legacy and new shapes. Every later task imports these from `@orca/contracts`.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/workflows/model-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EffortLevel, NodeModelSelection, StepAgentChoice } from "./index.js";

describe("EffortLevel", () => {
  it("accepts the five levels the CLI exposes", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(EffortLevel.parse(level)).toBe(level);
    }
  });

  it("rejects ultracode, which is a UI combination and not a level", () => {
    expect(() => EffortLevel.parse("ultracode")).toThrow();
  });
});

describe("StepAgentChoice legacy transform", () => {
  it("reads a legacy pair as a pinned choice with a default variant", () => {
    const parsed = StepAgentChoice.parse({ adapterId: "claude-code", modelId: "claude-haiku-4-5" });
    expect(parsed).toEqual({
      kind: "pinned",
      adapterId: "claude-code",
      modelId: "claude-haiku-4-5",
      contextVariant: "default",
      effort: null,
    });
  });

  it("preserves providerId when a legacy pair carries one", () => {
    const parsed = StepAgentChoice.parse({
      adapterId: "codex", modelId: "gpt-5.5", providerId: "orca/openai",
    });
    expect(parsed).toMatchObject({ kind: "pinned", providerId: "orca/openai" });
  });

  it("accepts an explicit pinned choice with a variant and effort", () => {
    const parsed = StepAgentChoice.parse({
      kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5",
      contextVariant: "1m", effort: "xhigh",
    });
    expect(parsed).toMatchObject({ contextVariant: "1m", effort: "xhigh" });
  });

  it("accepts a profile reference", () => {
    expect(StepAgentChoice.parse({ kind: "profile", ref: "deep-reasoning" }))
      .toEqual({ kind: "profile", ref: "deep-reasoning" });
  });

  it("rejects a profile reference with an empty ref", () => {
    expect(() => StepAgentChoice.parse({ kind: "profile", ref: "" })).toThrow();
  });
});

describe("NodeModelSelection", () => {
  it("rejects an unknown kind", () => {
    expect(() => NodeModelSelection.parse({ kind: "auto" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts exec vitest run src/workflows/model-selection.test.ts`
Expected: FAIL — `EffortLevel` and `NodeModelSelection` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/contracts/src/workflows/index.ts`, replace the `StepAgentChoice` block at lines 278-285 with:

```ts
export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const ContextVariant = z.enum(["default", "1m"]);
export type ContextVariant = z.infer<typeof ContextVariant>;

/** A node's model choice, fully specified. */
export const PinnedModelChoice = z
  .object({
    kind: z.literal("pinned"),
    adapterId: AdapterId,
    modelId: z.string().min(1).max(80),
    contextVariant: ContextVariant.default("default"),
    // Nullable by necessity: every legacy entry has no effort, and resolution
    // fills it from the model's catalog default_effort. See Global Constraints.
    effort: EffortLevel.nullable().default(null),
    providerId: ModelProviderId.optional(),
  })
  .strict();

export const ProfileModelChoice = z
  .object({ kind: z.literal("profile"), ref: z.string().min(1).max(80) })
  .strict();

export const NodeModelSelection = z.discriminatedUnion("kind", [
  PinnedModelChoice,
  ProfileModelChoice,
]);
export type NodeModelSelection = z.infer<typeof NodeModelSelection>;

/**
 * Legacy `{adapterId, modelId}` entries predate the union and are still present
 * in every stored template_snapshot_json. Preprocess rather than migrate: those
 * snapshots are append-only history and re-parsed on every in-flight run.
 */
export const StepAgentChoice = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && !("kind" in raw)) {
    return { ...(raw as Record<string, unknown>), kind: "pinned" };
  }
  return raw;
}, NodeModelSelection);
export type StepAgentChoice = z.infer<typeof StepAgentChoice>;

/** What actually runs, and what gets recorded. */
export const ResolvedModelChoice = z
  .object({
    adapterId: AdapterId,
    modelId: z.string().min(1).max(80),
    contextVariant: ContextVariant,
    effort: EffortLevel.nullable(),
  })
  .strict();
export type ResolvedModelChoice = z.infer<typeof ResolvedModelChoice>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/contracts exec vitest run src/workflows/model-selection.test.ts`
Expected: PASS (7 tests)

Then run the whole contracts suite — `StepAgentChoice` is referenced by template, graph and step-template tests:

Run: `pnpm --filter @orca/contracts exec vitest run`
Expected: PASS. Existing tests pass legacy pairs and now receive the pinned shape back; if an assertion uses `toEqual` on a raw pair it must be updated to the pinned shape. Do not weaken an assertion to `toMatchObject` to avoid the change — update it to the real expected value.

- [ ] **Step 5: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: daemon and desktop errors wherever `pref.adapterId` / `pref.modelId` are read off a union member. Do **not** fix them here — Task 10 owns the dispatch reads and Task 13 the UI. If the error count is large, add a temporary narrowing helper in this task:

```ts
/** Narrow to the pinned arm; profiles are resolved in the daemon (Task 6). */
export function asPinned(choice: StepAgentChoice) {
  return choice.kind === "pinned" ? choice : null;
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/workflows/model-selection.test.ts
git commit -m "feat(contracts): a node's model choice carries its context variant and effort"
```

---

### Task 2: Catalog types and the checked-in seed

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (add `CatalogModel`)
- Create: `apps/daemon/src/adapters/model-catalog/types.ts`
- Create: `apps/daemon/src/adapters/model-catalog/seed.ts`
- Test: `apps/daemon/src/adapters/model-catalog/seed.test.ts`

**Why `CatalogModel` lives in contracts:** the desktop renders the picker from
the same shape the daemon extracts, and the desktop cannot import from the
daemon. Defining it in the daemon would force Task 13 to redeclare it, which is
how the two drift.

**Interfaces:**
- Consumes: `EffortLevel` from Task 1.
- Produces: `CatalogModel` (the shape every later task reads), `PricingTier` ordering via `pricingRank`, and `SEED_CATALOG: Record<AdapterId, CatalogModel[]>`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/model-catalog/seed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SEED_CATALOG } from "./seed.js";
import { pricingRank } from "./types.js";

describe("pricingRank", () => {
  it("orders a cheaper tier below a dearer one", () => {
    expect(pricingRank("tier_5_25")).toBeLessThan(pricingRank("tier_10_50"));
  });

  it("breaks a tie on input price using the output price", () => {
    expect(pricingRank("tier_5_25")).toBeLessThan(pricingRank("tier_5_40"));
  });

  it("sorts an unparseable tier last rather than assuming it is cheap", () => {
    expect(pricingRank("mystery")).toBeGreaterThan(pricingRank("tier_10_50"));
  });
});

describe("SEED_CATALOG", () => {
  it("carries every adapter", () => {
    expect(Object.keys(SEED_CATALOG).sort()).toEqual(["antigravity", "claude-code", "codex"]);
  });

  it("marks a claude model that accepts the 1m suffix", () => {
    const opus = SEED_CATALOG["claude-code"].find((m) => m.id === "claude-opus-5");
    expect(opus?.supports1mSuffix).toBe(true);
    expect(opus?.contextWindow).toBe(1_000_000);
  });

  it("gives every claude model a default effort, since the adapter has an effort axis", () => {
    for (const model of SEED_CATALOG["claude-code"]) {
      expect(model.defaultEffort).not.toBeNull();
    }
  });

  it("gives codex and antigravity models no supported efforts in v1", () => {
    for (const model of [...SEED_CATALOG.codex, ...SEED_CATALOG.antigravity]) {
      expect(model.supportedEfforts).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

First add to `packages/contracts/src/workflows/index.ts`, after `ResolvedModelChoice`:

```ts
/**
 * One model as Orca understands it. Field names are Orca's; the claude-code
 * extractor (Task 4) maps the bundle's snake_case onto them so no other module
 * depends on the bundle's shape.
 */
export const CatalogModel = z
  .object({
    id: z.string().min(1).max(80),
    family: z.string().max(40),
    displayName: z.string().min(1).max(80),
    contextWindow: z.number().int().nonnegative(),
    supports1mSuffix: z.boolean(),
    /** Provider pricing tier string, e.g. "tier_5_25". Null where unknown. */
    pricingTier: z.string().max(40).nullable(),
    /** Higher is stronger. ORDERING ONLY — never an absolute score. */
    advisorRank: z.number().nullable(),
    supportedEfforts: z.array(EffortLevel),
    defaultEffort: EffortLevel.nullable(),
  })
  .strict();
export type CatalogModel = z.infer<typeof CatalogModel>;
```

Then create `apps/daemon/src/adapters/model-catalog/types.ts`:

```ts
export type { CatalogModel } from "@orca/contracts";

const UNPARSEABLE = Number.MAX_SAFE_INTEGER;

/**
 * Rank a pricing tier for comparison. "tier_5_25" is $5/$25 per Mtok, so the
 * input price leads and the output price breaks ties. An unparseable tier sorts
 * LAST: excluded from a budget-bounded profile rather than assumed cheap.
 */
export function pricingRank(tier: string | null): number {
  if (!tier) return UNPARSEABLE;
  const m = /^tier_(\d+)_(\d+)$/.exec(tier);
  if (!m) return UNPARSEABLE;
  return Number(m[1]) * 1000 + Number(m[2]);
}
```

Create `apps/daemon/src/adapters/model-catalog/seed.ts`:

```ts
import type { AdapterId } from "@orca/contracts";
import type { CatalogModel } from "./types.js";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Last-resort fallback when extraction fails and no cache exists. Deliberately
 * small: this is a floor that keeps dispatch working, not a catalog to maintain.
 * The extractor (Task 4) supersedes it whenever the CLI is readable.
 */
export const SEED_CATALOG: Record<AdapterId, CatalogModel[]> = {
  "claude-code": [
    { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
      supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
      supportedEfforts: [...CLAUDE_EFFORTS], defaultEffort: "high" },
    { id: "claude-sonnet-5", family: "sonnet", displayName: "Sonnet 5", contextWindow: 1_000_000,
      supports1mSuffix: true, pricingTier: "tier_3_15", advisorRank: 3,
      supportedEfforts: [...CLAUDE_EFFORTS], defaultEffort: "high" },
    { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
      supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
      supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
  ],
  codex: [
    { id: "gpt-5.5", family: "gpt-5", displayName: "GPT-5.5", contextWindow: 400_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
    { id: "gpt-5.3-codex", family: "gpt-5-codex", displayName: "GPT-5.3 Codex", contextWindow: 400_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
    { id: "gpt-5.4-mini", family: "gpt-5-mini", displayName: "GPT-5.4 mini", contextWindow: 400_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
  ],
  antigravity: [
    { id: "gemini-3.5-flash", family: "gemini", displayName: "Gemini 3.5 Flash", contextWindow: 1_000_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
    { id: "gemini-3.1-pro-high", family: "gemini", displayName: "Gemini 3.1 Pro (high)", contextWindow: 1_000_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null,
      supportedEfforts: [], defaultEffort: null },
  ],
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/seed.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/model-catalog/
git commit -m "feat(daemon): a model catalog seed that is a floor, not a list to maintain"
```

---

### Task 3: The minified-JS record parser

The bundle's records are JavaScript object literals, not JSON: unquoted keys, `!0` for `true`, `1e6` numerics. A regex over the whole blob would corrupt any string value containing a brace or a `key:` sequence, so this walks characters and respects string literals.

**Files:**
- Create: `apps/daemon/src/adapters/model-catalog/parse-records.ts`
- Test: `apps/daemon/src/adapters/model-catalog/parse-records.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractObjectLiterals(haystack: string, startMarker: string): string[]` and `jsLiteralToJson(src: string): unknown`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/model-catalog/parse-records.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractObjectLiterals, jsLiteralToJson } from "./parse-records.js";

describe("extractObjectLiterals", () => {
  it("returns a balanced literal starting at the marker", () => {
    const out = extractObjectLiterals('noise{id:"claude-a",n:{x:1}}tail', '{id:"claude-');
    expect(out).toEqual(['{id:"claude-a",n:{x:1}}']);
  });

  it("finds every occurrence", () => {
    const out = extractObjectLiterals('{id:"claude-a"},{id:"claude-b"}', '{id:"claude-');
    expect(out).toHaveLength(2);
  });

  it("ignores braces inside string values", () => {
    const out = extractObjectLiterals('{id:"claude-a",d:"a}b{c"}', '{id:"claude-');
    expect(out).toEqual(['{id:"claude-a",d:"a}b{c"}']);
  });

  it("ignores an escaped quote inside a string value", () => {
    const out = extractObjectLiterals('{id:"claude-a",d:"say \\"hi\\""}', '{id:"claude-');
    expect(out).toEqual(['{id:"claude-a",d:"say \\"hi\\""}']);
  });

  it("drops an unterminated literal rather than returning a truncated one", () => {
    expect(extractObjectLiterals('{id:"claude-a",n:{x:1}', '{id:"claude-')).toEqual([]);
  });

  it("returns empty when the marker is absent", () => {
    expect(extractObjectLiterals("nothing here", '{id:"claude-')).toEqual([]);
  });
});

describe("jsLiteralToJson", () => {
  it("quotes unquoted keys", () => {
    expect(jsLiteralToJson('{id:"a",family:"opus"}')).toEqual({ id: "a", family: "opus" });
  });

  it("reads the minified booleans", () => {
    expect(jsLiteralToJson("{a:!0,b:!1}")).toEqual({ a: true, b: false });
  });

  it("reads exponent numerics", () => {
    expect(jsLiteralToJson("{window:1e6}")).toEqual({ window: 1_000_000 });
  });

  it("does not rewrite a key-like sequence inside a string value", () => {
    expect(jsLiteralToJson('{d:"note: careful",e:1}')).toEqual({ d: "note: careful", e: 1 });
  });

  it("handles nested objects and arrays", () => {
    expect(jsLiteralToJson('{c:{w:1e6,n:!0},caps:["effort","max_effort"]}'))
      .toEqual({ c: { w: 1_000_000, n: true }, caps: ["effort", "max_effort"] });
  });

  it("returns null for a literal it cannot convert", () => {
    expect(jsLiteralToJson("{a:(function(){})()}")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/parse-records.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/daemon/src/adapters/model-catalog/parse-records.ts`:

```ts
/**
 * Walk from `start`, returning the balanced `{...}` slice or null if it never
 * closes. String literals are tracked so a brace inside a value cannot end the
 * object early — the reason this is a scanner and not a regex.
 */
function balancedSlice(src: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

export function extractObjectLiterals(haystack: string, startMarker: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(startMarker, from);
    if (at === -1) return out;
    const slice = balancedSlice(haystack, at);
    if (slice) { out.push(slice); from = at + slice.length; }
    else from = at + startMarker.length;
  }
}

/**
 * Convert a JS object literal to JSON, then parse it. Rewrites happen only
 * outside string literals: unquoted keys gain quotes, `!0`/`!1` become
 * booleans. Returns null when the result is not valid JSON — a literal using
 * any other JS syntax is skipped rather than guessed at.
 */
export function jsLiteralToJson(src: string): unknown {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += src[++i] ?? ""; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += '"'; continue; }
    if (ch === "!" && (src[i + 1] === "0" || src[i + 1] === "1")) {
      out += src[i + 1] === "0" ? "true" : "false";
      i++;
      continue;
    }
    // An identifier in key position: quote it. Anything else falls through.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (src[j] === ":") { out += `"${word}"`; i = j - 1; continue; }
      out += word;
      i = j - 1;
      continue;
    }
    out += ch;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
```

Note the `!0`/`!1` mapping: `!0` is `true` and `!1` is `false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/parse-records.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/model-catalog/parse-records.ts apps/daemon/src/adapters/model-catalog/parse-records.test.ts
git commit -m "feat(daemon): a scanner that reads the bundle's object literals without a regex"
```

---

### Task 4: The claude-code catalog extractor

**Files:**
- Create: `apps/daemon/src/adapters/model-catalog/extract-claude.ts`
- Create: `apps/daemon/src/adapters/model-catalog/__fixtures__/claude-2.1.263-records.txt`
- Test: `apps/daemon/src/adapters/model-catalog/extract-claude.test.ts`

**Interfaces:**
- Consumes: `extractObjectLiterals`, `jsLiteralToJson` (Task 3); `CatalogModel` (Task 2).
- Produces: `parseClaudeCatalog(blob: string): CatalogModel[]` and `extractClaudeCatalog(binaryPath: string): Promise<CatalogModel[]>`.

- [ ] **Step 1: Capture the fixture from the installed CLI**

```bash
mkdir -p apps/daemon/src/adapters/model-catalog/__fixtures__
CLAUDE_BIN="$(readlink -f "$(which claude)" 2>/dev/null || which claude)"
strings -a "$CLAUDE_BIN" \
  | grep -o '{id:"claude-[a-z0-9-]*",family:.\{0,1200\}' \
  | head -40 > apps/daemon/src/adapters/model-catalog/__fixtures__/claude-2.1.263-records.txt
wc -l apps/daemon/src/adapters/model-catalog/__fixtures__/claude-2.1.263-records.txt
```

Expected: a non-empty file containing records for `claude-opus-5`, `claude-fable-5-1` and others. If it is empty the CLI layout changed — stop and report rather than inventing a fixture.

- [ ] **Step 2: Write the failing test**

Create `apps/daemon/src/adapters/model-catalog/extract-claude.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCatalog } from "./extract-claude.js";

const FIXTURE = readFileSync(
  join(__dirname, "__fixtures__", "claude-2.1.263-records.txt"),
  "utf8",
);

// A single record copied verbatim from the 2.1.263 bundle.
const OPUS_5 =
  '{id:"claude-opus-5",family:"opus",display_name:"Opus 5",knowledge_cutoff:"May 2026",' +
  'context:{window:1e6,native_1m:!0,supports_1m_beta:!0,supports_1m_suffix:!0},' +
  'max_output_tokens:{default:64000,upper:128000},pricing:"tier_5_25",' +
  'capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking"],' +
  'default_effort:"high",effort_cost_index:{low:0.67,medium:0.76,high:1,xhigh:1.6,max:1.7},' +
  "advisor_rank:4}";

describe("parseClaudeCatalog", () => {
  it("maps the bundle's snake_case onto the Orca shape", () => {
    const [model] = parseClaudeCatalog(OPUS_5);
    expect(model).toEqual({
      id: "claude-opus-5",
      family: "opus",
      displayName: "Opus 5",
      contextWindow: 1_000_000,
      supports1mSuffix: true,
      pricingTier: "tier_5_25",
      advisorRank: 4,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
  });

  it("derives supported efforts from the capability flags", () => {
    const noXhigh = OPUS_5.replace('"xhigh_effort",', "").replace('"max_effort",', "");
    const [model] = parseClaudeCatalog(noXhigh);
    expect(model.supportedEfforts).toEqual(["low", "medium", "high"]);
  });

  it("reports no supported efforts when the model lacks the effort capability", () => {
    const noEffort = OPUS_5.replace(
      'capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking"]',
      'capabilities:["adaptive_thinking"]',
    );
    expect(parseClaudeCatalog(noEffort)[0].supportedEfforts).toEqual([]);
  });

  it("finds the real models in the captured bundle fixture", () => {
    const ids = parseClaudeCatalog(FIXTURE).map((m) => m.id);
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-fable-5-1");
  });

  it("gives every model in the fixture a display name", () => {
    for (const model of parseClaudeCatalog(FIXTURE)) {
      expect(model.displayName.length).toBeGreaterThan(0);
    }
  });

  it("returns empty for a blob with no records rather than throwing", () => {
    expect(parseClaudeCatalog("no records here")).toEqual([]);
  });

  it("skips a record missing an id instead of emitting a partial model", () => {
    expect(parseClaudeCatalog('{id:"claude-",family:"x"}')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/extract-claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

Create `apps/daemon/src/adapters/model-catalog/extract-claude.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EffortLevel } from "@orca/contracts";
import { extractObjectLiterals, jsLiteralToJson } from "./parse-records.js";
import type { CatalogModel } from "./types.js";

const execFileAsync = promisify(execFile);
const RECORD_MARKER = '{id:"claude-';
const STRINGS_MAX_BUFFER = 512 * 1024 * 1024;

interface RawRecord {
  id?: unknown;
  family?: unknown;
  display_name?: unknown;
  pricing?: unknown;
  advisor_rank?: unknown;
  default_effort?: unknown;
  capabilities?: unknown;
  context?: { window?: unknown; supports_1m_suffix?: unknown };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Effort support is declared by capability flag, not by an explicit list:
 * "effort" unlocks low/medium/high, then xhigh and max are gated separately.
 */
function effortsFrom(capabilities: unknown): EffortLevel[] {
  if (!Array.isArray(capabilities)) return [];
  const caps = new Set(capabilities.filter((c): c is string => typeof c === "string"));
  if (!caps.has("effort")) return [];
  const out: EffortLevel[] = ["low", "medium", "high"];
  if (caps.has("xhigh_effort")) out.push("xhigh");
  if (caps.has("max_effort")) out.push("max");
  return out;
}

export function parseClaudeCatalog(blob: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const literal of extractObjectLiterals(blob, RECORD_MARKER)) {
    const raw = jsLiteralToJson(literal) as RawRecord | null;
    if (!raw) continue;
    const id = str(raw.id);
    const displayName = str(raw.display_name);
    // A record without both is a partial or a decoy, not a model.
    if (!id || id === "claude-" || !displayName || seen.has(id)) continue;
    seen.add(id);
    const effort = str(raw.default_effort);
    out.push({
      id,
      family: str(raw.family) ?? "",
      displayName,
      contextWindow: typeof raw.context?.window === "number" ? raw.context.window : 0,
      supports1mSuffix: raw.context?.supports_1m_suffix === true,
      pricingTier: str(raw.pricing),
      advisorRank: typeof raw.advisor_rank === "number" ? raw.advisor_rank : null,
      supportedEfforts: effortsFrom(raw.capabilities),
      defaultEffort: (effort as EffortLevel | null) ?? null,
    });
  }
  return out;
}

/**
 * Read the catalog out of an installed claude-code binary. Returns [] on any
 * failure — the caller (Task 5) falls back to cache then seed, so a changed
 * bundle degrades visibly rather than throwing on a boot path.
 */
export async function extractClaudeCatalog(binaryPath: string): Promise<CatalogModel[]> {
  try {
    const { stdout } = await execFileAsync("strings", ["-a", binaryPath], {
      maxBuffer: STRINGS_MAX_BUFFER,
    });
    return parseClaudeCatalog(stdout);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/extract-claude.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/adapters/model-catalog/extract-claude.ts apps/daemon/src/adapters/model-catalog/extract-claude.test.ts apps/daemon/src/adapters/model-catalog/__fixtures__/
git commit -m "feat(daemon): read the model catalog the claude bundle already ships"
```

---

### Task 5: Version-keyed cache and the resolution chain

**Files:**
- Create: `apps/daemon/migrations/0067_model_catalog_cache.sql`
- Modify: `apps/daemon/src/migrations.ts:81` (append to `migrationFiles`)
- Create: `apps/daemon/src/adapters/model-catalog/store.ts`
- Test: `apps/daemon/src/adapters/model-catalog/store.test.ts`

**Interfaces:**
- Consumes: `CatalogModel` (Task 2), `extractClaudeCatalog` (Task 4).
- Produces: `loadCatalog(db, adapterId, deps): Promise<{ models: CatalogModel[]; source: CatalogSource; adapterVersion: string | null }>` where `CatalogSource = "extracted" | "cached" | "seed"`.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0067_model_catalog_cache.sql`:

```sql
-- 0067_model_catalog_cache.sql
-- The model catalog read out of an installed agent CLI, keyed by that CLI's
-- version string.
--
-- Keyed by version because the catalog is a property OF a version, not of the
-- machine: re-reading a 199 MB binary on every boot to learn nothing is waste,
-- and a version that has not changed cannot have gained a model.
--
-- This is a cache and never a source of truth. A row is written only from a
-- successful extraction. When extraction fails the reader falls back to the
-- newest row here and then to the checked-in seed, and reports WHICH of the
-- three it used — a stale catalog must be visible as stale, since silently
-- serving last week's models as current is the failure this table risks.
CREATE TABLE model_catalog_cache (
  adapter_id      TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  extracted_at    TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  PRIMARY KEY (adapter_id, adapter_version)
);
```

Register it in `apps/daemon/src/migrations.ts` by appending to `migrationFiles` after `"0066_step_run_blocked_code.sql",`:

```ts
  "0067_model_catalog_cache.sql",
```

- [ ] **Step 2: Write the failing test**

Create `apps/daemon/src/adapters/model-catalog/store.test.ts`:

```ts
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_CATALOG } from "./seed.js";
import { loadCatalog, readCachedCatalog } from "./store.js";
import type { CatalogModel } from "./types.js";

const MODEL: CatalogModel = {
  id: "claude-fable-5-1", family: "fable", displayName: "Fable 5.1",
  contextWindow: 1_000_000, supports1mSuffix: true, pricingTier: "tier_10_50",
  advisorRank: 5, supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "high",
};

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE model_catalog_cache (
    adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
    extracted_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (adapter_id, adapter_version))`);
  return db;
}

describe("loadCatalog", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("extracts and caches when the version is unseen", async () => {
    const extract = vi.fn().mockResolvedValue([MODEL]);
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.1.263", extract, now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("extracted");
    expect(got.models).toEqual([MODEL]);
    expect(readCachedCatalog(db, "claude-code", "2.1.263")).toEqual([MODEL]);
  });

  it("does not re-extract a version already cached", async () => {
    const extract = vi.fn().mockResolvedValue([MODEL]);
    const deps = { version: async () => "2.1.263", extract, now: () => "2026-09-07T00:00:00Z" };
    await loadCatalog(db, "claude-code", deps);
    const second = await loadCatalog(db, "claude-code", deps);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(second.source).toBe("cached");
  });

  it("re-extracts when the version changes", async () => {
    const extract = vi.fn().mockResolvedValue([MODEL]);
    const now = () => "2026-09-07T00:00:00Z";
    await loadCatalog(db, "claude-code", { version: async () => "2.1.263", extract, now });
    const upgraded = await loadCatalog(db, "claude-code", { version: async () => "2.2.0", extract, now });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(upgraded.source).toBe("extracted");
  });

  it("falls back to the newest cached row when extraction returns nothing", async () => {
    const now = () => "2026-09-07T00:00:00Z";
    await loadCatalog(db, "claude-code", { version: async () => "2.1.263", extract: async () => [MODEL], now });
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.2.0", extract: async () => [], now,
    });
    expect(got.source).toBe("cached");
    expect(got.models).toEqual([MODEL]);
  });

  it("falls back to the seed when extraction fails and nothing is cached", async () => {
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.1.263", extract: async () => [], now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("seed");
    expect(got.models).toEqual(SEED_CATALOG["claude-code"]);
  });

  it("falls back to the seed when the version cannot be read at all", async () => {
    const got = await loadCatalog(db, "claude-code", {
      version: async () => null, extract: async () => [MODEL], now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("seed");
  });

  it("serves the seed for an adapter with no extractor", async () => {
    const got = await loadCatalog(db, "codex", {
      version: async () => "1.0.0", extract: async () => [], now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("seed");
    expect(got.models).toEqual(SEED_CATALOG.codex);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

Create `apps/daemon/src/adapters/model-catalog/store.ts`:

```ts
import type Database from "better-sqlite3";
import type { AdapterId } from "@orca/contracts";
import { SEED_CATALOG } from "./seed.js";
import type { CatalogModel } from "./types.js";

export type CatalogSource = "extracted" | "cached" | "seed";

export interface LoadCatalogDeps {
  /** The installed CLI's version string, or null when it cannot be read. */
  version: () => Promise<string | null>;
  extract: () => Promise<CatalogModel[]>;
  now: () => string;
}

export interface LoadedCatalog {
  models: CatalogModel[];
  source: CatalogSource;
  adapterVersion: string | null;
}

export function readCachedCatalog(
  db: Database.Database,
  adapterId: AdapterId,
  version: string,
): CatalogModel[] | null {
  const row = db
    .prepare("SELECT payload_json FROM model_catalog_cache WHERE adapter_id=? AND adapter_version=?")
    .get(adapterId, version) as { payload_json: string } | undefined;
  return row ? (JSON.parse(row.payload_json) as CatalogModel[]) : null;
}

function readNewestCached(db: Database.Database, adapterId: AdapterId): CatalogModel[] | null {
  const row = db
    .prepare("SELECT payload_json FROM model_catalog_cache WHERE adapter_id=? ORDER BY extracted_at DESC LIMIT 1")
    .get(adapterId) as { payload_json: string } | undefined;
  return row ? (JSON.parse(row.payload_json) as CatalogModel[]) : null;
}

/**
 * extracted(this version) -> newest cached -> checked-in seed. The chosen source
 * travels with the models so callers can render staleness instead of presenting
 * a fallback as current.
 */
export async function loadCatalog(
  db: Database.Database,
  adapterId: AdapterId,
  deps: LoadCatalogDeps,
): Promise<LoadedCatalog> {
  const version = await deps.version();

  if (version) {
    const cached = readCachedCatalog(db, adapterId, version);
    if (cached && cached.length > 0) {
      return { models: cached, source: "cached", adapterVersion: version };
    }
    const extracted = await deps.extract();
    if (extracted.length > 0) {
      db.prepare(
        "INSERT OR REPLACE INTO model_catalog_cache (adapter_id, adapter_version, extracted_at, payload_json) VALUES (?,?,?,?)",
      ).run(adapterId, version, deps.now(), JSON.stringify(extracted));
      return { models: extracted, source: "extracted", adapterVersion: version };
    }
  }

  const newest = readNewestCached(db, adapterId);
  if (newest && newest.length > 0) {
    return { models: newest, source: "cached", adapterVersion: version };
  }
  return { models: SEED_CATALOG[adapterId] ?? [], source: "seed", adapterVersion: version };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/store.test.ts`
Expected: PASS (7 tests)

Then confirm the migration applies:

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0067_model_catalog_cache.sql apps/daemon/src/migrations.ts apps/daemon/src/adapters/model-catalog/store.ts apps/daemon/src/adapters/model-catalog/store.test.ts
git commit -m "feat(daemon): the catalog is cached by CLI version and says which source it came from"
```

---

### Task 6: Profiles and the resolver

**Files:**
- Create: `apps/daemon/src/adapters/model-catalog/profiles.ts`
- Create: `apps/daemon/src/adapters/model-catalog/resolve-choice.ts`
- Test: `apps/daemon/src/adapters/model-catalog/resolve-choice.test.ts`

**Interfaces:**
- Consumes: `CatalogModel`, `pricingRank` (Task 2); `NodeModelSelection`, `ResolvedModelChoice`, `EffortLevel` (Task 1).
- Produces: `SEED_PROFILES: ModelProfile[]`, and
  `resolveChoice(selection: NodeModelSelection, catalog: CatalogModel[], adapterId: AdapterId, profiles: ModelProfile[]): ResolvedModelChoice | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/model-catalog/resolve-choice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SEED_PROFILES } from "./profiles.js";
import { resolveChoice } from "./resolve-choice.js";
import type { CatalogModel } from "./types.js";

const CATALOG: CatalogModel[] = [
  { id: "claude-fable-5-1", family: "fable", displayName: "Fable 5.1", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_10_50", advisorRank: 5,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

describe("resolveChoice — pinned", () => {
  it("fills a null effort from the model's catalog default", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got).toEqual({
      adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "high",
    });
  });

  it("keeps an explicitly authored effort", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "max" },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got?.effort).toBe("max");
  });

  it("downgrades an effort the model does not support to its default", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-haiku-4-5", contextVariant: "default", effort: "max" },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got?.effort).toBe("medium");
  });

  it("drops a 1m variant the model does not accept, rather than emitting an illegal id", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-haiku-4-5", contextVariant: "1m", effort: null },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got?.contextVariant).toBe("default");
  });

  it("returns null for a model absent from the catalog", () => {
    const got = resolveChoice(
      { kind: "pinned", adapterId: "claude-code", modelId: "claude-gone", contextVariant: "default", effort: null },
      CATALOG, "claude-code", SEED_PROFILES,
    );
    expect(got).toBeNull();
  });
});

describe("resolveChoice — profile", () => {
  it("picks the cheapest model meeting a light profile", () => {
    const got = resolveChoice({ kind: "profile", ref: "light" }, CATALOG, "claude-code", SEED_PROFILES);
    expect(got?.modelId).toBe("claude-haiku-4-5");
  });

  it("picks the strongest model for a deep-reasoning profile", () => {
    const got = resolveChoice({ kind: "profile", ref: "reasoning" }, CATALOG, "claude-code", SEED_PROFILES);
    expect(got?.modelId).toBe("claude-fable-5-1");
  });

  it("honours a profile's minimum context window", () => {
    const profiles = [{ id: "long", displayName: "Long", requires: { minContextWindow: 1_000_000 }, rank: "cheapest" as const }];
    const got = resolveChoice({ kind: "profile", ref: "long" }, CATALOG, "claude-code", profiles);
    expect(got?.modelId).toBe("claude-opus-5");
  });

  it("excludes a model whose pricing tier is unparseable from a budget-bounded profile", () => {
    const catalog = [{ ...CATALOG[2], id: "mystery", pricingTier: null }];
    const profiles = [{ id: "cheap", displayName: "Cheap", requires: { maxPricingTier: "tier_5_25" }, rank: "cheapest" as const }];
    expect(resolveChoice({ kind: "profile", ref: "cheap" }, catalog, "claude-code", profiles)).toBeNull();
  });

  it("returns null for an unknown profile rather than guessing a model", () => {
    expect(resolveChoice({ kind: "profile", ref: "nope" }, CATALOG, "claude-code", SEED_PROFILES)).toBeNull();
  });

  it("takes the profile's preferred effort when the model supports it", () => {
    const profiles = [{ id: "hard", displayName: "Hard", requires: {}, preferredEffort: "xhigh" as const, rank: "strongest" as const }];
    const got = resolveChoice({ kind: "profile", ref: "hard" }, CATALOG, "claude-code", profiles);
    expect(got?.effort).toBe("xhigh");
  });
});

describe("resolveChoice — an adapter with no effort axis", () => {
  it("leaves effort null when the model declares no supported efforts", () => {
    const catalog: CatalogModel[] = [{
      id: "gemini-3.5-flash", family: "gemini", displayName: "Gemini 3.5 Flash", contextWindow: 1_000_000,
      supports1mSuffix: false, pricingTier: null, advisorRank: null, supportedEfforts: [], defaultEffort: null,
    }];
    const got = resolveChoice(
      { kind: "pinned", adapterId: "antigravity", modelId: "gemini-3.5-flash", contextVariant: "default", effort: null },
      catalog, "antigravity", SEED_PROFILES,
    );
    expect(got?.effort).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/resolve-choice.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/daemon/src/adapters/model-catalog/profiles.ts`:

```ts
import type { EffortLevel } from "@orca/contracts";

/**
 * A requirement set a node can reference instead of pinning a model.
 *
 * Constrains ONLY axes the catalog supplies first-party. The bundle's own
 * `capabilities` array holds internal feature flags (lean_prompt,
 * refusal_fallback) and not task ability, so there is deliberately no semantic
 * tag here: hand-authoring one would recreate the staleness this replaces.
 */
export interface ModelProfile {
  id: string;
  displayName: string;
  requires: {
    minStrength?: number;
    maxPricingTier?: string;
    minContextWindow?: number;
    needsEffortLevel?: EffortLevel;
  };
  preferredEffort?: EffortLevel;
  rank: "cheapest" | "strongest";
}

/** Mirrors the LIGHT / EXECUTION / REASONING tiers the built-in templates use. */
export const SEED_PROFILES: ModelProfile[] = [
  { id: "light", displayName: "Light", requires: {}, rank: "cheapest" },
  { id: "execution", displayName: "Execution", requires: { minStrength: 3 }, rank: "cheapest" },
  { id: "reasoning", displayName: "Reasoning", requires: { minStrength: 4 }, rank: "strongest" },
];
```

Create `apps/daemon/src/adapters/model-catalog/resolve-choice.ts`:

```ts
import type { AdapterId, EffortLevel, NodeModelSelection, ResolvedModelChoice } from "@orca/contracts";
import type { ModelProfile } from "./profiles.js";
import { pricingRank, type CatalogModel } from "./types.js";

/**
 * The effort a model will actually run at. An authored level the model does not
 * support falls back to its default rather than being passed through — the CLI
 * would reject it and the step would die at spawn.
 */
function settleEffort(model: CatalogModel, wanted: EffortLevel | null): EffortLevel | null {
  if (model.supportedEfforts.length === 0) return null;
  if (wanted && model.supportedEfforts.includes(wanted)) return wanted;
  return model.defaultEffort;
}

function meets(model: CatalogModel, profile: ModelProfile): boolean {
  const r = profile.requires;
  if (r.minStrength !== undefined && (model.advisorRank ?? -1) < r.minStrength) return false;
  if (r.minContextWindow !== undefined && model.contextWindow < r.minContextWindow) return false;
  if (r.maxPricingTier !== undefined && pricingRank(model.pricingTier) > pricingRank(r.maxPricingTier)) return false;
  if (r.needsEffortLevel !== undefined && !model.supportedEfforts.includes(r.needsEffortLevel)) return false;
  return true;
}

export function resolveChoice(
  selection: NodeModelSelection,
  catalog: CatalogModel[],
  adapterId: AdapterId,
  profiles: ModelProfile[],
): ResolvedModelChoice | null {
  if (selection.kind === "pinned") {
    const model = catalog.find((m) => m.id === selection.modelId);
    if (!model) return null;
    return {
      adapterId: selection.adapterId,
      modelId: model.id,
      contextVariant: selection.contextVariant === "1m" && model.supports1mSuffix ? "1m" : "default",
      effort: settleEffort(model, selection.effort),
    };
  }

  const profile = profiles.find((p) => p.id === selection.ref);
  if (!profile) return null;
  const eligible = catalog.filter((m) => meets(m, profile));
  if (eligible.length === 0) return null;

  const sorted = [...eligible].sort((a, b) =>
    profile.rank === "cheapest"
      ? pricingRank(a.pricingTier) - pricingRank(b.pricingTier)
      : (b.advisorRank ?? -1) - (a.advisorRank ?? -1),
  );
  const model = sorted[0];
  return {
    adapterId,
    modelId: model.id,
    contextVariant: "default",
    effort: settleEffort(model, profile.preferredEffort ?? null),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/resolve-choice.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/model-catalog/profiles.ts apps/daemon/src/adapters/model-catalog/resolve-choice.ts apps/daemon/src/adapters/model-catalog/resolve-choice.test.ts
git commit -m "feat(daemon): a node's tier resolves against the catalog instead of naming a model"
```

---

### Task 7: Per-adapter spawn-arg translation

**Files:**
- Modify: `apps/daemon/src/adapters/types.ts:20-27` (add `model` to `AdapterSpawnInput`, `modelSpawnArgs` to `AgentAdapter`)
- Modify: `apps/daemon/src/adapters/claude-code.ts:38-48`
- Modify: `apps/daemon/src/adapters/codex.ts:41`
- Modify: `apps/daemon/src/adapters/antigravity.ts:42`
- Test: `apps/daemon/src/adapters/model-spawn-args.test.ts`

**Interfaces:**
- Consumes: `ResolvedModelChoice` (Task 1).
- Produces: `AgentAdapter.modelSpawnArgs(choice: ResolvedModelChoice): string[]`, and `AdapterSpawnInput.model?: ResolvedModelChoice`. `resolveSpawn` now returns those args.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/model-spawn-args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ResolvedModelChoice } from "@orca/contracts";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";

const choice = (over: Partial<ResolvedModelChoice> = {}): ResolvedModelChoice => ({
  adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "high", ...over,
});

describe("ClaudeCodeAdapter.modelSpawnArgs", () => {
  const adapter = new ClaudeCodeAdapter();

  it("passes the model and the effort together", () => {
    expect(adapter.modelSpawnArgs(choice())).toEqual(["--model", "claude-opus-5", "--effort", "high"]);
  });

  it("appends the 1m suffix for a long-context variant", () => {
    expect(adapter.modelSpawnArgs(choice({ contextVariant: "1m" })))
      .toEqual(["--model", "claude-opus-5[1m]", "--effort", "high"]);
  });

  it("omits --effort only when there is no effort to pass", () => {
    expect(adapter.modelSpawnArgs(choice({ effort: null }))).toEqual(["--model", "claude-opus-5"]);
  });
});

describe("CodexAdapter.modelSpawnArgs", () => {
  const adapter = new CodexAdapter();

  it("uses -m and the reasoning-effort config key", () => {
    expect(adapter.modelSpawnArgs(choice({ adapterId: "codex", modelId: "gpt-5.5", effort: "high" })))
      .toEqual(["-m", "gpt-5.5", "-c", "model_reasoning_effort=high"]);
  });

  it("passes only the model when no effort is set", () => {
    expect(adapter.modelSpawnArgs(choice({ adapterId: "codex", modelId: "gpt-5.5", effort: null })))
      .toEqual(["-m", "gpt-5.5"]);
  });
});

describe("AntigravityAdapter.modelSpawnArgs", () => {
  it("passes the model and never an effort", () => {
    expect(new AntigravityAdapter().modelSpawnArgs(
      choice({ adapterId: "antigravity", modelId: "gemini-3.5-flash", effort: "high" }),
    )).toEqual(["--model", "gemini-3.5-flash"]);
  });
});

describe("resolveSpawn", () => {
  it("carries the model args when a choice is supplied", async () => {
    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({
      goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws", model: choice(),
    });
    expect(spawn.args).toEqual(["--model", "claude-opus-5", "--effort", "high"]);
  });

  it("carries no model args when no choice is supplied", async () => {
    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({ goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws" });
    expect(spawn.args).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-spawn-args.test.ts`
Expected: FAIL — `modelSpawnArgs` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `apps/daemon/src/adapters/types.ts`, extend the input and the interface:

```ts
import type { ResolvedModelChoice } from "@orca/contracts";

export interface AdapterSpawnInput {
  goalId: string;
  sessionId: string;
  workspacePath: string;
  role?: string;
  instruction?: string;
  /** The model this session must run. Absent only where none was resolved. */
  model?: ResolvedModelChoice;
}
```

Add to the `AgentAdapter` interface, next to `supportsModel`:

```ts
  /** Translate a resolved choice into this CLI's own flags. */
  modelSpawnArgs(choice: ResolvedModelChoice): string[];
```

In `apps/daemon/src/adapters/claude-code.ts`, add the method and use it in `resolveSpawn`:

```ts
  modelSpawnArgs(choice: ResolvedModelChoice): string[] {
    const model = choice.contextVariant === "1m" ? `${choice.modelId}[1m]` : choice.modelId;
    const args = ["--model", model];
    // Both flags travel together: passing --model alone leaves the user's own
    // ~/.claude/settings.json effortLevel governing the run.
    if (choice.effort) args.push("--effort", choice.effort);
    return args;
  }
```

and change the `resolveSpawn` return to:

```ts
    return {
      command: result.resolvedPath,
      args: input.model ? this.modelSpawnArgs(input.model) : [],
      env: buildSpawnEnv(input),
      cwd: input.workspacePath,
    };
```

In `apps/daemon/src/adapters/codex.ts`:

```ts
  modelSpawnArgs(choice: ResolvedModelChoice): string[] {
    const args = ["-m", choice.modelId];
    if (choice.effort) args.push("-c", `model_reasoning_effort=${choice.effort}`);
    return args;
  }
```

In `apps/daemon/src/adapters/antigravity.ts` (no effort axis in v1):

```ts
  modelSpawnArgs(choice: ResolvedModelChoice): string[] {
    return ["--model", choice.modelId];
  }
```

Apply the same `resolveSpawn` args change in `codex.ts` and `antigravity.ts`, preserving any args those adapters already return by appending the model args to them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-spawn-args.test.ts`
Expected: PASS (8 tests)

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/`
Expected: PASS. Any test double implementing `AgentAdapter` now needs a `modelSpawnArgs`; add `modelSpawnArgs: () => []` to those fakes.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/
git commit -m "feat(daemon): each adapter translates a resolved model into its own flags"
```

---

### Task 8: Persist the model on the session row

The launch path creates a session row and starts it later (`session-launcher-impl.ts` → `sessions/runtime.ts:257`), so the resolved choice must survive that hop on the row itself — exactly as `role` and `instruction` already do.

**Files:**
- Create: `apps/daemon/migrations/0068_session_model_choice.sql`
- Modify: `apps/daemon/src/migrations.ts` (append)
- Modify: `apps/daemon/src/sessions/usecases.ts:90-104,173,242`
- Modify: `apps/daemon/src/sessions/runtime.ts:257-262`
- Test: `apps/daemon/src/sessions/session-model-choice.test.ts`

**Interfaces:**
- Consumes: `ResolvedModelChoice` (Task 1), `modelSpawnArgs` (Task 7).
- Produces: `createSession` accepts `model?: ResolvedModelChoice`; `sessions` rows carry `model_id`, `context_variant`, `effort`; `startSession` passes the choice into `resolveSpawn`.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0068_session_model_choice.sql`:

```sql
-- 0068_session_model_choice.sql
-- The model a session must run, carried on the session row.
--
-- Dispatch resolves the model, but the launcher only CREATES the row; the pty
-- starts later, in sessions/runtime.ts, where the resolved choice is no longer
-- in scope. Without these columns that hop drops the choice and the CLI falls
-- back to whatever ~/.claude/settings.json says — which is precisely the defect
-- this work exists to remove.
--
-- Additive and nullable. Rows written before this land carry NULL and were run
-- under the ambient default; they must NOT be backfilled with the model their
-- step template merely preferred, since that preference is what was already
-- being recorded and never honoured.
ALTER TABLE sessions ADD COLUMN model_id TEXT;
ALTER TABLE sessions ADD COLUMN context_variant TEXT;
ALTER TABLE sessions ADD COLUMN effort TEXT;
```

Register `"0068_session_model_choice.sql",` in `migrationFiles`.

- [ ] **Step 2: Write the failing test**

Create `apps/daemon/src/sessions/session-model-choice.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ResolvedModelChoice } from "@orca/contracts";
import { modelChoiceFromRow, modelChoiceToRow } from "./model-choice.js";

const CHOICE: ResolvedModelChoice = {
  adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "1m", effort: "xhigh",
};

describe("modelChoiceToRow", () => {
  it("flattens a choice into the three columns", () => {
    expect(modelChoiceToRow(CHOICE)).toEqual({
      model_id: "claude-opus-5", context_variant: "1m", effort: "xhigh",
    });
  });

  it("writes nulls when there is no choice", () => {
    expect(modelChoiceToRow(undefined)).toEqual({
      model_id: null, context_variant: null, effort: null,
    });
  });

  it("writes a null effort for an adapter with no effort axis", () => {
    expect(modelChoiceToRow({ ...CHOICE, effort: null }).effort).toBeNull();
  });
});

describe("modelChoiceFromRow", () => {
  it("rebuilds the choice from the row", () => {
    expect(modelChoiceFromRow("claude-code", {
      model_id: "claude-opus-5", context_variant: "1m", effort: "xhigh",
    })).toEqual(CHOICE);
  });

  it("returns undefined for a pre-migration row rather than inventing a model", () => {
    expect(modelChoiceFromRow("claude-code", {
      model_id: null, context_variant: null, effort: null,
    })).toBeUndefined();
  });

  it("defaults a missing variant to default", () => {
    expect(modelChoiceFromRow("claude-code", {
      model_id: "claude-opus-5", context_variant: null, effort: null,
    })).toEqual({
      adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/sessions/session-model-choice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

Create `apps/daemon/src/sessions/model-choice.ts`:

```ts
import type { AdapterId, ContextVariant, EffortLevel, ResolvedModelChoice } from "@orca/contracts";

export interface ModelChoiceRow {
  model_id: string | null;
  context_variant: string | null;
  effort: string | null;
}

export function modelChoiceToRow(choice: ResolvedModelChoice | undefined): ModelChoiceRow {
  if (!choice) return { model_id: null, context_variant: null, effort: null };
  return {
    model_id: choice.modelId,
    context_variant: choice.contextVariant,
    effort: choice.effort,
  };
}

/**
 * Rebuild the choice a session was started with. A row with no model_id predates
 * the column and ran under the ambient CLI default; it returns undefined rather
 * than a guess, so the caller can tell "no model chosen" from "this model".
 */
export function modelChoiceFromRow(
  adapterId: AdapterId,
  row: ModelChoiceRow,
): ResolvedModelChoice | undefined {
  if (!row.model_id) return undefined;
  return {
    adapterId,
    modelId: row.model_id,
    contextVariant: (row.context_variant as ContextVariant | null) ?? "default",
    effort: (row.effort as EffortLevel | null) ?? null,
  };
}
```

In `apps/daemon/src/sessions/usecases.ts`, add `model?: ResolvedModelChoice` to the `createSession` input type (after `instruction?: string;`), destructure it alongside `instruction`, and include the three columns in the INSERT using `modelChoiceToRow(model)`.

In `apps/daemon/src/sessions/runtime.ts`, extend the row SELECT to include `model_id, context_variant, effort` and pass the rebuilt choice:

```ts
      spawnResult = await adapter.resolveSpawn({
        goalId: session.goalId,
        sessionId,
        workspacePath: wsRow.path,
        role: session.role ?? undefined,
        instruction: session.instruction ?? undefined,
        model: modelChoiceFromRow(session.adapterId as AdapterId, session),
      });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/sessions/`
Expected: PASS

Run: `pnpm --filter @orca/daemon exec vitest run src/migrations.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0068_session_model_choice.sql apps/daemon/src/migrations.ts apps/daemon/src/sessions/
git commit -m "feat(daemon): a session carries the model it was dispatched with"
```

---

### Task 9: Thread the model to the tmux worker

`workerSpawnFn` (`server.ts:843`) currently discards `spawn.args` entirely — the model args from Task 7 would be dropped here even once resolved.

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/worker-session.ts:68-75,138-176`
- Modify: `apps/daemon/src/workflows/orchestrator/runner-port.ts:12`
- Modify: `apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts:430`
- Modify: `apps/daemon/src/server.ts:843-852`
- Test: `apps/daemon/src/workflows/orchestrator/worker-session.model.test.ts`

**Interfaces:**
- Consumes: `ResolvedModelChoice` (Task 1), `modelSpawnArgs` (Task 7).
- Produces: `WorkerSpawnInput.args: string[]`; `RunnerPort.workerSpawn` accepts `model?: ResolvedModelChoice`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/orchestrator/worker-session.model.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkerSessionManager } from "./worker-session.js";

function managerWithCapturedCommand() {
  const commands: string[] = [];
  const tmux = {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === "new-session") commands.push(args[args.length - 1]);
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
  };
  const manager = new WorkerSessionManager({
    privateRoot: mkdtempSync(join(tmpdir(), "orca-worker-")),
    authToken: "t",
    hookResolverCommand: ["orca", "hook"],
    claudeBin: "/bin/claude",
    resolveProvider: () => ({
      workerHookConfig: () => ({ files: [], spawnArgs: ["--settings", "/cfg/settings.json"] }),
    }),
    tmux: tmux as never,
    captureSink: () => {},
    startupTimeoutMs: 1,
  });
  return { manager, commands };
}

describe("WorkerSessionManager.spawn", () => {
  it("puts the model args into the tmux command", async () => {
    const { manager, commands } = managerWithCapturedCommand();
    await manager.spawn({
      sessionId: "s1", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
      command: "/bin/claude", env: {}, args: ["--model", "claude-opus-5", "--effort", "high"],
    });
    expect(commands[0]).toContain("--model claude-opus-5 --effort high");
  });

  it("keeps the provider's own spawn args alongside the model args", async () => {
    const { manager, commands } = managerWithCapturedCommand();
    await manager.spawn({
      sessionId: "s2", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
      command: "/bin/claude", env: {}, args: ["--model", "claude-opus-5"],
    });
    expect(commands[0]).toContain("--settings /cfg/settings.json");
    expect(commands[0]).toContain("--model claude-opus-5");
  });

  it("spawns without model args when none were resolved", async () => {
    const { manager, commands } = managerWithCapturedCommand();
    await manager.spawn({
      sessionId: "s3", goalId: "g1", adapterId: "claude-code", workspacePath: "/tmp/ws",
      command: "/bin/claude", env: {}, args: [],
    });
    expect(commands[0]).not.toContain("--model");
  });
});
```

If the existing tmux seam in this file differs from the `tmux.run` shape above, mirror whatever `worker-session.test.ts` already uses for its fake rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/worker-session.model.test.ts`
Expected: FAIL — `args` is not accepted / not present in the command.

- [ ] **Step 3: Write minimal implementation**

In `worker-session.ts`, add to `WorkerSpawnInput`:

```ts
  /** Adapter args (model + effort) from resolveSpawn. Empty when none resolved. */
  args: string[];
```

and include them in the command built in `spawn()`:

```ts
    const command = [input.command, ...input.args, ...hookCfg.spawnArgs]
      .map((token) => (/\s/.test(token) ? JSON.stringify(token) : token))
      .join(" ");
```

In `runner-port.ts`:

```ts
  workerSpawn: (input: {
    sessionId: string; goalId: string; adapterId: string; model?: ResolvedModelChoice;
  }) => Promise<void>;
```

In `server.ts`, take the model and stop discarding the args:

```ts
  const workerSpawnFn = async ({ sessionId, goalId, adapterId, model }: {
    sessionId: string; goalId: string; adapterId: string; model?: ResolvedModelChoice;
  }) => {
    const wsRow = db.prepare("SELECT w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ? ORDER BY gw.attached_at ASC LIMIT 1").get(goalId) as { path: string } | undefined;
    if (!wsRow) { console.warn(`[orchestrator] workerSpawn: no workspace for goal ${goalId}`); return; }
    const adapter = adapterRegistry.get(adapterId);
    if (!adapter) { console.warn(`[orchestrator] workerSpawn: no adapter ${adapterId}`); return; }
    const spawn = await adapter.resolveSpawn({ goalId, sessionId, workspacePath: wsRow.path, model });
    const sandboxed = noopSandbox.wrap(spawn);
    await workerSessions.spawn({
      sessionId, goalId, adapterId, workspacePath: wsRow.path,
      command: sandboxed.command, args: sandboxed.args, env: sandboxed.env,
    });
  };
```

In `provider-recovery-controller.ts:430`, pass the model the recovery already resolved:

```ts
      await this.deps.runner.workerSpawn({ sessionId, goalId: goal.id, adapterId, model: dispatch.model });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/`
Expected: PASS. Existing `workerSessions.spawn` callers in tests need `args: []` added.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/worker-session.ts apps/daemon/src/workflows/orchestrator/runner-port.ts apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/worker-session.model.test.ts
git commit -m "fix(daemon): the model reaches the worker instead of being resolved and dropped"
```

---

### Task 10: Resolve at dispatch and record what ran

**Files:**
- Create: `apps/daemon/migrations/0069_step_run_effort.sql`
- Modify: `apps/daemon/src/migrations.ts` (append)
- Modify: `apps/daemon/src/workflows/orchestrator/step-dispatch.ts`
- Modify: `apps/daemon/src/workflows/steps/projection.ts:126-135`
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts:409,543,1021,2375`
- Test: `apps/daemon/src/workflows/orchestrator/step-dispatch.test.ts`

**Interfaces:**
- Consumes: `resolveChoice` (Task 6), `loadCatalog` (Task 5), `StepAgentChoice` (Task 1).
- Produces: `ResolvedStepDispatch` gains `model: ResolvedModelChoice`; `recordOperatorSelection` accepts `effort`.

- [ ] **Step 1: Write the migration**

Create `apps/daemon/migrations/0069_step_run_effort.sql`:

```sql
-- 0069_step_run_effort.sql
-- The effort level the step's model actually ran at.
--
-- `selected_model_id` keeps the full dispatch string ("claude-opus-5[1m]"), so
-- the "distinguish providers by model prefix" convention the OTEL cost reader
-- depends on still holds. Effort has no such home and is a separate axis: the
-- same model at max costs materially more than at low, so attributing an
-- outcome to a model without it is attributing it to half a fact.
--
-- Additive and nullable. Rows written before this land carry NULL, and a reader
-- must treat those as UNKNOWN effort rather than assuming the default — under
-- the old behaviour they ran at whatever the ambient settings said.
ALTER TABLE workflow_step_runs ADD COLUMN selected_effort TEXT;
```

Register `"0069_step_run_effort.sql",` in `migrationFiles`.

- [ ] **Step 2: Write the failing test**

Add to `apps/daemon/src/workflows/orchestrator/step-dispatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../../adapters/model-catalog/types.js";
import { SEED_PROFILES } from "../../adapters/model-catalog/profiles.js";
import { resolveStepDispatch } from "./step-dispatch.js";

const CATALOG: CatalogModel[] = [
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

const base = {
  isAdapterReady: async () => true,
  resolveMode: () => ({ mode: "shadow_session" as const, fallbacks: [] }),
  catalogFor: async () => CATALOG,
  profiles: SEED_PROFILES,
};

describe("resolveStepDispatch model resolution", () => {
  it("returns a resolved choice with the effort filled from the catalog default", async () => {
    const got = await resolveStepDispatch({
      ...base,
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null }],
    });
    expect(got.model).toEqual({
      adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: "high",
    });
  });

  it("resolves a profile preference against the catalog", async () => {
    const got = await resolveStepDispatch({
      ...base,
      adapterOrder: ["claude-code"],
      preferences: [{ kind: "profile", ref: "light" }],
    });
    expect(got.model.modelId).toBe("claude-haiku-4-5");
  });

  it("skips a preference whose model is absent from the catalog and takes the next", async () => {
    const got = await resolveStepDispatch({
      ...base,
      preferences: [
        { kind: "pinned", adapterId: "claude-code", modelId: "claude-gone", contextVariant: "default", effort: null },
        { kind: "pinned", adapterId: "claude-code", modelId: "claude-haiku-4-5", contextVariant: "default", effort: null },
      ],
    });
    expect(got.model.modelId).toBe("claude-haiku-4-5");
  });

  it("throws rather than falling through to the ambient default when nothing resolves", async () => {
    await expect(resolveStepDispatch({
      ...base,
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-gone", contextVariant: "default", effort: null }],
    })).rejects.toThrow(/no ready agent/);
  });

  it("skips an adapter that is not ready", async () => {
    const got = await resolveStepDispatch({
      ...base,
      isAdapterReady: async (id: string) => id !== "codex",
      preferences: [
        { kind: "pinned", adapterId: "codex", modelId: "claude-opus-5", contextVariant: "default", effort: null },
        { kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null },
      ],
    });
    expect(got.adapterId).toBe("claude-code");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/step-dispatch.test.ts`
Expected: FAIL — `model` is not on the result.

- [ ] **Step 4: Write minimal implementation**

Rewrite `apps/daemon/src/workflows/orchestrator/step-dispatch.ts`:

```ts
import type { AdapterId, ExecutionMode, ResolvedModelChoice, StepAgentChoice } from "@orca/contracts";
import type { ResolvedMode } from "../../adapters/dispatcher.js";
import type { ModelProfile } from "../../adapters/model-catalog/profiles.js";
import { resolveChoice } from "../../adapters/model-catalog/resolve-choice.js";
import type { CatalogModel } from "../../adapters/model-catalog/types.js";

export interface ResolveStepDispatchInput {
  preferences: StepAgentChoice[];
  isAdapterReady(adapterId: string): Promise<boolean>;
  resolveMode(adapterId: string): ResolvedMode;
  catalogFor(adapterId: AdapterId): Promise<CatalogModel[]>;
  profiles: ModelProfile[];
  /** Adapter order used to resolve a profile preference, which names no adapter. */
  adapterOrder?: AdapterId[];
}

export interface ResolvedStepDispatch {
  adapterId: string;
  modelId: string;
  model: ResolvedModelChoice;
  providerId?: string;
  executionMode: ExecutionMode;
  fallbackModes: ExecutionMode[];
}

const DEFAULT_ADAPTER_ORDER: AdapterId[] = ["claude-code", "codex", "antigravity"];

export async function resolveStepDispatch(
  input: ResolveStepDispatchInput,
): Promise<ResolvedStepDispatch> {
  for (const pref of input.preferences) {
    const candidates: AdapterId[] =
      pref.kind === "pinned" ? [pref.adapterId] : (input.adapterOrder ?? DEFAULT_ADAPTER_ORDER);

    for (const adapterId of candidates) {
      if (!(await input.isAdapterReady(adapterId))) continue;
      const catalog = await input.catalogFor(adapterId);
      const model = resolveChoice(pref, catalog, adapterId, input.profiles);
      if (!model) continue;
      const mode = input.resolveMode(adapterId);
      return {
        adapterId,
        modelId: model.modelId,
        model,
        ...(pref.kind === "pinned" && pref.providerId ? { providerId: pref.providerId } : {}),
        executionMode: mode.mode,
        fallbackModes: mode.fallbacks,
      };
    }
  }
  const described = input.preferences
    .map((p) => (p.kind === "pinned" ? `${p.adapterId}/${p.modelId}` : `profile:${p.ref}`))
    .join(", ");
  throw new Error(`no ready agent for step (preferences: ${described})`);
}
```

In `apps/daemon/src/workflows/steps/projection.ts`, extend `recordOperatorSelection`:

```ts
export function recordOperatorSelection(
  db: Database.Database,
  id: string,
  sel: { operatorId: string; providerId: string | null; modelId: string | null; effort: string | null; at: string }
): void {
  db.prepare(
    "UPDATE workflow_step_runs SET selected_operator_id=?, selected_provider_id=?, selected_model_id=?, selected_effort=?, operator_selected_at=? WHERE id=?"
  ).run(sel.operatorId, sel.providerId, sel.modelId, sel.effort, sel.at, id);
  resetWorkflowStepProjectionPreparedStatements();
}
```

In `dispatch-engine.ts`, record the full dispatch string and the effort at the `recordOperatorSelection` call near line 1021:

```ts
      recordOperatorSelection(db, stepRun.id, {
        operatorId,
        providerId,
        // The dispatch string, not the bare id: "[1m]" is part of what ran, and
        // the OTEL cost reader keys providers off this column's prefix.
        modelId: dispatch.model.contextVariant === "1m"
          ? `${dispatch.model.modelId}[1m]`
          : dispatch.model.modelId,
        effort: dispatch.model.effort,
        at: now(),
      });
```

Wire `catalogFor` and `profiles` at every `resolveStepDispatch` call site (lines 409, 543, 2375), sourcing them from `daemon-context` where `stepDispatchCapabilities` is assembled.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0069_step_run_effort.sql apps/daemon/src/migrations.ts apps/daemon/src/workflows/ 
git commit -m "feat(daemon): dispatch resolves a model against the catalog and records what ran"
```

---

### Task 11: The invariant test

The deterministic sensor whose absence let the original defect live: what was recorded must equal what was launched.

**Files:**
- Test: `apps/daemon/src/workflows/orchestrator/model-dispatch-invariant.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-10. Produces nothing.

- [ ] **Step 1: Write the test**

Create `apps/daemon/src/workflows/orchestrator/model-dispatch-invariant.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../adapters/claude-code.js";
import { SEED_PROFILES } from "../../adapters/model-catalog/profiles.js";
import type { CatalogModel } from "../../adapters/model-catalog/types.js";
import { resolveStepDispatch } from "./step-dispatch.js";

const CATALOG: CatalogModel[] = [
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
];

/**
 * The model recorded against a step run must be the model in the command that
 * ran. Before this existed, dispatch resolved a model, wrote it to the database,
 * and spawned a CLI that read ~/.claude/settings.json instead — so every
 * model-attributed measurement described a model that never ran.
 */
describe("recorded model == launched model", () => {
  it("agrees for a pinned 1m choice at an explicit effort", async () => {
    const dispatch = await resolveStepDispatch({
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "1m", effort: "xhigh" }],
      isAdapterReady: async () => true,
      resolveMode: () => ({ mode: "shadow_session", fallbacks: [] }),
      catalogFor: async () => CATALOG,
      profiles: SEED_PROFILES,
    });

    const recorded = dispatch.model.contextVariant === "1m"
      ? `${dispatch.model.modelId}[1m]`
      : dispatch.model.modelId;

    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({
      goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws", model: dispatch.model,
    });

    expect(spawn.args[spawn.args.indexOf("--model") + 1]).toBe(recorded);
    expect(spawn.args[spawn.args.indexOf("--effort") + 1]).toBe(dispatch.model.effort);
  });

  it("passes an effort even when the node authored none, so ambient settings cannot govern", async () => {
    const dispatch = await resolveStepDispatch({
      preferences: [{ kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5", contextVariant: "default", effort: null }],
      isAdapterReady: async () => true,
      resolveMode: () => ({ mode: "shadow_session", fallbacks: [] }),
      catalogFor: async () => CATALOG,
      profiles: SEED_PROFILES,
    });

    const adapter = new ClaudeCodeAdapter(async () => ({ resolvedPath: "/bin/claude" }));
    const spawn = await adapter.resolveSpawn({
      goalId: "g1", sessionId: "s1", workspacePath: "/tmp/ws", model: dispatch.model,
    });

    expect(spawn.args).toContain("--effort");
    expect(spawn.args[spawn.args.indexOf("--effort") + 1]).toBe("high");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/model-dispatch-invariant.test.ts`
Expected: PASS (2 tests). If it fails, the defect is still present — fix the plumbing, not the test.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/model-dispatch-invariant.test.ts
git commit -m "test(daemon): the recorded model is the model that launched"
```

---

### Task 12: Catalog HTTP routes

**Files:**
- Create: `apps/daemon/src/adapters/model-catalog/routes.ts`
- Modify: `apps/daemon/src/server.ts` (register the routes near the existing adapter routes)
- Test: `apps/daemon/src/adapters/model-catalog/routes.test.ts`

**Interfaces:**
- Consumes: `loadCatalog` (Task 5), `SEED_PROFILES` (Task 6).
- Produces: `GET /v1/model-catalog` → `{ adapters: [{ adapterId, adapterVersion, source, models }], profiles }`, and `POST /v1/model-catalog/refresh` → the same body after a forced re-extract.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/adapters/model-catalog/routes.test.ts`:

```ts
import Fastify from "fastify";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { registerModelCatalogRoutes } from "./routes.js";
import type { CatalogModel } from "./types.js";

const MODEL: CatalogModel = {
  id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
  supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
  supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high",
};

function appWith(source: "extracted" | "cached" | "seed") {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE model_catalog_cache (
    adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
    extracted_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (adapter_id, adapter_version))`);
  const app = Fastify();
  registerModelCatalogRoutes(app, {
    db,
    load: async (_db, adapterId) => ({
      models: adapterId === "claude-code" ? [MODEL] : [],
      source,
      adapterVersion: "2.1.263",
    }),
  });
  return app;
}

describe("GET /v1/model-catalog", () => {
  it("returns each adapter's models with its display names", async () => {
    const res = await appWith("extracted").inject({ method: "GET", url: "/v1/model-catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const claude = body.adapters.find((a: { adapterId: string }) => a.adapterId === "claude-code");
    expect(claude.models[0].displayName).toBe("Opus 5");
  });

  it("reports the source so a stale catalog can be shown as stale", async () => {
    const body = (await appWith("seed").inject({ method: "GET", url: "/v1/model-catalog" })).json();
    expect(body.adapters.every((a: { source: string }) => a.source === "seed")).toBe(true);
  });

  it("reports the detected CLI version", async () => {
    const body = (await appWith("extracted").inject({ method: "GET", url: "/v1/model-catalog" })).json();
    expect(body.adapters[0].adapterVersion).toBe("2.1.263");
  });

  it("returns the profiles a node can reference", async () => {
    const body = (await appWith("extracted").inject({ method: "GET", url: "/v1/model-catalog" })).json();
    expect(body.profiles.map((p: { id: string }) => p.id)).toContain("reasoning");
  });
});

describe("POST /v1/model-catalog/refresh", () => {
  it("returns the catalog after re-reading it", async () => {
    const res = await appWith("extracted").inject({ method: "POST", url: "/v1/model-catalog/refresh" });
    expect(res.statusCode).toBe(200);
    expect(res.json().adapters).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/daemon/src/adapters/model-catalog/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { AdapterId } from "@orca/contracts";
import { SEED_PROFILES } from "./profiles.js";
import type { LoadedCatalog } from "./store.js";

const ADAPTERS: AdapterId[] = ["claude-code", "codex", "antigravity"];

export interface ModelCatalogRouteDeps {
  db: Database.Database;
  load: (db: Database.Database, adapterId: AdapterId, opts?: { force?: boolean }) => Promise<LoadedCatalog>;
}

export function registerModelCatalogRoutes(
  app: FastifyInstance,
  deps: ModelCatalogRouteDeps,
): void {
  const body = async (force: boolean) => ({
    adapters: await Promise.all(
      ADAPTERS.map(async (adapterId) => {
        const loaded = await deps.load(deps.db, adapterId, { force });
        return {
          adapterId,
          adapterVersion: loaded.adapterVersion,
          source: loaded.source,
          models: loaded.models,
        };
      }),
    ),
    profiles: SEED_PROFILES,
  });

  app.get("/v1/model-catalog", async () => body(false));
  app.post("/v1/model-catalog/refresh", async () => body(true));
}
```

Add a `force` option to `loadCatalog` in `store.ts` so its signature becomes
`loadCatalog(db, adapterId, deps, opts?: { force?: boolean })`, skipping the
`readCachedCatalog` short-circuit when `force` is true. In `server.ts`, pass a
bound wrapper that closes over the real deps:

```ts
registerModelCatalogRoutes(app, {
  db,
  load: (database, adapterId, opts) =>
    loadCatalog(database, adapterId, catalogDepsFor(adapterId), opts),
});
```

where `catalogDepsFor` supplies `version` (from the adapter's `checkInstalled()`),
`extract` (`extractClaudeCatalog` for claude-code, `async () => []` for the
others), and `now`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/model-catalog/routes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/adapters/model-catalog/routes.ts apps/daemon/src/adapters/model-catalog/routes.test.ts apps/daemon/src/adapters/model-catalog/store.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): serve the model catalog and its source to the desktop"
```

---

### Task 13: The step editor's model picker and effort control

**Files:**
- Create: `apps/desktop/src/workflows/ModelPicker.tsx`
- Modify: `apps/desktop/src/workflows/StepEditor.tsx:65`
- Modify: `apps/desktop/src/api.ts` (add `getModelCatalog`)
- Test: `apps/desktop/src/workflows/ModelPicker.test.tsx`

**Interfaces:**
- Consumes: `GET /v1/model-catalog` (Task 12); `NodeModelSelection` (Task 1).
- Produces: `<ModelPicker value={NodeModelSelection} catalog={...} profiles={...} onChange={...} />`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/workflows/ModelPicker.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker.js";

const CATALOG = [
  { id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
    supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  { id: "claude-haiku-4-5", family: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000,
    supports1mSuffix: false, pricingTier: "tier_1_5", advisorRank: 1,
    supportedEfforts: ["low", "medium", "high"], defaultEffort: "medium" },
];
const PROFILES = [{ id: "reasoning", displayName: "Reasoning", requires: {}, rank: "strongest" as const }];

const pinned = { kind: "pinned" as const, adapterId: "claude-code" as const, modelId: "claude-opus-5", contextVariant: "default" as const, effort: "high" as const };

describe("ModelPicker", () => {
  it("lists models by display name, not by id", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Opus 5" })).toBeInTheDocument();
  });

  it("offers a 1M context row only for a model that accepts the suffix", () => {
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Opus 5 (1M context)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Haiku 4.5 (1M context)" })).not.toBeInTheDocument();
  });

  it("offers only the effort levels the chosen model supports", () => {
    render(<ModelPicker value={{ ...pinned, modelId: "claude-haiku-4-5", effort: "medium" }} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "high" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "max" })).not.toBeInTheDocument();
  });

  it("emits the model and its variant as separate fields", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-opus-5::1m" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: "claude-opus-5", contextVariant: "1m" }));
  });

  it("resets effort to the new model's default when the choice changes", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-haiku-4-5::default" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ effort: "medium" }));
  });

  it("switches to a profile reference and hides the effort control", () => {
    const onChange = vi.fn();
    render(<ModelPicker value={pinned} catalog={CATALOG} profiles={PROFILES} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /profile/i }));
    expect(onChange).toHaveBeenCalledWith({ kind: "profile", ref: "reasoning" });
  });

  it("shows the profile's name when the node references one", () => {
    render(<ModelPicker value={{ kind: "profile", ref: "reasoning" }} catalog={CATALOG} profiles={PROFILES} onChange={() => {}} />);
    expect(screen.getByDisplayValue("reasoning")).toBeInTheDocument();
    expect(screen.queryByLabelText("Effort")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/workflows/ModelPicker.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/workflows/ModelPicker.tsx`. Encode the option value as `${modelId}::${contextVariant}` so the variant stays a separate field on the way out:

```tsx
import type { NodeModelSelection } from "@orca/contracts";

interface CatalogModel {
  id: string; family: string; displayName: string; contextWindow: number;
  supports1mSuffix: boolean; pricingTier: string | null; advisorRank: number | null;
  supportedEfforts: string[]; defaultEffort: string | null;
}
interface Profile { id: string; displayName: string }

export function ModelPicker({ value, catalog, profiles, onChange }: {
  value: NodeModelSelection;
  catalog: CatalogModel[];
  profiles: Profile[];
  onChange: (next: NodeModelSelection) => void;
}) {
  const isPinned = value.kind === "pinned";
  const model = isPinned ? catalog.find((m) => m.id === value.modelId) : undefined;

  const rows = catalog.flatMap((m) => [
    { key: `${m.id}::default`, label: m.displayName },
    ...(m.supports1mSuffix ? [{ key: `${m.id}::1m`, label: `${m.displayName} (1M context)` }] : []),
  ]);

  return (
    <div className="model-picker">
      <label>
        <input type="radio" name="model-kind" checked={isPinned}
          onChange={() => onChange({
            kind: "pinned", adapterId: "claude-code", modelId: catalog[0].id,
            contextVariant: "default", effort: (catalog[0].defaultEffort ?? null) as never,
          })} />
        Pinned model
      </label>
      <label>
        <input type="radio" name="model-kind" checked={!isPinned}
          onChange={() => onChange({ kind: "profile", ref: profiles[0].id })} />
        Profile
      </label>

      {isPinned ? (
        <>
          <label htmlFor="model-select">Model</label>
          <select id="model-select" value={`${value.modelId}::${value.contextVariant}`}
            onChange={(e) => {
              const [modelId, variant] = e.target.value.split("::");
              const next = catalog.find((m) => m.id === modelId);
              onChange({
                ...value, modelId,
                contextVariant: variant as "default" | "1m",
                // A new model has its own supported levels; carrying the old
                // effort across could name one this model rejects.
                effort: (next?.defaultEffort ?? null) as never,
              });
            }}>
            {rows.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>

          {model && model.supportedEfforts.length > 0 && (
            <>
              <label htmlFor="effort-select">Effort</label>
              <select id="effort-select" value={value.effort ?? model.defaultEffort ?? ""}
                onChange={(e) => onChange({ ...value, effort: e.target.value as never })}>
                {model.supportedEfforts.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
              </select>
            </>
          )}
        </>
      ) : (
        <select aria-label="Profile" value={value.ref}
          onChange={(e) => onChange({ kind: "profile", ref: e.target.value })}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
      )}
    </div>
  );
}
```

Add to `apps/desktop/src/api.ts`:

```ts
export async function getModelCatalog(): Promise<{
  adapters: { adapterId: string; adapterVersion: string | null; source: string; models: unknown[] }[];
  profiles: { id: string; displayName: string }[];
}> {
  const res = await fetch(`${baseUrl}/v1/model-catalog`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`model catalog: ${res.status}`);
  return res.json();
}
```

Then replace the hardcoded `agentPreference` default at `StepEditor.tsx:65` with the picker's value.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/desktop exec vitest run src/workflows/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workflows/ModelPicker.tsx apps/desktop/src/workflows/ModelPicker.test.tsx apps/desktop/src/workflows/StepEditor.tsx apps/desktop/src/api.ts
git commit -m "feat(desktop): a step names its model and effort the way /model and /effort do"
```

---

### Task 14: The settings catalog view

**Files:**
- Create: `apps/desktop/src/settings/ModelCatalogPanel.tsx`
- Test: `apps/desktop/src/settings/ModelCatalogPanel.test.tsx`

**Interfaces:**
- Consumes: `getModelCatalog` (Task 13).
- Produces: a panel rendering each adapter's source, version, model count, and a refresh control.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/settings/ModelCatalogPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelCatalogPanel } from "./ModelCatalogPanel.js";

const adapters = [
  { adapterId: "claude-code", adapterVersion: "2.1.263", source: "extracted", models: [{ id: "claude-opus-5", displayName: "Opus 5" }] },
  { adapterId: "codex", adapterVersion: null, source: "seed", models: [] },
];

describe("ModelCatalogPanel", () => {
  it("names the CLI version the catalog was read from", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByText(/2\.1\.263/)).toBeInTheDocument();
  });

  it("says plainly when a catalog came from the built-in seed rather than the CLI", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByText(/built-in fallback/i)).toBeInTheDocument();
  });

  it("distinguishes a freshly read catalog from a cached one", () => {
    render(<ModelCatalogPanel adapters={[{ ...adapters[0], source: "cached" }]} onRefresh={() => {}} />);
    expect(screen.getByText(/cached/i)).toBeInTheDocument();
  });

  it("lists the models it found", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByText("Opus 5")).toBeInTheDocument();
  });

  it("offers a refresh control", () => {
    render(<ModelCatalogPanel adapters={adapters} onRefresh={() => {}} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop exec vitest run src/settings/ModelCatalogPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/settings/ModelCatalogPanel.tsx`:

```tsx
interface AdapterCatalog {
  adapterId: string;
  adapterVersion: string | null;
  source: string;
  models: { id: string; displayName: string }[];
}

/**
 * The source line is the point of this panel: a catalog served from the seed or
 * from an old cache is still usable, but the user has to be able to see that it
 * is not what their installed CLI knows today.
 */
const SOURCE_LABEL: Record<string, string> = {
  extracted: "read from the installed CLI",
  cached: "cached from an earlier read",
  seed: "built-in fallback — the CLI could not be read",
};

export function ModelCatalogPanel({ adapters, onRefresh }: {
  adapters: AdapterCatalog[];
  onRefresh: () => void;
}) {
  return (
    <section className="model-catalog-panel">
      <header>
        <h3>Models</h3>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </header>
      {adapters.map((a) => (
        <div key={a.adapterId}>
          <h4>{a.adapterId}</h4>
          <p>
            {SOURCE_LABEL[a.source] ?? a.source}
            {a.adapterVersion ? ` · v${a.adapterVersion}` : ""}
          </p>
          <ul>
            {a.models.map((m) => <li key={m.id}>{m.displayName}</li>)}
          </ul>
        </div>
      ))}
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @orca/desktop exec vitest run src/settings/ModelCatalogPanel.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across contracts, daemon and desktop.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/settings/
git commit -m "feat(desktop): the model catalog says where it came from"
```

---

### Task 15: Live smoke — the model that was asked for is the model that ran

Opt-in, alongside the existing `*.auth-smoke.test.ts` pattern. This is the only check that the flags are the *right* flags rather than merely the flags we intended.

**Files:**
- Create: `apps/daemon/src/adapters/claude-code.model-smoke.test.ts`

**Interfaces:**
- Consumes: `ClaudeCodeAdapter` (Task 7).

- [ ] **Step 1: Write the test**

Create `apps/daemon/src/adapters/claude-code.model-smoke.test.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// Opt-in: needs a real, authenticated claude on PATH and spends tokens.
const RUN = process.env.ORCA_REAL_SMOKE === "1";

describe.skipIf(!RUN)("claude-code accepts the flags Orca sends", () => {
  it("accepts --model and --effort together", async () => {
    const { stdout } = await execFileAsync(
      "claude",
      ["-p", "reply with just: ok", "--model", "claude-opus-5", "--effort", "low"],
      { timeout: 120_000 },
    );
    expect(stdout.toLowerCase()).toContain("ok");
  }, 130_000);

  it("rejects a model that does not exist, so a bad catalog fails loudly", async () => {
    await expect(
      execFileAsync("claude", ["-p", "hi", "--model", "claude-not-a-real-model"], { timeout: 60_000 }),
    ).rejects.toThrow();
  }, 70_000);
});
```

- [ ] **Step 2: Run it against the real CLI**

Run: `ORCA_REAL_SMOKE=1 pnpm --filter @orca/daemon exec vitest run src/adapters/claude-code.model-smoke.test.ts`
Expected: PASS. If the first test fails on the flag rather than the content, the translation in Task 7 is wrong — fix it there.

- [ ] **Step 3: Verify it skips by default**

Run: `pnpm --filter @orca/daemon exec vitest run src/adapters/claude-code.model-smoke.test.ts`
Expected: 2 skipped.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/adapters/claude-code.model-smoke.test.ts
git commit -m "test(daemon): a live check that the CLI accepts the model flags Orca sends"
```

---

### Task 16: Retire the hardcoded catalog

The spec requires un-overloading `MODELS_BY_AGENT_ID`, which today serves both
CLI-driven agent dispatch and the direct-API providers. Task 10 already stopped
dispatch from consulting `supportsModel`, so nothing gates on the old list any
more — but leaving it in place means a second, stale catalog that a future reader
will believe.

Can be done any time after Task 10; must land before the feature is done.

**Files:**
- Delete: `apps/daemon/src/adapters/model-catalog.ts`
- Modify: `apps/daemon/src/llm/anthropic.ts:10-12`, `apps/daemon/src/llm/openai.ts:5-8`
- Modify: `apps/daemon/src/workflows/orchestration-transport/provider-catalog.ts:1-7`
- Modify: `apps/daemon/src/adapters/claude-code.ts`, `codex.ts`, `antigravity.ts` (drop `supportsModel`)
- Modify: `apps/daemon/src/adapters/types.ts` (drop `supportsModel` from `AgentAdapter`)
- Modify: `apps/daemon/src/daemon-context.ts:72-73`

**Interfaces:**
- Consumes: `SEED_CATALOG` (Task 2).
- Produces: `PROVIDER_BY_AGENT_ID` moves to `model-catalog/seed.ts`; `AgentAdapter` no longer declares `supportsModel`.

- [ ] **Step 1: Move `PROVIDER_BY_AGENT_ID` into the new module**

Append to `apps/daemon/src/adapters/model-catalog/seed.ts`:

```ts
import type { ModelProviderId } from "@orca/contracts";

export const PROVIDER_BY_AGENT_ID: Record<string, ModelProviderId | undefined> = {
  "claude-code": "orca/anthropic",
  codex: "orca/openai",
  antigravity: "orca/google",
};
```

- [ ] **Step 2: Repoint the direct-API providers at the seed**

In `apps/daemon/src/llm/anthropic.ts`, replace the import and the `MODELS` const:

```ts
import { SEED_CATALOG } from "../adapters/model-catalog/seed.js";

// The direct-API path advertises the seed, not the extracted catalog: it talks
// to the API with its own key and is not bounded by what a local CLI ships.
const MODELS = (SEED_CATALOG["claude-code"] ?? []).map((m) => ({
  id: m.id,
  displayName: m.displayName,
  capabilities: [] as string[],
}));
```

Apply the same change in `apps/daemon/src/llm/openai.ts` using `SEED_CATALOG.codex`.

In `provider-catalog.ts`, import `PROVIDER_BY_AGENT_ID` from `model-catalog/seed.js` and replace `MODELS_BY_AGENT_ID[agent.id]` with the same `SEED_CATALOG[agent.id]` mapping.

- [ ] **Step 3: Drop `supportsModel`**

Remove the `supportsModel` method from `claude-code.ts`, `codex.ts` and `antigravity.ts`, remove it from the `AgentAdapter` interface in `types.ts`, and remove the `supportsModel` entry from `daemon-context.ts:72-73` and from `ResolveStepDispatchInput` consumers. Delete `apps/daemon/src/adapters/model-catalog.ts`.

- [ ] **Step 4: Run the suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Any test asserting `adapter.supportsModel(...)` should be deleted, not rewritten — catalog membership is now checked by `resolveChoice` and covered by Task 6.

- [ ] **Step 5: Check for orphans**

Run: `pnpm knip`
Expected: no new unused exports. If `adapterSupportsModel` or `AdapterModelInfo` still appear, a consumer was missed.

- [ ] **Step 6: Commit**

```bash
git add -A apps/daemon/src/adapters apps/daemon/src/llm apps/daemon/src/workflows/orchestration-transport apps/daemon/src/daemon-context.ts
git commit -m "refactor(daemon): one model catalog, not two"
```

---

## Post-implementation

After Task 16, update the orientation docs per `CLAUDE.md` (the code wins when it disagrees with `ORCA.md`):

- `ORCA.md:148` — "Agent selection is template-declarative" now understates it: preferences may be profiles, resolution consults an extracted catalog, and the resolved model reaches the spawn. Rewrite that bullet.
- `apps/daemon/src/workflows/templates/catalog.ts:28` — the comment claiming selection "falls back to capability/cost ranking" is finally true. Leave it, or sharpen it to name the resolver.
- `FUTURE_WORK.md` — note that the ambient-default defect is closed and that model-attributed metrics before this land describe models that never ran.
