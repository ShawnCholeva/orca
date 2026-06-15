# Onboarding "Choose workflow templates" Step (Spec B)

**Date:** 2026-06-14
**Status:** Design — pending implementation plan
**Depends on:** Spec A — `2026-06-14-builtin-template-catalog-design.md` (catalog + `GET /catalog` + `POST /install` endpoints)

## Problem

First-launch onboarding currently has three steps: Welcome (0) → Connect agents (1) → Preparing workspace (2). We want a new **"Choose workflow templates"** step between agents and setup, so users pick which built-in workflows to install. The selected templates are persisted as real workflow templates (via Spec A's install endpoint) and therefore appear in the Workflows tab.

The visual target is the Claude Design prototype (`view-onboarding.jsx`). Per its README, we **recreate the design in the real codebase's tech** (React + TypeScript), not copy the prototype's structure. The real onboarding lives in `apps/desktop/src/onboarding/OnboardingView.tsx` with CSS in `onboarding.css`, icons in `glyphs.tsx`, and `.pill`/`.ob-btn` classes.

## Flow

`Welcome (0) → Connect agents (1) → Workflow templates (2) → Preparing workspace (3)`

## Decisions (from brainstorming)

- Template cards are **data-driven from the daemon catalog** (`GET /v1/workflow-templates/catalog`), mirroring how agents are fetched via `listAgents()` — not hardcoded. Avoids drift between card copy and the real template.
- Selection on completion calls **`POST /v1/workflow-templates/install { ids }`** (Spec A). The prototype's `localStorage["orca.workflowTemplates"]` and `window` exports are **dropped** — persistence is the DB install.
- The prototype's `?onboard=1` dev affordance is **dropped** — the user has a local reset script.
- **No roles** — cards show only "N steps" (no role chips).
- Grouping by `category` is data-driven (one section per category in first-seen order with an uppercase mono header + count), so future categories (Product, Design) are additive with no layout change. Today all 7 are `Engineering`.

## Desktop changes

### API — `apps/desktop/src/api.ts` (+ thin wrappers)

Add:
- `listTemplateCatalog(): Promise<BuiltInTemplateSummary[]>` → `GET /v1/workflow-templates/catalog`.
- `installTemplates(ids: string[]): Promise<WorkflowTemplate[]>` → `POST /v1/workflow-templates/install`.

Both typed from `@orca/contracts` (`ListBuiltInTemplateCatalogResponse`, `InstallBuiltInTemplatesRequest/Response`).

### Catalog grouping helper

Add `groupCatalog(list: BuiltInTemplateSummary[]): { category: string; templates: BuiltInTemplateSummary[] }[]` preserving first-seen category order. Small, unit-tested. (Mirrors the prototype's `groupTemplates`, minus the `window` export.)

### `OnboardingView.tsx`

State machine:
- `type Step = 0 | 1 | 2 | 3;`
- Load catalog on mount (alongside the existing agents load); store `catalog: BuiltInTemplateSummary[]`.
- `templates: Record<string, boolean>` selection state, initialised once the catalog loads with `recommended` entries pre-selected; `toggleTemplate(id)`.
- `templateCount = selected count`; `selectedTemplateIds`, `selectedTemplateNames`.

Brand column:
- Step 1 kicker relabelled **"Step 1 of 2"** (currently "Step 1 of 1").
- New step-2 block: kicker **"Step 2 of 2"**, title **"Choose workflow templates"**, prose (from prototype), and an info callout (`.onboarding-info-card`) noting more categories (Product, Design) are coming.
- Step indicator: **4 dots** (`[0,1,2,3]`).

Content body:
- Step 2 → `<TemplateStep groups={groupCatalog(catalog)} selected={templates} onToggle={toggleTemplate} />`.
- `TemplateStep`: one section per category — uppercase mono header + count + hairline rule — each rendering a **2-column grid** of `TemplateCard`.
- `TemplateCard` (selectable `<button>`, same visual language as `AgentCard`): workflow icon, name, `recommended` `.pill`, the `description`, a short **`bestFor` tagline** (its own line, e.g. mono/`--text-3`, prefixed "Best for …") so users see *why* to pick it, and a meta row of **"N steps"** only. Selected state uses `--accent-soft` bg + `--accent-line` border + filled circular check on the right (reuse `.agent-card`/`.agent-card-check` patterns via new `.template-*` classes).

Footer:
- Step 1 "Continue" → step 2 (unchanged disabled-until-one-agent behavior).
- Step 2: Back (→1), live **"N templates selected"** count, Continue → step 3. Continue label becomes **"Skip for now"** when zero selected (still advances).
- Step 3 unchanged (existing readiness gating).

Setup launch (the effect currently keyed on `step === 2`):
- Re-key to **`step === 3`**.
- In that effect, alongside `updateAgentConnection(...)`, call **`installTemplates(selectedTemplateIds)`**. Track success/failure with the existing pattern (`connectionsSaved` style flag + `loadError`); on failure, surface the error and step back to 2 (templates) — symmetric with the current connection-save failure stepping back to 1.

`SetupPanel`:
- Accept `templateNames: string[]` (and/or count).
- Relabel the existing `workflows` task to **"Installing N workflow templates"** with detail = the names (e.g. `"Brainstorm · Feature Implementation +1 more"`), matching the prototype's `tplDetail` formatting. This task stays animated; the real install happens in the OnboardingView effect above (so a failure is caught there, not silently in the animation).

### CSS — `onboarding.css`

Add `.template-grid`, `.template-card`, `.template-card--selected`, `.template-card-icon`, `.template-card-name-row`, `.template-card-desc`, `.template-card-bestfor`, `.template-card-meta`, `.template-card-check`, `.template-group`, `.template-group-header` reusing existing tokens (`--accent-soft`, `--accent-line`, `--panel`, `--panel-2`, `--hairline`, `--hairline-strong`, `--text-2/3/4`). No new colors/primitives.

### Icon — `glyphs.tsx`

Add `WorkflowIcon` (no workflow glyph exists). Reuse the rect+connector motif already used by App.tsx's Workflows tab button.

## Testing

- `groupCatalog` unit test: preserves first-seen category order; groups correctly.
- `OnboardingView.test.tsx` (extend, mocking `listTemplateCatalog`/`installTemplates`):
  - Step 2 renders a card per catalog entry grouped by category, with step counts, `bestFor` taglines, and recommended pills.
  - Recommended templates are pre-selected; footer shows the right count; "Skip for now" appears at zero.
  - Toggle updates selection + count.
  - Back/Continue navigation across all 4 steps; 4 step dots.
  - On reaching setup, `installTemplates` is called with exactly the selected ids; the setup task label reflects the count/names.
  - Install failure surfaces an error and returns to step 2.

## Edge cases

- **Empty catalog / load failure**: step 2 shows an inline error (reuse `.agent-load-error` styling) and Continue acts as "Skip for now". Onboarding never hard-blocks on templates.
- **Zero selected**: valid — install called with `[]` (no-op per Spec A), onboarding completes.
- **Re-onboarding**: install is idempotent (Spec A), so re-selecting already-installed templates is safe.

## Out of scope

- Catalog/endpoints/template authoring (Spec A).
- Roles.
- Editing installed templates in onboarding (done in the Workflows tab as today).
