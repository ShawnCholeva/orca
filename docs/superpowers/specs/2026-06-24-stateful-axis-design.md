# Stateful Axis — Design Spec (Phase 5)

**Status:** approved (brainstorm), pending implementation plan.
**Refines** §4.3 of `2026-06-23-harness-axes-design.md` with the locked decisions below. This is the LAST of the four reliability axes (Executable ✓, Governed ✓, Inspectable ✓, Stateful = this).
**Builds on:** the merged `HarnessTransition` spine + the three tight facets (`risk`, `evidence`, `telemetry`). `stateDeps` is the ONE remaining opaque `z.record` facet — this plan tightens it, completing the facet model.

## 1. Goal

Make the harness **Stateful**: every `HarnessTransition` carries a strict `StateDepsFacet` (read_set, write_set, structured assumptions, version_deps, conflict_policy); a deterministic engine detects state conflicts (overlapping read/write-sets) and belief-divergence (actions built on superseded state) across concurrent sessions, and surfaces them — escalating to human review or emitting a non-blocking warning per policy — feeding Inspectable's now-live `state_consistency` metric. Scope: the **Stateful core (§4.3 design points 1–5)**. Experiential memory (§4.3-6 = roadmap Phase 6) is OUT.

## 2. Grounded problem (from §4.3)

Memory + context assembly are solid, but coordination is thin: conflict detection is **lexical only** (Jaccard + negation over decision titles, `conflicts/detectors.ts:342-381`); **no read/write sets** (`grep read_set` = 0); assumptions are a free-text memory *type*, not structured; no belief-divergence; multi-session overlap is detected post-hoc (`detectWorkspaceOverlap`), never surfaced as a transition-level signal.

## 3. Locked decisions

