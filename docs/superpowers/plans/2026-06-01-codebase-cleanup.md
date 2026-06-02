# Codebase Cleanup Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead code, collapse duplicate subsystems, drop unwanted providers, unify the Claude/Codex shadow path behind one provider interface, and restructure directories — safely, in gated phases.

**Architecture:** Audit-first. A read-only Phase 1 produces a decision doc (subsystem map, pivot winners, orphan triage, provider drop-list, unified provider design) gated by user sign-off. Phases 2–6 then execute deletions/consolidation in a fixed safest→riskiest order, each stage guarded by two gates (verification + completeness) and isolated on its own branch with one commit per stage.

**Tech Stack:** pnpm workspaces, TypeScript, vitest, knip (added here), tmux/PTY-backed agent runtime.

---

## Why this plan looks different from a feature plan

This is removal/consolidation work, not greenfield. Two consequences:

1. **No TDD red-green cycle.** The existing ~946-test suite *is* the safety net. The per-stage cycle is: make the change → run the gates → commit. Adding tests is only in scope where Phase 5 introduces the new provider interface.
2. **Phases 2–6 targets come from the audit.** The exact files to delete depend on Phase 1's findings, which don't exist yet. Phase 1's deliverable includes a concrete per-phase checklist of targets. This plan gives Phases 2–6 as an exact *procedure* applied to those audit-supplied targets — not invented file paths.

Do NOT skip Phase 1 sign-off. Every deletion in Phases 2–6 must trace to an approved row in the audit doc.

## Conventions used everywhere

**Gate A (Verification) command block** — run from repo root `/home/shawn/projects/orca`:

```bash
pnpm test        # expect: all suites pass, count >= baseline (see Phase 0)
pnpm typecheck   # expect: no errors
pnpm build       # expect: success, all workspaces
```

Then the **runtime smoke** (manual, ~2 min): boot the daemon, create one Goal, confirm it runs end-to-end through the live tmux/agent path, no errors in the daemon-terminal tmux logs.

**Gate B (Completeness) command block:**

```bash
npx knip                        # intended targets gone; no NEW orphans vs Phase 1 triage
git grep -nE '<removed-symbol>' # expect: no matches (dangling imports/routes/types)
```

Plus: tick every checklist item for the phase with evidence, and run a `cavecrew-reviewer` pass over the phase diff against the checklist.

**Branch/commit model:** one branch per phase (`cleanup/phase-N-<name>`) off `main`; one commit per stage; merge to `main` only after both gates pass. No squashing until gates green.

---

## File Structure (what this plan touches)

- Create: `docs/superpowers/specs/2026-06-01-cleanup-audit.md` — Phase 1 decision artifact
- Create: `knip.json` (repo root) — knip workspace config
- Modify: root `package.json` — add knip dev dep + `knip` script
- Phases 2–6 modify/delete files named by the audit. Subsystems in play (daemon): `orchestrator/`, `workflows/orchestrator/`, `orchestrator-llm/`, `workflows/orchestration-transport/`, `orchestrator-hooks/`, `agent-hooks/`, `adapters/`; plus `packages/contracts` and `apps/desktop` references.
- Phase 5 creates: a `ShadowProvider` interface module + Claude/Codex implementations (exact path decided in Phase 1 §5 design).

---

## Phase 0 — Baseline

**Files:**
- Modify: `package.json` (root)
- Create: `knip.json` (root)
- Create: `docs/superpowers/specs/2026-06-01-cleanup-audit.md` (baseline section only)

- [ ] **Step 1: Confirm clean tree + capture starting SHA**

```bash
cd /home/shawn/projects/orca
git status            # expect: only the known M CLAUDE.md / tsbuildinfo / AGENTS.md, nothing else dirty
git rev-parse --short HEAD
```

- [ ] **Step 2: Record the green baseline**

```bash
pnpm test 2>&1 | tail -20    # record total passed count
pnpm typecheck               # expect: clean
pnpm build                   # expect: success
```

Write the SHA + test count into a new `## Baseline` section of `docs/superpowers/specs/2026-06-01-cleanup-audit.md`.

- [ ] **Step 3: Runtime smoke baseline**

Boot daemon, create one Goal, run it end-to-end. Note in the baseline section that the live path works *before* any change (so later breakage is attributable).

