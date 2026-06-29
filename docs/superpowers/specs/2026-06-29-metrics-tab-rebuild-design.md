# Metrics Tab Rebuild — Design

**Date:** 2026-06-29
**Status:** Approved design, pending implementation plan
**Area:** `apps/desktop` (Metrics tab)

## Problem

The desktop app's **Metrics** tab (`App.tsx`, `activeTab === "reasoning"`) currently
renders a plain "Runtime Diagnostics" card listing plugins and skills. It looks
nothing like the approved design mock. We are rebuilding the tab to match the
mock: an operational-intelligence surface that shows how every step of each
workflow is performing, what's failing, and what Orca proposes to change about
its own instructions to fix itself (the self-teaching loop).

The design mock is the `view-metrics.jsx` prototype in the `claude.ai/design`
project "Orca" (`019e296c-6c2e-70e4-b82a-3bbedd10dd21`). This spec ports that
mock into the real app.

## Decisions (settled)

1. **Data source — mock now, real-data seam.** The mock's fidelity (per-step
   pass/recover/fail counts, 12-point score trends, ranked failure modes,
   self-improvement proposals with confidence/lift) has **no backing in the
   daemon today** — `harness-metrics/` is transition provenance/attribution, not
   step performance scoring. This surface is forward-looking (the learning loop
   in FUTURE_ARCHITECTURE is a *destination*). We ship a faithful visual port
   driven by a typed mock module behind a single `getWorkflowMetrics()` seam, so
   real telemetry can replace the data later without changing the view.
2. **Faithful visual port.** Same layout, components, and behavior as the mock;
   no redesign.
3. **Convert to app conventions.** The mock is React-via-Babel-standalone with
   inline styles and `Object.assign(window, …)`. The app is Vite + React +
   TypeScript with per-feature CSS-class styling. Port into typed components +
   scoped CSS.

## What already aligns (no work needed)

- **Tokens are 1:1.** `apps/desktop/src/theme/themes.ts` defines the exact token
  set the mock uses (`--panel`, `--panel-2`, `--raised`, `--hairline(-strong)`,
  `--accent`, `--accent-2`, `--run/--warn/--err/--info` and all `-soft`
  variants). Colors port with zero remapping.
- **Some primitives exist.** `apps/desktop/src/workspaces/primitives.tsx` exports
  TS `Btn`, `Pill`, `Tip`. These are reused. No `Panel` exists — we add a small
  local one.
- **Global CSS helpers exist.** `.mono`, `.scroll`, `@keyframes float-in`,
  `@keyframes pulse-dot` are already in `theme.css`.

## Architecture

New feature folder `apps/desktop/src/metrics/`, matching the existing per-feature
pattern (`workspaces/`, `workflows/`, `orchestrator/`):

| File | Responsibility |
|------|----------------|
| `metrics-data.ts` | Typed mock data: `WorkflowMetrics[]` + `LearningLogEntry[]`, plus the `getWorkflowMetrics()` / `getLearningLog()` seam. Exports the types (`WorkflowMetrics`, `StepMetrics`, `Proposal`, `FailureMode`, `LearningLogEntry`). |
| `MetricsPage.tsx` | Top-level view. Owns selected-workflow + period + open-step state. Two-column grid layout. |
| `metrics-components.tsx` | Presentational sub-components: `Sparkline`, `Delta`, `OutcomeBar`, `StatTile`, `StepRow`, `WorkflowDropdown`, `ImprovementCard`, `ProposalModal`, `LearningLogRow`, local `Panel`, `SectionLabel`. (Split into more files only if it grows unwieldy.) |
| `metrics.css` | Scoped styles using existing tokens. Replaces the mock's inline styles. |

**Helpers** `statusMeta` and `gradeFor` move into `metrics-data.ts` (pure,
data-adjacent).

### Layout (from the mock)

- Two-column grid `minmax(0,1fr) 340px`, 12px gap, full-height, internal scroll
  only.
- **Left column:**
  - `WorkflowDropdown` selector + `24h / 7d / 30d` period toggle.
  - KPI strip: Workflow health (lettered grade), First-pass %, Self-recovered %,
    Escalated % — each a `StatTile` with delta + sparkline. Delta color reflects
    whether the movement is *good* for that metric (escalations down = green).
  - "Step performance" `Panel`: expandable `StepRow` per step — index, name,
    status `Pill`, pass/recover/fail `OutcomeBar`, runs·latency, trend sparkline,
    score /100, Δ. Expanding reveals ranked failure-mode bars + an Orca insight
    line.
- **Right rail:** "Self-improvement / ORCA LEARNS" — `ImprovementCard` per
  degraded/watch step, each opening a `ProposalModal` (before/after instruction
  diff, confidence bar, Apply). The `LEARNING_LOG` timeline renders below the
  cards. Bottom: auto-apply-above-90%-confidence toggle.

### Wiring into `App.tsx`

- Replace the `activeTab === "reasoning"` body (the Runtime Diagnostics `<section
  className="reasoning-pane">`) with `<section …><MetricsPage /></section>`.
- The tab label stays "Metrics"; the internal key `"reasoning"` is left as-is to
  avoid churn unless trivially renamable.

## Cleanup (orphans created by this change)

The `diagnostics` machinery in `App.tsx` is used **only** by the Metrics tab body
we are replacing: state `diagnostics` / `diagnosticsLoading` / `diagnosticsError`,
the `Diagnostics` type, `loadDiagnostics()`, its call in the daemon-reachable
effect, and the `PluginSummary` / `SkillSummary` imports. Removing the tab body
orphans all of it. Per "clean up your own mess," we remove it. **Flag:** if the
diagnostics fetch is intentionally kept as a daemon warm-up or is consumed
elsewhere, leave the fetch and only drop the render — to be confirmed during
implementation by re-grepping usages.

## Fixes folded in while porting

The mock has two latent bugs; we fix them in the port rather than reproduce them:

1. **`LEARNING_LOG` never rendered.** The mock defines the data and a
   `LearningLogRow` component but never mounts them. We render the timeline in the
   right rail.
2. **Half-empty expanded row.** The mock's expanded `StepRow` uses a 2-column grid
   for steps that have a `proposal` but only renders the failure-modes panel,
   leaving the right half blank. We render a single-column failure-modes/insight
   block (proposals already live in the right rail), removing the empty column.

## Out of scope

- Any daemon-side metrics aggregation or API (deferred to the real-data phase).
- Wiring `Apply` / `Auto-apply` to real instruction mutation — these stay local
  UI state (optimistic), matching the mock.
- Light-theme-specific tuning beyond what the shared tokens already provide.
- The other design-mock views (sessions, workspaces, command, onboarding).

## Testing

- A `MetricsPage.test.tsx` (Vitest + Testing Library, matching existing
  `*.test.tsx` conventions) covering: renders KPI strip for the default workflow;
  switching the `WorkflowDropdown` swaps the step list; expanding a `StepRow`
  reveals its failure modes + insight; opening an `ImprovementCard` shows the
  `ProposalModal` before/after; `LEARNING_LOG` entries render.
- Type-check + existing lint pass.

## Success criteria

1. Metrics tab visually matches the mock (two-column, KPI strip, step
   performance, ORCA LEARNS rail, learning log, auto-apply toggle).
2. Driven entirely by `metrics-data.ts` behind `getWorkflowMetrics()`; no view
   code reads mock literals directly.
3. The two mock bugs (unrendered learning log, half-empty expanded row) are fixed.
4. Runtime Diagnostics code is removed (or its fetch retained per the flag above)
   with no orphaned symbols.
5. New tests pass; type-check and lint clean.
