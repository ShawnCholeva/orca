# Per-node model selection & CLI-derived model catalog

**Date:** 2026-09-07
**Status:** Design approved, pending implementation plan

## Problem

Two capabilities are wanted:

1. Specify a model for a given node in a workflow.
2. Choose from models actually available in the locally-installed agent CLIs, so
   that upgrading a CLI outside Orca (e.g. gaining Fable 5.1) makes the new model
   selectable without editing Orca source.

Investigation found the first capability is **wired but inert**, and the second
is served by a hardcoded list that is already stale.

### Finding 1 — the selected model is recorded but never applied

The selection pipeline is complete on paper. Every step/gate template carries an
ordered `agentPreference[]` of `{adapterId, modelId}`; `resolveStepDispatch`
(`workflows/orchestrator/step-dispatch.ts`) picks the first ready adapter that
supports the model; the winner is persisted via `recordOperatorSelection`, on
transport attempts, and on step-result scoring.

Nothing passes that model to the process that runs:

- `AdapterSpawnInput` (`adapters/types.ts:20`) has no model field.
- `ClaudeCodeAdapter.resolveSpawn` returns `args: []` (`adapters/claude-code.ts:47`).
- `WorkerSpawnInput` (`workflows/orchestrator/worker-session.ts:67`) has no model
  field; the tmux command is `input.command + hookCfg.spawnArgs`.

`buildSpawnEnv` inherits `HOME` (`readiness/exec.ts:33`), so every worker reads
the developer's own `~/.claude/settings.json`. On the machine this was
investigated on that file contains `"model": "opus[1m]"` and
`"effortLevel": "high"`.

**Consequence:** every claude-code worker runs Opus 5 (1M context) at high
effort, including steps whose template declares `LIGHT` / `claude-haiku-4-5`.
The `agentPreference` is silently overridden by an ambient personal default, and
the database records a model that never ran. This is both a cost problem and a
metrics-integrity problem: model-attributed measurements currently describe
models that were not used.

### Finding 2 — the catalog is hardcoded, stale, and overloaded

`adapters/model-catalog.ts` hardcodes `MODELS_BY_AGENT_ID`. It lists
`claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`, while the installed
CLI (2.1.263) knows `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`.

`supportsModel()` gates dispatch on this list, so a model absent from it makes
the step throw `no ready agent`. Adding a newly-pulled model requires a source
edit.

The same constant also backs `llm/anthropic.ts` and `llm/openai.ts` and the
goal-creation orchestrator picker, so one list serves two unrelated purposes:
CLI-driven agent workers, and direct API model providers.

### Finding 3 — selection ranking does not exist

`workflows/templates/catalog.ts:28` documents that selection "falls back to
capability/cost ranking". `resolveStepDispatch` is a first-match-wins loop. The
ranking is aspirational.

### Finding 4 — the CLI ships a structured catalog

The claude-code bundle embeds a complete first-party model catalog. A verbatim
record extracted from 2.1.263:

```js
{ id:"claude-opus-5", family:"opus", display_name:"Opus 5",
  knowledge_cutoff:"May 2026",
  context:{ window:1e6, native_1m:!0, supports_1m_beta:!0, supports_1m_suffix:!0 },
  max_output_tokens:{ default:64000, upper:128000 },
  pricing:"tier_5_25",
  capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking", ...],
  default_effort:"high",
  effort_cost_index:{ low:0.67, medium:0.76, high:1, xhigh:1.6, max:1.7 },
  advisor_rank:4 }
```

19 models carry a clean `id -> display_name` mapping (`Opus 5`, `Fable 5.1`,
`Sonnet 5`, `Mythos 5.1`, ...). This supplies, first-party: cost (`pricing`),
strength ordering (`advisor_rank`), context capability (`context.window`,
`supports_1m_suffix`), which effort levels a model supports (`max_effort` /
`xhigh_effort` flags), its `default_effort`, and a per-effort cost multiplier.

There is no read API for this. `modelPicker` and `availableModels` are
write-side settings, not queries. An unknown model does fail cleanly and
detectably: `[claude-code:unrecognized_model]`.

### Finding 5 — providers are asymmetric

- **claude-code**: full structured catalog as above; effort via `--effort`
  (`low|medium|high|xhigh|max`).
- **codex**: bundle yields bare ids only (`gpt-5.5`, `gpt-5.5-pro`,
  `gpt-5.4-mini`, `gpt-5.3-codex`) with no display names, pricing, or context
  windows. Effort is `-c model_reasoning_effort=...`, not `--effort`.