- [ ] **Step 4: Add knip**

```bash
pnpm add -w -D knip
```

Create `knip.json` at root with workspace entry/project globs for `apps/daemon`, `apps/desktop`, `packages/contracts`. Add `"knip": "knip"` to root `package.json` scripts.

- [ ] **Step 5: Capture the knip baseline**

```bash
npx knip > docs/cleanup-knip-baseline.txt 2>&1 || true
```

This raw list feeds Phase 1 triage. Commit.

```bash
git checkout -b cleanup/phase-0-baseline
git add package.json knip.json docs/
git commit -m "chore(cleanup): phase 0 baseline — knip + green snapshot"
```

---

## Phase 1 — Audit (read-only)

**Files:**
- Modify: `docs/superpowers/specs/2026-06-01-cleanup-audit.md` (all sections)

No code changes in this phase. Output is the decision doc defined in the spec (§Phase 1). Each step below produces one section.

- [ ] **Step 1: Subsystem map**

For each suspect dir (`orchestrator/`, `workflows/orchestrator/`, `orchestrator-llm/`, `workflows/orchestration-transport/`, `orchestrator-hooks/`, `agent-hooks/`), fill a row: file count, where it's wired (`git grep` in `server.ts`/`index.ts`), external importer count, last commit date (`git log -1 --format=%cs -- <dir>`), and **runtime-reached?**.

Determine `runtime-reached?` by adding temporary `console.error('REACHED <dir>')` markers at each subsystem entry point, re-running the Phase 0 smoke, and checking the daemon-terminal logs. Remove the markers after (they are not committed).

- [ ] **Step 2: Pivot ledger**

One entry per duplicate pair with proposed winner + evidence + losing files:
`orchestrator/` vs `workflows/orchestrator/`; `orchestrator-llm/` vs `orchestration-transport/`; `orchestrator-hooks/` vs `agent-hooks/`; and within the surviving shadow system, Claude vs Codex path (shared vs forked).

- [ ] **Step 3: Orphan triage**

Walk `docs/cleanup-knip-baseline.txt`. Mark each entry true-dead (delete) or false-positive (keep + reason). Watch for dynamic imports / registry registrations that knip can't see.

- [ ] **Step 4: Provider inventory + drop-list**

For each provider (`claude-code`, `codex`, `opencode`, `gemini`, `shell-manual`) list its adapter, readiness, smoke/auth tests, execution-mode seed, model-catalog entry, registry registration, contract enum value, desktop refs. Drop-list = `opencode`, `gemini`, `shell-manual`.

- [ ] **Step 5: Unified provider design**

Define the `ShadowProvider` interface (members: hook settings, launch command, sentinel/transcript parsing, readiness probe — adjust to actual fork points found in Step 2). Show where Claude/Codex currently fork needlessly. Include an "add a 3rd provider" walkthrough proving the abstraction.

- [ ] **Step 6: Per-phase checklists**

Derive the Gate-B checklist for Phases 2–6 from the findings: exact files to delete (Phases 2–4), exact refactor targets (Phase 5), exact dir moves (Phase 6).

- [ ] **Step 7: Commit + request sign-off**

```bash
git add docs/superpowers/specs/2026-06-01-cleanup-audit.md
git commit -m "docs(cleanup): phase 1 audit — subsystem map, pivot winners, provider drop-list, unified design"
```

**STOP. Present the audit to the user. Do not start Phase 2 until the user approves winners, orphan triage, provider drops, and the unified design.**

---

## Phases 2–6 — Execution procedure

Each phase below follows the **same procedure**, applied to the targets the Phase 1 checklist supplies. Run as: one branch per phase, one commit per stage, both gates at phase end.

### Phase 2 — Prune orphans

**Targets:** the true-dead entries from audit Step 3 (daemon + desktop + contracts).

- [ ] **Step 1:** `git checkout -b cleanup/phase-2-orphans`
- [ ] **Step 2:** Delete one orphan cluster (a file or a tight group). For each deletion also remove imports your deletion orphaned.
- [ ] **Step 3:** Run Gate A. Expected: green at baseline count, build ok, smoke ok.
- [ ] **Step 4:** `git commit -m "refactor(cleanup): remove orphan <name>"`. Repeat Steps 2–4 per cluster.
- [ ] **Step 5:** Run Gate B (`npx knip` shows targets gone + no new orphans; `git grep` clean; reviewer pass). Merge to `main`.