- **D1 — Scope: Stateful core (P1 + P2).** StateDepsFacet + read_set + write_set + structured assumptions + version_deps + deterministic conflict detection + belief-divergence. Experiential-memory template promotion deferred to Phase 6.
- **D2 — Conflict response: detect + surface; escalate per policy; NO auto-merge.** On a detected conflict: record it on the StateDepsFacet + a conflict transition (feeding `state_consistency`); then `conflict_policy="escalate"` → pause the affected step via the EXISTING human-review gate; `conflict_policy="auto"` → record + emit a warning event, both sessions proceed (non-blocking, detect-don't-prevent). The engine NEVER auto-merges conflicting writes or picks a winner.
- **D3 — write_set derived deterministically.** The engine infers write_set from observed effects (git diff of the workspace → file refs + change_kind; memory/decision rows the step created). NO agent-output-schema change, no instruction change, can't be forgotten or gamed. read_set is likewise derived (from the existing context fingerprint). `assumptions` consume the execution step's EXISTING free-text `assumptions[]` if present (structured into `{statement, verified:false}`), else empty — also no new agent requirement.
- **D4 — Deterministic conflict detection + a pluggable `ConflictJudge` seam (NO LLM this plan).** Overlap detection is pure code. The `ConflictJudge` seam is built as an interface whose ONLY implementation this plan is a no-op default that treats every overlap as a real conflict. The LLM semantic judge (gated behind the deterministic overlap signal) is a later drop-in behind the seam — zero rework. Mirrors the `SpawnSandbox`/extractor seam pattern. No AI cost, no nondeterminism in this plan.
- **D5 — Concurrency model: optimistic (declare + detect + escalate), no locks.** Sessions run freely; the engine detects overlap/staleness and raises a conflict. Pessimistic locking / single-writer serialization were considered and rejected (too heavy for L4 multi-session).

## 4. Design

### 4.1 `StateDepsFacet` (tighten the last opaque facet)
Tighten `HarnessTransition.stateDeps` from `z.record(z.unknown()).nullable()` to `StateDepsFacet.nullable()`:
```
StateDepsFacet {
  read_set:    [{ kind: "file"|"memory_item"|"decision"|"task"|"workspace_version", ref: string, version: string|null }]
  write_set:   [{ kind: "file"|"memory_item"|"decision"|"task"|"workspace_version", ref: string, change_kind: "created"|"modified"|"deleted" }]
  assumptions: [{ statement: string, source_ref: string|null, verified: boolean }]
  version_deps:[{ ref: string, observed_version: string }]
  conflict_policy: "auto" | "escalate"
}
```
Apply the contract-tightening discipline (the Phase-2/3/4 lesson): the SAME task updates `RecordTransitionInput.stateDeps` in `harness-transitions/usecases.ts`, runs `pnpm --filter @orca/daemon typecheck`, and rebuilds the contracts dist. After this, ALL FOUR facets (`risk`/`evidence`/`telemetry`/`stateDeps`) are strict — the facet model is complete.

### 4.2 Populating the facet (P1 + the derived parts of P2) — all deterministic
1. **`read_set` (P1, ⚡ derivable).** ≈ the inputs the context `sourceFingerprint` already hashes (`context/input.ts:184-215`): the memory/decision IDs + versions that fed the step's context. Captured at step launch.
2. **`write_set` (P2, derived).** At step completion, from observed effects: git diff of the workspace (changed files → `{kind:"file", ref:path, change_kind}`) + memory/decision rows created by the step. Reuse the daemon's existing lazy/bounded git inspection.
3. **`assumptions` (P2).** Consume the execution step's existing free-text `assumptions[]` (the `execution` step already carries them), structured into `{statement, source_ref:null, verified:false}`. If absent → empty. No new agent instruction/schema.
4. **`version_deps` (P2).** From the existing lazy/bounded git inspection (observed workspace version) + the memory/decision versions in read_set.
5. **`conflict_policy`.** Default `escalate` (fail-safe: a conflict pauses for human unless the goal opts into `auto`). Sourced per-goal — reuse the operating_mode-adjacent settings pattern if a per-goal field is warranted, else a sensible default constant (decided at plan time via recon).

### 4.3 Conflict + belief-divergence engine (P2) — deterministic, detect-and-surface
1. **Deterministic overlap detector (pure code).** Two transitions on the same goal/workspace conflict when their read/write-sets overlap on the same `ref`: write-write (both write the ref) or read-stale (one reads a ref another has rewritten). Across files, memory, decisions — broader than the existing lexical decision-title detector (which stays for its current purpose; this is a NEW signal).
2. **`ConflictJudge` seam.** Interface `judge(candidate: ConflictCandidate): "real" | "false_positive"`. ONLY implementation this plan: `noopConflictJudge` returning `"real"` for every candidate. The LLM judge (gated behind the deterministic overlap signal, reusing the `SessionMemoryExtractor` LLM seam) is a documented later drop-in. No LLM call in this plan.
3. **Belief-divergence (deterministic).** When a transition's `read_set`/`version_deps` reference a memory item or workspace version that has SINCE changed, the action was built on stale belief. The engine compares recorded vs current versions (extends the `sourceFingerprint` staleness signal from "package stale" to "action built on superseded state").
4. **Response (per D2).** A detected conflict/divergence is recorded on the facet + a conflict transition. Then: `escalate` → pause the affected step via the existing human-review gate; `auto` → record + emit a warning event, both proceed. No auto-merge.
5. **Where it runs (recon-first at plan time).** Candidate: evaluate overlap when a transition is recorded, against other un-merged concurrent transitions on the same goal/workspace. "Concurrent" = overlapping in wall-clock across sessions not yet merged/closed. The exact trigger point + the concurrent-set query are pinned in the plan after recon.

### 4.4 Feeds Inspectable
`state_consistency` (the six-metric `/harness-metrics` fold, currently graceful-degrading to `null` with reason "StateDepsFacet not yet emitted") lights up automatically once StateDepsFacet is recorded — NO Inspectable rewrite. Verify the metric's stateDeps read matches this facet's shape (the Inspectable Task 8 review noted a guessed `{conflict?:boolean}` shape in its unreachable branch — reconcile it here).

## 5. Internal phasing (one plan)
- **P1:** `StateDepsFacet` contract (tighten) + `read_set` derived from the context fingerprint, recorded on the launch/step transitions.
- **P2:** `write_set` (git-diff + created rows) + structured `assumptions` + `version_deps`; the deterministic overlap detector + `ConflictJudge` seam (no-op) + belief-divergence; the escalate/warn response; reconcile the Inspectable `state_consistency` read.

## 6. Recon-first items (before the relevant tasks)
1. **`sourceFingerprint` exact shape** (`context/input.ts:184-215`) — the IDs/versions it hashes, to derive read_set faithfully.
2. **Workspace git-diff API** — the daemon's existing lazy/bounded git inspection (`detectWorkspaceOverlap` neighborhood) — its function + return shape, to derive write_set.
3. **The transition-record trigger + concurrent-set query** — where to run the overlap check and how to select "other concurrent un-merged transitions on the same goal/workspace."
4. **The human-review gate reuse** — the existing pause/escalation path (Governed/Inspectable used it) — confirm the API to pause a step on `escalate`.
5. **Inspectable `state_consistency` read** — its exact expectation of the stateDeps shape, to reconcile §4.4.

## 7. Non-goals (explicit)
- **No LLM conflict-judge** (seam only this plan; deterministic overlap = conflict).
- **No pessimistic locking / single-writer serialization** (optimistic detect-don't-prevent).
- **No auto-merge / winner-picking** of conflicting writes (escalate or warn only).
- **No experiential-memory template promotion** (roadmap Phase 6 / L5).
- **No agent step-output schema or instruction change** (read_set/write_set/version_deps derived; assumptions consume what already exists).
- **No new cross-goal/global state** (stays within the per-goal model).

## 8. Constraints (inherited)
Contracts idiom (`z` schema + inferred type, `.strict()`, datetime); contract-tightening lesson (tighten facet ⇒ update `RecordTransitionInput.stateDeps` + daemon typecheck + rebuild dist in the same task); daemon subsystem idiom (prepared-stmt caching + `resetPreparedStatements`; route registrars; stage events in a txn then publish); fail-closed defaults (unknown → safe; default `conflict_policy=escalate`); migrations append to `migrationFiles` with the next free number (the Inspectable axis added none; confirm the next free number at plan time) + additive snapshot-test updates; known flakes (`http-surface`, `human-review`, now 15s timeout) are not regressions.