- **antigravity**: a third shape; its worker permission gate is also not yet
  wired (`ORCA.md:182`).

## Decisions

| Question | Decision |
|---|---|
| Control surface | Template step editor **and** a tier map |
| Tier semantics | Requirement profiles resolved at dispatch, not fixed model lists |
| Metadata source | Extract from installed CLI, cache keyed by CLI version, fall back to checked-in seed |
| Node expression | Tagged union: pinned triple **or** profile reference (approach A) |
| Context variant | Its own field, not baked into the model id string |
| v1 provider scope | claude-code fully; provider-agnostic seams for codex/antigravity |

### Architectural-direction check

`FUTURE_ARCHITECTURE.md:96` makes "hooks / events over stdout scraping" a hard
rule. Reading a minified JS blob out of an installed binary is adjacent to that
rule and was flagged explicitly before adoption. The distinction relied upon:
the hard rule governs **runtime orchestration signals** — never scrape to learn
what an agent did — whereas catalog extraction reads **static configuration data
outside the orchestration loop**, at configuration time, cached by version. This
was a conscious, user-made decision rather than an implicit one. The mitigations
in "Risks" exist because the coupling is real.

Relatedly, this work moves toward the Runner Protocol split
(`FUTURE_ARCHITECTURE.md:114`): the resolved model choice becomes an explicit
part of the spawn contract rather than ambient host state, which is a
precondition for spawning across a network boundary where `~/.claude` does not
exist.

## Design

### 1. Contracts

```ts
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

// What actually runs, and what gets recorded.
type ResolvedModelChoice = {
  adapterId: AdapterId;
  modelId: string;                    // catalog id, e.g. "claude-opus-5"
  contextVariant: "default" | "1m";   // validated vs catalog.context.supports_1m_suffix
  effort: EffortLevel | null;         // null ONLY where the adapter exposes no
                                      // effort axis (antigravity today)
};

type NodeModelSelection =
  | { kind: "pinned"; adapterId: AdapterId; modelId: string;
      contextVariant: "default" | "1m"; effort: EffortLevel | null }
  | { kind: "profile"; ref: string };
```

`agentPreference[]` remains an ordered fallback list; each entry becomes a
`NodeModelSelection`. Both arms resolve to `ResolvedModelChoice` before anything
is spawned or recorded, so there is one dispatch path.

**Effort is never left unset on an adapter that has one.** A `pinned` entry may
author `effort: null` (and every legacy entry does). Resolution fills it from the
chosen model's catalog `default_effort`; a `profile` fills it from
`preferredEffort`, falling back to `default_effort`. `ResolvedModelChoice.effort`
is therefore null only for an adapter with no effort axis. This matters because
omitting `--effort` would let the ambient `effortLevel` govern — the exact
failure in Finding 1.

**No migration for template JSON.** A zod `.transform` reads a legacy
`{adapterId, modelId}` entry as `{kind:"pinned", contextVariant:"default",
effort:null}`, so existing `workflow_templates` rows and every captured
`template_snapshot` keep parsing unchanged.

### 2. Model profiles

The CLI's `capabilities` array holds internal feature flags
(`opus_5_prompt_bundle`, `lean_prompt`, `refusal_fallback`), **not** semantic
task ability. Profiles therefore constrain only axes that are first-party and
derivable. Semantic tags such as "good at code editing" are deliberately absent:
they are not in the data, and hand-authoring them would recreate the staleness
this project exists to remove.

```ts
type ModelProfile = {
  id: string;                  // "deep-reasoning"
  displayName: string;
  requires: {
    minStrength?: number;      // advisor_rank
    maxPricingTier?: string;   // ordered by parsing the tier's numerals:
                               // "tier_5_25" (\$5/\$25 per Mtok) < "tier_10_50".
                               // An unparseable tier sorts last and is excluded
                               // from a bounded profile rather than assumed cheap.
    minContextWindow?: number; // context.window
    needsEffortLevel?: EffortLevel;  // gated by max_effort / xhigh_effort flags
  };
  preferredEffort?: EffortLevel;
  rank: "cheapest" | "strongest";    // tie-break direction
};
```

Seeded with `LIGHT` / `EXECUTION` / `REASONING` so the existing built-in
templates keep resolving. Requires no hand-tagging and cannot go stale.

### 3. Catalog subsystem

New directory `apps/daemon/src/adapters/model-catalog/`:

- **`extract-claude.ts`** — resolve the binary (reusing `resolveBinary` and the
  `ORCA_CLAUDE_CODE_BIN` override), read the version through the existing
  `checkInstalled()` path, scan for `{id:"claude-` records, parse to typed
  models. The records are *minified JS*, not JSON (`!0` for true, unquoted keys,
  `1e6` numerics), so this needs a small tolerant parser rather than
  `JSON.parse`. Bounded and fixture-testable.
- **`store.ts`** — `model_catalog_cache(adapter_id, adapter_version,
  extracted_at, payload_json, source)`, keyed by adapter + version. The ~199 MB
  scan runs only when the version string changes, never per dispatch.
- **`seed.ts`** — checked-in fallback; replaces today's `MODELS_BY_AGENT_ID`.
- **`resolve.ts`** — profile to concrete model, plus the ranking that
  `catalog.ts:28` already claims exists.

Fallback chain: `extracted(current version)` -> last-known-good cache -> checked-in
seed. The active source is exposed as
`catalogSource: "extracted" | "cached" | "seed"` so the UI can show staleness
rather than present a stale list as current.

Splitting this out also un-overloads the constant: the direct-API providers
(`llm/anthropic.ts`, `llm/openai.ts`) read the seed, while agent dispatch reads
the resolved catalog.

### 4. Spawn plumbing

- `AdapterSpawnInput` gains `model?: ResolvedModelChoice`.
- New `AgentAdapter.modelSpawnArgs(choice): string[]`:
  - `claude-code` -> `["--model", id + (variant === "1m" ? "[1m]" : ""), "--effort", effort]`
  - `codex` -> `["-m", id, "-c", "model_reasoning_effort=" + effort]` (seam built; effort UI deferred)
  - `antigravity` -> `["--model", id]`
- `WorkerSpawnInput` carries the resolved choice; `worker-session.spawn()`
  appends the args to the tmux command string, using the existing quoting rule.

**On the ambient default.** Also writing `model` / `effortLevel` into the
private `settings.json` that `workerHookConfig` already emits was considered and
**rejected**: a CLI flag outranks settings, making it redundant defensive code.
Instead:

- Always pass **both** flags. Passing `--model` alone would leave the ambient
  `effortLevel` governing.
- If no model resolves, dispatch **fails loudly**. `resolveStepDispatch` already
  throws `no ready agent`; that behaviour stays. There is no silent fall-through
  to ambient host configuration.

### 5. Recording what ran

`recordOperatorSelection` stores the resolved triple. The existing `model`
column takes the full dispatch string (`claude-opus-5[1m]`), preserving the
"distinguish providers by model prefix" convention that `FUTURE_WORK.md:64`
depends on, plus **one new nullable `effort` column** (migration).

Without this the metrics remain misattributed, merely differently.

### 6. UI

- **StepEditor** — a model picker mirroring `/model`: display names from the
  catalog, grouped by family, with `(1M context)` rows offered only where
  `supports_1m_suffix` is true. An effort control mirroring `/effort`,
  constrained to the levels that model's flags actually support and preselected
  at its `default_effort`. A toggle authors a profile reference instead of a pin.
- **Settings** — catalog view: source badge, detected CLI version, refresh
  button, resolved model list.

### 7. Testing

- Extractor against real fixture strings captured from 2.1.263; plus malformed
  and absent inputs asserting the fallback chain, never a crash.
- Resolver: profile to expected model over a fixed catalog.
- Spawn-arg translation: table-driven per adapter.
- **Invariant test: the recorded model equals the model in the spawn command.**
  This is the deterministic sensor whose absence allowed Finding 1 to persist.
- Opt-in live smoke alongside the existing `*.auth-smoke.test.ts` /
  `real-smoke.test-support.ts`, launching with `--model X` and asserting the
  session reports X.

## Risks

- **Extraction couples to an unsupported interface.** Mitigated by version-keyed
  caching, the three-step fallback, and a visible source badge. The failure mode
  is a visibly stale catalog, never a silent wrong answer.
- **`advisor_rank` semantics are inferred, not documented.** Use for ordering
  only; never as an absolute score, and never surfaced to the user as one.
- **codex / antigravity carry no metadata**, so their profiles resolve over a
  hand-listed set. Accepted under the v1 scope decision.

## Non-goals

- Predicted per-node cost from `pricing` + `effort_cost_index`, and validating it
  against measured `cost_usd` from OTLP. Real and enabled by this work, but not
  this project.
- Effort UI for codex and antigravity. The translation seam is built; the
  surface is deferred until needed.
- Semantic capability tags on models.
- Per-goal or per-run model override. The approved control surfaces are the
  template step editor and the profile map.