### Phase 3 — Consolidate duplicate subsystems

**Targets:** the losing variant of each pivot in audit Step 2, including the losing shadow-execution system end-to-end (routes, reconcilers, contracts, desktop clients).

- [ ] **Step 1:** `git checkout -b cleanup/phase-3-consolidate`
- [ ] **Step 2:** Remove one losing subsystem at a time. Start by deleting its route registration in `server.ts`/`index.ts`, then its reconcilers, then the dir, then orphaned contracts + desktop clients.
- [ ] **Step 3:** Run Gate A after each subsystem. The runtime smoke is critical here — a losing shadow system may be wired but the smoke proves the surviving path still drives a Goal.
- [ ] **Step 4:** `git commit -m "refactor(cleanup): drop superseded <subsystem>"`. Repeat per subsystem.
- [ ] **Step 5:** Run Gate B. Merge to `main`.

### Phase 4 — Drop providers

**Targets:** `opencode`, `gemini`, `shell-manual` — every artifact from audit Step 4.

- [ ] **Step 1:** `git checkout -b cleanup/phase-4-drop-providers`
- [ ] **Step 2:** Remove one provider fully: adapter, readiness, smoke/auth tests, execution-mode seed, model-catalog entry, registry registration, contract enum value, desktop UI refs. (Contract enum change may need a contracts rebuild — `pnpm --filter @orca/contracts build`.)
- [ ] **Step 3:** Run Gate A. Watch for: contract enum exhaustiveness errors in tsc (these are the trail to remaining refs — good).
- [ ] **Step 4:** `git commit -m "refactor(cleanup): remove <provider> provider"`. Repeat per provider.
- [ ] **Step 5:** Run Gate B. `git grep -niE 'opencode|gemini|shell-manual'` expect: no live refs (only historical docs/specs acceptable). Merge to `main`.

### Phase 5 — Unify providers

**Targets:** the `ShadowProvider` interface + Claude/Codex implementations from audit Step 5. This is the one phase that adds code and tests.

- [ ] **Step 1:** `git checkout -b cleanup/phase-5-unify-providers`
- [ ] **Step 2: Write a failing test** for the provider registry: assert both `claude-code` and `codex` resolve to a `ShadowProvider` exposing the interface members, and that an unknown id throws.
- [ ] **Step 3:** Run it; expect FAIL (interface/registry not yet defined).
- [ ] **Step 4:** Introduce the `ShadowProvider` interface + registry; implement Claude and Codex against it; move provider-specific branches behind the interface.
- [ ] **Step 5:** Run the test; expect PASS. Run Gate A.
- [ ] **Step 6:** Replace each remaining `if (provider === 'codex'|'claude-code')` branch in orchestration code with an interface call. Run Gate A after each replacement. Commit per replacement.
- [ ] **Step 7: Acceptance** — execute the audit's "add a 3rd provider" walkthrough as a thought-test: confirm it reduces to *implement interface + register*, zero edits to orchestration core. If not, fix the interface before declaring done.
- [ ] **Step 8:** Run Gate B. Merge to `main`.

### Phase 6 — Restructure

**Targets:** the dir moves from audit Step 6 (collapse `orchestrator*` naming sprawl to match surviving arch).

- [ ] **Step 1:** `git checkout -b cleanup/phase-6-restructure`
- [ ] **Step 2:** `git mv` one dir/file group; update all imports (`git grep` the old path, rewrite).
- [ ] **Step 3:** Run Gate A. Mechanical only — behaviour must be identical.
- [ ] **Step 4:** `git commit -m "refactor(cleanup): rename <old> -> <new>"`. Repeat per move.
- [ ] **Step 5:** Run Gate B (`npx knip` clean; reviewer confirms no behavioural change in diff). Merge to `main`.

---

## Final verification

- [ ] Run full Gate A one last time on `main` after Phase 6 merge.
- [ ] `npx knip` from a clean tree: no orphans remain beyond the documented keep-list.
- [ ] Update `MEMORY.md` project notes: record cleanup completion + final SHA.
- [ ] Confirm README / CLAUDE.md provider references match the surviving two providers (Claude Code, Codex) — fix if drifted (in-scope because the build/docs must stay honest).
