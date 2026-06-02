# Codebase Cleanup Pass — Design

**Date:** 2026-06-01
**Status:** Approved (design); plan to follow
**Scope:** `apps/daemon`, `apps/desktop`, `packages/contracts`

## Problem

Two weeks of rapid direction pivots left the codebase carrying multiple
overlapping implementations of the same concepts, abandoned leaf code, and a
directory layout that reflects superseded mental models. The duplicates are not
cleanly dead — most losing variants are still wired into `server.ts` / `index.ts`,
so naive deletion is unsafe.

Concrete pivot fingerprints (daemon):

- `orchestrator/` (8 files, wired in `index.ts`) vs `workflows/orchestrator/`
  (48 files, the large live subsystem)
- `orchestrator-llm/` (23 files — shadow-session LLM mediator) vs
  `workflows/orchestration-transport/` (16 files — hidden-worker drivers): two
  parallel shadow-execution systems
- `orchestrator-hooks/` (2 files) vs `agent-hooks/` (4 files): two hook route
  registrars
- Within each shadow system, separate Claude and Codex code paths
  (`hidden-worker/drivers/{claude,codex}.ts`, `one-shot/codex.ts`,
  `orchestrator-llm/model-provider-llm-client.ts`)
- Five adapters present (`claude-code`, `codex`, `opencode`, `gemini`,
  `shell-manual`); only `claude-code` and `codex` are kept going forward

## Goals

1. Delete genuinely dead / orphaned code across all three packages.
2. Collapse duplicate subsystems to a single surviving variant each.
3. Drop unwanted providers: `opencode`, `gemini`, `shell-manual`.
4. Unify the surviving Claude and Codex shadow paths behind one provider
   interface so adding a provider = implement one interface.
5. Restructure directory/naming to match the surviving architecture.

Non-goals: docs/spec reconciliation beyond what's needed to keep the build and
this design honest; behavioural feature changes; unrelated refactors.

## Approach

Tool-baseline + manual winner-calls, executed in staged, gated phases.

- **Static tooling** (`knip`, workspace-aware) produces a cheap machine list of
  unused files/exports/deps across all three packages. Tools cannot judge the
  duplicate *subsystems* (both variants are "used"), so:
- **Manual wiring trace + runtime smoke** decides which variant of each pivot
  survives. Runtime smoke distinguishes *wired* from *actually executed*, which
  is what catches dead-but-wired traps.

Rejected alternatives: manual-only audit (slow over ~488 files, misses leaf
orphans); big-bang branch rebuild (giant unverifiable diff, loses history
granularity, violates the smoke-per-removal safety bar).

## Phases

Phases are sequential hard gates. Nothing in a later phase starts until the
prior phase passes **both** gates (defined below).

```
0  BASELINE        green snapshot + runtime smoke + install/configure knip
1  AUDIT (RO)      map subsystems + providers + both shadow systems;
                   propose pivot winners + unified provider design   → SIGN-OFF
2  PRUNE ORPHANS   delete tool-confirmed dead leaves
3  CONSOLIDATE     remove duplicate-subsystem losers (picks winning shadow system)
4  DROP PROVIDERS  opencode, gemini, shell-manual
5  UNIFY PROVIDERS one provider interface; Claude + Codex implement it;
                   prove "add provider = implement 1 interface"
6  RESTRUCTURE     rename/move dirs to match surviving architecture
```

Ordering rationale:

- Pure orphans (2) go before judgment-heavy consolidation (3) — they cannot
  break anything live and shrink the surface first.
- Drop-providers (4) before unify (5) — fewer providers to fold into the shared
  interface.
- Restructure (6) last — don't rename dirs/files that earlier phases delete.

### Phase 0 — Baseline

Establish the safety net is real before touching anything.

- Run `pnpm test` + `pnpm typecheck` + `pnpm build`; record pass counts.
- Runtime smoke: boot daemon, run one Goal end-to-end (live tmux/agent path).
- Install `knip` as a root dev dependency; add minimal workspace config.
- Record baseline SHA + green counts in the audit doc as the reference point.

### Phase 1 — Audit (read-only)

Produces `docs/superpowers/specs/2026-06-01-cleanup-audit.md`, the decision
artifact every later deletion traces to. Contents:

1. **Subsystem map** — table per suspect dir: `dir | files | wired via |
   external importers | last commit | runtime-reached?`. The
   `runtime-reached?` column comes from the smoke run with logging and
   distinguishes wired from actually executed.
2. **Pivot ledger** — one entry per duplicate pair, each with proposed winner +
   evidence + losing files to delete:
   - `orchestrator/` vs `workflows/orchestrator/`
   - `orchestrator-llm/` vs `orchestration-transport/` (shadow-system pick)
   - `orchestrator-hooks/` vs `agent-hooks/`
   - within surviving shadow system: Claude vs Codex path — shared vs forked
3. **Orphan list** — triaged `knip` output: true-dead (delete) vs
   false-positive (keep, with reason); spans daemon + desktop + contracts.
4. **Provider inventory** — per provider (claude-code / codex / opencode /
   gemini / shell-manual): adapter, readiness, smoke tests, execution-modes,
   model-catalog refs. Drop-list for Phase 4 = opencode, gemini, shell-manual.
5. **Proposed unified provider design** — the Phase 5 target interface, where
   current code forks needlessly, and an "add a 3rd provider" walkthrough
   proving the abstraction.
6. **Per-phase plan checklists** — the Gate-B checklist for phases 2–6.

**Sign-off gate:** user approves winners, orphan triage, provider drops, and
the unified design before any code moves.

### Phase 2 — Prune orphans

Delete `knip`-confirmed, audit-triaged dead leaves (unused files, exports,
deps). Remove import orphans created by your own deletions; leave pre-existing
unrelated dead code unless it's on the triaged list.

### Phase 3 — Consolidate duplicate subsystems

Remove the losing variant of each pivot pair per the audit ledger. Includes
selecting the surviving shadow-execution system and deleting the other end to
end (routes, reconcilers, contracts, desktop clients).

### Phase 4 — Drop providers

Remove `opencode`, `gemini`, and `shell-manual`:
adapters, readiness, smoke/auth tests, execution-mode seeds, model-catalog
entries, registry registrations, contract enums, and desktop UI references.

### Phase 5 — Unify providers

Converge Claude and Codex onto one `ShadowProvider` interface. Everything
provider-specific (hook settings, launch command, sentinel/transcript parsing,
readiness probe) sits behind the interface; orchestration code calls the
interface and never branches on provider id. The hidden-worker
`drivers/registry.ts` is the seed pattern.

**Acceptance:** the "add a 3rd provider" walkthrough must reduce to *implement
the interface + register it*, with zero edits to orchestration core. If not,
the abstraction is wrong and is fixed before Phase 5 is declared done.

### Phase 6 — Restructure

Rename/move directories so layout matches the surviving architecture (e.g.
collapse the `orchestrator*` naming sprawl). Mechanical moves only; no
behavioural change.

## Per-Phase Gates

Every phase (2–6; 0 and 1 have their own completion criteria above) ends with
two gates. Both must pass before the next phase starts.

```
GATE A — Verification (didn't break)
  pnpm test green · pnpm typecheck clean · pnpm build ok
  runtime smoke: 1 Goal end-to-end

GATE B — Completeness (did everything, only that)
  every plan checklist item for the phase ticked, with evidence
  re-run knip: intended targets gone AND no new orphans created
  grep sweep: no dangling imports, routes, registry entries, contract types
  diff review against phase spec — nothing in scope skipped, nothing
    out-of-scope touched
```

Gate B runs as an independent `cavecrew-reviewer` pass over the phase diff +
plan checklist for a second look.

## Git / Rollback Model

- Each phase = its own branch off `main`, merged only after both gates pass.
- Each stage within a phase = one commit, so a late regression bisects to a
  single stage and reverts cleanly.
- No squashing until a phase's gates are green — granular history is the undo
  button.
- Phase 0 records baseline SHA + green counts as the reference point.

## Risks

- **Dead-but-wired code:** mitigated by the `runtime-reached?` audit column and
  the per-phase runtime smoke.
- **Shadow-system pick is wrong:** mitigated by routing it through the Phase 1
  sign-off gate with evidence, not assumption.
- **Provider drop misses a reference:** mitigated by the Gate-B grep sweep
  across adapters, contracts, execution-modes, model-catalog, and desktop.
- **knip false positives** (esp. dynamic imports / plugin registries):
  triaged in the audit, not deleted blind.
```
