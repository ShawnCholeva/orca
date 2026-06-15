# Onboarding "Choose workflow templates" Step — Implementation Plan (Spec B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-driven "Choose workflow templates" step (step 2 of the onboarding wizard) that fetches the built-in template catalog, lets the user select templates, and installs the selection via the daemon on setup — so chosen templates appear in the Workflows tab.

**Architecture:** `OnboardingView.tsx` grows from a 3-step to a 4-step machine (`0` Welcome → `1` Connect agents → `2` Templates → `3` Setup). Template cards render from `GET /v1/workflow-templates/catalog` (mirroring how agents are fetched, not hardcoded). On entering setup, the existing connection-save effect also calls `POST /v1/workflow-templates/install` with the selected ids. No `localStorage`, no `window` exports, no `?onboard=1`.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest (jsdom/happy-dom via manual `createRoot`).

**Spec:** `docs/superpowers/specs/2026-06-14-onboarding-workflow-templates-design.md`.

**Depends on Spec A** (`docs/superpowers/plans/2026-06-14-builtin-template-catalog.md`): the catalog/install endpoints and the `BuiltInTemplateSummary`, `ListBuiltInTemplateCatalogResponse`, `InstallBuiltInTemplatesRequest/Response` contracts. **Do not start this plan until Spec A is merged and `pnpm --filter @orca/contracts build` has been run.**

**Conventions:**
- Desktop tests: `pnpm --filter @orca/desktop test -- <path>`. Typecheck: `pnpm --filter @orca/desktop typecheck`.
- The onboarding component test mocks the api module via `vi.mock("../api", …)` — every api function the component imports must appear in that factory.
- Commit after each task.

---

## File map

- **Modify** `apps/desktop/src/api.ts` — `listTemplateCatalog()`, `installTemplates(ids)`.
- **Modify** `apps/desktop/src/api.test.ts` — tests for the two new wrappers.
- **Create** `apps/desktop/src/onboarding/groupCatalog.ts` — first-seen-order grouping helper.
- **Create** `apps/desktop/src/onboarding/groupCatalog.test.ts`.
- **Modify** `apps/desktop/src/onboarding/glyphs.tsx` — `WorkflowIcon`.
- **Modify** `apps/desktop/src/onboarding/onboarding.css` — `.template-*` classes.
- **Modify** `apps/desktop/src/onboarding/OnboardingView.tsx` — 4-step machine, `TemplateStep`/`TemplateCard`, install wiring, `SetupPanel` label.
- **Modify** `apps/desktop/src/onboarding/OnboardingView.test.tsx` — step-2 coverage.

No `App.tsx` change is needed — install happens inside `OnboardingView`, and `onComplete` is unchanged.

---

## Task 1: API wrappers — catalog + install

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: `apps/desktop/src/api.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/api.test.ts`, inside the same `describe` block that defines `fetchMock`/`jsonResponse`, add:

```ts
it("listTemplateCatalog GETs the catalog and returns summaries", async () => {
  const summary = {
    id: "orca/brainstorm", name: "Brainstorm", category: "Engineering",
    recommended: true, description: "desc", bestFor: "tagline", stepCount: 6,
  };
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { catalog: [summary] }));
  const out = await (await import("./api")).listTemplateCatalog();
  expect(out).toEqual([summary]);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toContain("/v1/workflow-templates/catalog");
  expect(init?.method ?? "GET").toBe("GET");
});

it("installTemplates POSTs the selected ids and returns templates", async () => {
  const template = {
    id: "orca/brainstorm", name: "Brainstorm", description: "d", version: 1,
    isBuiltIn: true, isLocked: true,
    steps: [{ id: "frame", ordinal: 0, name: "Frame", instructions: "x",
      outputSchema: [{ key: "problem", type: "string", required: true }],
      agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }] }],
    guardrails: [], createdAt: now, updatedAt: now, scope: "global", scopeName: "", graph: null,
  };
  fetchMock.mockResolvedValueOnce(jsonResponse(201, { templates: [template] }));
  const out = await (await import("./api")).installTemplates(["orca/brainstorm"]);
  expect(out.map((t) => t.id)).toEqual(["orca/brainstorm"]);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toContain("/v1/workflow-templates/install");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ ids: ["orca/brainstorm"] });
});
```

> If the file imports api functions statically at the top instead of `await import("./api")`, follow that style instead — match the surrounding tests.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- src/api.test.ts`
Expected: FAIL — `listTemplateCatalog`/`installTemplates` are not exported.

- [ ] **Step 3: Implement the wrappers**

In `apps/desktop/src/api.ts`, add to the `@orca/contracts` import list:

```ts
  ListBuiltInTemplateCatalogResponse,
  InstallBuiltInTemplatesResponse,
  type BuiltInTemplateSummary,
  type WorkflowTemplate,
```

Then add (near the other workflow-template-free GET/POST helpers):

```ts
export async function listTemplateCatalog(): Promise<BuiltInTemplateSummary[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/workflow-templates/catalog`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new ApiError(`List template catalog failed (${res.status})`);
  }
  const body = await parseResponse(res, ListBuiltInTemplateCatalogResponse);
  return body.catalog;
}

export async function installTemplates(ids: string[]): Promise<WorkflowTemplate[]> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/workflow-templates/install`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ ids }),
    },
    InstallBuiltInTemplatesResponse,
    "Install workflow templates failed",
  );
  return body.templates;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/desktop test -- src/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts
git commit -m "feat(desktop): api wrappers for template catalog + install"
```

---

## Task 2: `groupCatalog` helper

**Files:**
- Create: `apps/desktop/src/onboarding/groupCatalog.ts`
- Test: `apps/desktop/src/onboarding/groupCatalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/onboarding/groupCatalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BuiltInTemplateSummary } from "@orca/contracts";
import { groupCatalog } from "./groupCatalog";

function s(id: string, category: string): BuiltInTemplateSummary {
  return { id, name: id, category, recommended: false, description: "d", bestFor: "b", stepCount: 3 };
}

describe("groupCatalog", () => {
  it("groups by category preserving first-seen order", () => {
    const out = groupCatalog([s("a", "Engineering"), s("b", "Product"), s("c", "Engineering")]);
    expect(out.map((g) => g.category)).toEqual(["Engineering", "Product"]);
    expect(out[0].templates.map((t) => t.id)).toEqual(["a", "c"]);
    expect(out[1].templates.map((t) => t.id)).toEqual(["b"]);
  });

  it("returns [] for empty input", () => {
    expect(groupCatalog([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- src/onboarding/groupCatalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/onboarding/groupCatalog.ts`:

```ts
import type { BuiltInTemplateSummary } from "@orca/contracts";

export interface CatalogGroup {
  category: string;
  templates: BuiltInTemplateSummary[];
}

// Group templates by category, preserving the order each category is first seen.
export function groupCatalog(list: BuiltInTemplateSummary[]): CatalogGroup[] {
  const order: string[] = [];
  const byCategory: Record<string, BuiltInTemplateSummary[]> = {};
  for (const t of list) {
    if (!byCategory[t.category]) {
      byCategory[t.category] = [];
      order.push(t.category);
    }
    byCategory[t.category].push(t);
  }
  return order.map((category) => ({ category, templates: byCategory[category] }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @orca/desktop test -- src/onboarding/groupCatalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/onboarding/groupCatalog.ts apps/desktop/src/onboarding/groupCatalog.test.ts
git commit -m "feat(desktop): groupCatalog helper for onboarding templates"
```

---

## Task 3: WorkflowIcon glyph + template CSS

**Files:**
- Modify: `apps/desktop/src/onboarding/glyphs.tsx`
- Modify: `apps/desktop/src/onboarding/onboarding.css`

(Support task — visual scaffolding, no behavioral test; verified by typecheck and Task 4.)

- [ ] **Step 1: Add `WorkflowIcon` to `glyphs.tsx`**

Append to `apps/desktop/src/onboarding/glyphs.tsx`:

```tsx
export function WorkflowIcon({ size = 15, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="9" y="15" width="6" height="6" rx="1" />
      <path d="M6 9v3h12V9M12 12v3" />
    </svg>
  );
}
```

- [ ] **Step 2: Add `.template-*` classes to `onboarding.css`**

Append to `apps/desktop/src/onboarding/onboarding.css` (reuses existing tokens; introduces no new colors):

```css
/* ── Workflow template step ───────────────────────────── */
.template-load-error {
  width: 100%;
  max-width: 720px;
  margin: 0 auto 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--err-soft);
  color: var(--err);
  font-size: 12.5px;
}

.template-step {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.template-group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.template-group-title {
  font-size: 0.7rem;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--text-2);
  font-weight: 600;
}

.template-group-count {
  font-size: 0.65rem;
  color: var(--text-4);
}

.template-group-rule {
  flex: 1;
  height: 1px;
  background: var(--hairline);
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.template-card {
  all: unset;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--panel);
  border: 1px solid var(--hairline);
  border-radius: 12px;
  cursor: pointer;
  position: relative;
  transition: background 120ms ease, border-color 120ms ease;
}

.template-card:hover {
  border-color: var(--hairline-strong);
}

.template-card--selected,
.template-card--selected:hover {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}

.template-card-name-row {
  display: flex;
  align-items: center;
  gap: 9px;
}

.template-card-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex-shrink: 0;
  background: var(--panel-2);
  border: 1px solid var(--hairline);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
}

.template-card--selected .template-card-icon {
  color: var(--accent);
}

.template-card-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text);
}

.template-card-desc {
  font-size: 0.78rem;
  color: var(--text-2);
  line-height: 1.5;
}

.template-card-bestfor {
  font-size: 0.7rem;
  color: var(--text-3);
  line-height: 1.45;
}

.template-card-meta {
  font-size: 0.625rem;
  color: var(--text-3);
}

.template-card-check {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: auto;
  background: transparent;
  border: 1.5px solid var(--hairline-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 120ms ease, border-color 120ms ease;
}

.template-card--selected .template-card-check {
  background: var(--accent);
  border-color: var(--accent);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @orca/desktop typecheck`
Expected: PASS (no unused-import error — `WorkflowIcon` is consumed in Task 4; if your toolchain flags it before Task 4, do Task 4 in the same commit boundary).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/onboarding/glyphs.tsx apps/desktop/src/onboarding/onboarding.css
git commit -m "feat(desktop): workflow template card styles + icon"
```

---

## Task 4: OnboardingView — 4-step machine, template step, install wiring

**Files:**
- Modify: `apps/desktop/src/onboarding/OnboardingView.tsx`
- Test: `apps/desktop/src/onboarding/OnboardingView.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `OnboardingView.test.tsx`, extend the `vi.mock("../api", …)` factory to include the two new functions:

```ts
vi.mock("../api", () => ({
  listAgents: vi.fn(),
  updateAgentConnection: vi.fn(),
  runReadinessCheck: vi.fn(),
  runReadinessCheckForAgent: vi.fn(),
  runSystemReadinessCheck: vi.fn(),
  listTemplateCatalog: vi.fn(),
  installTemplates: vi.fn(),
}));
```

Add a catalog fixture near `SEED_AGENTS`:

```ts
import type { BuiltInTemplateSummary } from "@orca/contracts";

const SEED_CATALOG: BuiltInTemplateSummary[] = [
  { id: "orca/brainstorm", name: "Brainstorm", category: "Engineering", recommended: true, description: "Frame and propose.", bestFor: "Exploring an idea.", stepCount: 6 },
  { id: "orca/code-review", name: "Code Review", category: "Engineering", recommended: false, description: "Review a diff.", bestFor: "A second-pass review.", stepCount: 3 },
];
```

In `beforeEach`, add default resolutions:

```ts
vi.mocked(api.listTemplateCatalog).mockResolvedValue(SEED_CATALOG);
vi.mocked(api.installTemplates).mockResolvedValue([]);
```

Add these tests (use the same `createRoot`/`act`/`waitFor` rendering and the same step-advance approach the existing tests use; click by visible text via a small local helper if the file doesn't already have one):

```ts
it("step 2 lists a card per catalog entry with step counts and recommended pills", async () => {
  // render, advance: Get started -> select an agent -> Continue (to step 2)
  const { container } = await renderAndAdvanceToTemplates();
  expect(container.textContent).toContain("Choose workflow templates");
  expect(container.textContent).toContain("Brainstorm");
  expect(container.textContent).toContain("Code Review");
  expect(container.textContent).toContain("6 steps");
  expect(container.textContent).toContain("Exploring an idea.");
  // recommended Brainstorm is preselected -> footer count is 1
  expect(container.textContent).toContain("1 template selected");
});

it("toggling a template updates the selected count", async () => {
  const { container } = await renderAndAdvanceToTemplates();
  const codeReview = container.querySelector('[data-template-id="orca/code-review"]') as HTMLButtonElement;
  await act(async () => { codeReview.click(); });
  expect(container.textContent).toContain("2 templates selected");
});

it("shows 'Skip for now' when zero templates are selected", async () => {
  const { container } = await renderAndAdvanceToTemplates();
  const brainstorm = container.querySelector('[data-template-id="orca/brainstorm"]') as HTMLButtonElement;
  await act(async () => { brainstorm.click(); }); // deselect the one recommended
  expect(container.textContent).toContain("Skip for now");
});

it("installs the selected template ids when setup begins", async () => {
  const { container } = await renderAndAdvanceToTemplates();
  // Continue (step 2 -> step 3 setup)
  clickByText(container, "Continue");
  await waitFor(() => {
    expect(vi.mocked(api.installTemplates)).toHaveBeenCalledWith(["orca/brainstorm"]);
  });
  expect(container.textContent).toContain("Installing 1 workflow template");
});
```

> Implement `renderAndAdvanceToTemplates()` and `clickByText()` using the file's existing render harness: render `OnboardingView` (wrapped in `ThemeProvider`) with `onComplete = vi.fn()`, `await waitFor` for agents to load, click the "Get started" button, click the `[data-agent-id="claude-code"]` card to enable Continue, click "Continue" to reach step 2, then `await waitFor` for `Brainstorm` to appear. Reuse whatever existing helper the file already has for rendering/advancing rather than duplicating it.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @orca/desktop test -- src/onboarding/OnboardingView.test.tsx`
Expected: FAIL — step 2 / template UI does not exist yet.

- [ ] **Step 3: Update imports + state in `OnboardingView.tsx`**

Extend the api import:

```ts
import {
  listAgents,
  updateAgentConnection,
  runReadinessCheckForAgent,
  runSystemReadinessCheck,
  listTemplateCatalog,
  installTemplates,
} from "../api";
```

Add contract + glyph imports:

```ts
import type { Agent, AgentReadinessReport, SystemReadinessReport, BuiltInTemplateSummary } from "@orca/contracts";
```

```ts
import { /* existing glyphs… */ WorkflowIcon } from "./glyphs";
import { groupCatalog } from "./groupCatalog";
```

Change the `Step` type and add state:

```ts
type Step = 0 | 1 | 2 | 3;
```

Inside the component, after the existing `selected` state, add:

```ts
const [catalog, setCatalog] = useState<BuiltInTemplateSummary[]>([]);
const [templates, setTemplates] = useState<Record<string, boolean>>({});
const [templateError, setTemplateError] = useState<string | null>(null);
```

- [ ] **Step 4: Load the catalog on mount**

Add this effect next to the existing agents-loading effect:

```ts
useEffect(() => {
  let cancelled = false;
  listTemplateCatalog()
    .then((rows) => {
      if (cancelled) return;
      setCatalog(rows);
      const next: Record<string, boolean> = {};
      for (const t of rows) if (t.recommended) next[t.id] = true;
      setTemplates(next);
    })
    .catch((err: unknown) => {
      if (cancelled) return;
      setTemplateError(err instanceof Error ? err.message : "Failed to load workflow templates");
    });
  return () => { cancelled = true; };
}, []);
```

Add derived values + toggle near the existing `selectedCount`/`toggle`:

```ts
const templateCount = useMemo(
  () => Object.values(templates).filter(Boolean).length,
  [templates],
);
const selectedTemplateIds = useMemo(
  () => Object.entries(templates).filter(([, v]) => v).map(([k]) => k),
  [templates],
);
const selectedTemplateNames = useMemo(
  () => catalog.filter((t) => templates[t.id]).map((t) => t.name),
  [catalog, templates],
);
function toggleTemplate(id: string) {
  setTemplates((s) => ({ ...s, [id]: !s[id] }));
}
```

- [ ] **Step 5: Re-key the setup effect to step 3 and install templates**

Replace the existing `useEffect(() => { if (step !== 2) return; … }, [step])` block with:

```ts
useEffect(() => {
  if (step !== 3) return;
  let cancelled = false;
  setConnectionsSaved(false);
  setReadinessState({ settled: false, systemReady: false, agentReadyCount: 0 });
  (async () => {
    try {
      const updated = await Promise.all(
        agents.map((a) => updateAgentConnection(a.id, !!selected[a.id])),
      );
      if (cancelled) return;
      setAgents(updated);
    } catch (err) {
      if (cancelled) return;
      setLoadError(err instanceof Error ? err.message : "Failed to save selections");
      setStep(1);
      return;
    }
    try {
      await installTemplates(selectedTemplateIds);
    } catch (err) {
      if (cancelled) return;
      setTemplateError(err instanceof Error ? err.message : "Failed to install workflow templates");
      setStep(2);
      return;
    }
    if (cancelled) return;
    // connectionsSaved gates SetupPanel auto-completion; set it only after both
    // connections AND templates have been persisted so onComplete waits for both.
    setConnectionsSaved(true);
  })();
  return () => { cancelled = true; };
  // Runs once on entering setup; captures step-1/step-2 choices. See note on deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [step]);
```

- [ ] **Step 6: Brand column — relabel step 1, add step 2 block, 4 dots**

Change the step-1 kicker text from `Step 1 of 1` to `Step 1 of 2`. Add a new brand block after the `{step === 1 && (…)}` block:

```tsx
{step === 2 && (
  <>
    <div className="mono onboarding-kicker">Step 2 of 2</div>
    <h1 className="onboarding-title onboarding-title--sm">Choose workflow templates</h1>
    <p className="onboarding-prose onboarding-prose--narrow">
      A workflow turns a goal into a repeatable sequence of steps. Start from a template — you can edit any step or add your own anytime.
    </p>
    <div className="onboarding-info-card">
      <span className="onboarding-info-card-icon">
        <InfoIcon size={14} />
      </span>
      <div className="onboarding-info-card-text">
        More categories — Product, Design, and others — are on the way. For now, pick the Engineering workflows your team runs most.
      </div>
    </div>
  </>
)}
```

Change the step-dots array from `{[0, 1, 2].map(…)}` to `{[0, 1, 2, 3].map(…)}`.

The existing `{step === 2 && (…)}` brand block that currently says "Setting up / Preparing your workspace" must become `{step === 3 && (…)}`.

- [ ] **Step 7: Content body — insert template step, move setup to step 3**

In the content body, after the `{step === 1 && (…)}` agent grid, add:

```tsx
{step === 2 && (
  <div className="template-step">
    {templateError && (
      <div className="template-load-error" role="alert">{templateError}</div>
    )}
    <TemplateStep
      groups={groupCatalog(catalog)}
      selected={templates}
      onToggle={toggleTemplate}
    />
  </div>
)}
```

Change the existing setup render guard from `{step === 2 && (` to `{step === 3 && (` and pass template names to the panel:

```tsx
{step === 3 && (
  <SetupPanel
    agents={agents.filter((a) => selected[a.id])}
    connectionsSaved={connectionsSaved}
    templateNames={selectedTemplateNames}
    runOne={runReadinessCheckForAgent}
    runSystem={runSystemReadinessCheck}
    onOpenUrl={openExternal}
    onComplete={(ids) => onComplete(ids)}
    onChange={setReadinessState}
  />
)}
```

- [ ] **Step 8: Footer — step 2 controls, fix navigation targets**

Replace the footer's button wiring so the steps chain correctly. The footer should be:

```tsx
<footer className="onboarding-footer">
  {step === 1 && (
    <button type="button" className="ob-btn ob-btn--quiet" onClick={() => setStep(0)}>
      <ChevronLeftIcon />
      Back
    </button>
  )}
  {step === 2 && (
    <button type="button" className="ob-btn ob-btn--quiet" onClick={() => setStep(1)}>
      <ChevronLeftIcon />
      Back
    </button>
  )}
  <div style={{ flex: 1 }} />
  {step === 1 && (
    <span className="mono onboarding-footer-meta">
      {selectedCount} {selectedCount === 1 ? "agent" : "agents"} selected
    </span>
  )}
  {step === 2 && (
    <span className="mono onboarding-footer-meta">
      {templateCount} {templateCount === 1 ? "template" : "templates"} selected
    </span>
  )}
  {step === 0 && (
    <button type="button" className="ob-btn ob-btn--primary" onClick={() => setStep(1)}>
      Get started
      <ArrowRightIcon />
    </button>
  )}
  {step === 1 && (
    <button type="button" className="ob-btn ob-btn--primary" onClick={() => setStep(2)} disabled={selectedCount === 0}>
      Continue
      <ArrowRightIcon />
    </button>
  )}
  {step === 2 && (
    <button type="button" className="ob-btn ob-btn--primary" onClick={() => setStep(3)}>
      {templateCount === 0 ? "Skip for now" : "Continue"}
      <ArrowRightIcon />
    </button>
  )}
  {step === 3 && (
    <>
      <button type="button" className="ob-btn ob-btn--quiet" onClick={() => setStep(2)}>
        <ChevronLeftIcon />
        Back
      </button>
      <div style={{ flex: 1 }} />
      {readinessState.settled && readinessState.systemReady && readinessState.agentReadyCount === 0 && (
        <button type="button" className="ob-btn ob-btn--secondary" onClick={() => onComplete(agents.filter((a) => selected[a.id]).map((a) => a.id))}>
          Continue anyway
        </button>
      )}
      <button
        type="button"
        className="ob-btn ob-btn--primary"
        onClick={() => onComplete(agents.filter((a) => selected[a.id]).map((a) => a.id))}
        disabled={!readinessState.settled || !readinessState.systemReady || readinessState.agentReadyCount === 0}
      >
        Continue
        <ArrowRightIcon />
      </button>
    </>
  )}
</footer>
```

(The previous `finish()` helper that did `setStep(2)` is now inlined as `setStep(2)`/`setStep(3)`; remove the unused `finish` function.)

- [ ] **Step 9: SetupPanel — accept `templateNames`, relabel the workflows task**

Add `templateNames` to the `SetupPanel` props type and destructure it:

```ts
function SetupPanel({
  agents,
  connectionsSaved,
  templateNames,
  runOne,
  runSystem,
  onOpenUrl,
  onComplete,
  onChange,
}: {
  agents: Agent[];
  connectionsSaved: boolean;
  templateNames: string[];
  runOne: (id: string) => Promise<AgentReadinessReport>;
  runSystem: () => Promise<SystemReadinessReport>;
  onOpenUrl: (url: string) => Promise<void>;
  onComplete: (agentIds: string[]) => void;
  onChange: (s: { settled: boolean; systemReady: boolean; agentReadyCount: number }) => void;
}) {
```

Replace the `workflows` task entry in the `tasks` `useMemo` with:

```ts
    {
      id: "workflows",
      label: templateNames.length === 0
        ? "Skipping workflow templates"
        : `Installing ${templateNames.length} workflow ${templateNames.length === 1 ? "template" : "templates"}`,
      detail: templateNames.length === 0
        ? "Add them anytime in the Workflows tab"
        : templateNames.length <= 2
          ? templateNames.join(" · ")
          : `${templateNames.slice(0, 2).join(" · ")} +${templateNames.length - 2} more`,
    },
```

Add `templateNames` to that `useMemo`'s dependency array (alongside `agents`): `}, [agents, templateNames]);`.

- [ ] **Step 10: Add `TemplateStep` + `TemplateCard` components**

Add near the existing `AgentGrid`/`AgentCard` definitions:

```tsx
function TemplateStep({
  groups,
  selected,
  onToggle,
}: {
  groups: { category: string; templates: BuiltInTemplateSummary[] }[];
  selected: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  return (
    <>
      {groups.map((g) => (
        <div key={g.category} className="template-group">
          <div className="template-group-header">
            <span className="mono template-group-title">{g.category}</span>
            <span className="mono template-group-count">{g.templates.length}</span>
            <div className="template-group-rule" />
          </div>
          <div className="template-grid">
            {g.templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                selected={!!selected[t.id]}
                onToggle={() => onToggle(t.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function TemplateCard({
  template,
  selected,
  onToggle,
}: {
  template: BuiltInTemplateSummary;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={"template-card" + (selected ? " template-card--selected" : "")}
      data-template-id={template.id}
    >
      <div className="template-card-name-row">
        <span className="template-card-icon">
          <WorkflowIcon size={15} />
        </span>
        <span className="template-card-name">{template.name}</span>
        {template.recommended && <span className="pill">recommended</span>}
        <span className="template-card-check" aria-hidden="true">
          {selected && <CheckIcon size={12} color="#fff" strokeWidth={2.5} />}
        </span>
      </div>
      <div className="template-card-desc">{template.description}</div>
      <div className="template-card-bestfor">Best for {lowerFirst(template.bestFor)}</div>
      <div className="mono template-card-meta">
        {template.stepCount} {template.stepCount === 1 ? "step" : "steps"}
      </div>
    </button>
  );
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `pnpm --filter @orca/desktop test -- src/onboarding/OnboardingView.test.tsx`
Expected: PASS. If pre-existing tests asserted "Step 1 of 1" or 3 dots, update them to the new labels/counts (these are intentional spec changes).

- [ ] **Step 12: Typecheck + full desktop test run**

Run: `pnpm --filter @orca/desktop typecheck && pnpm --filter @orca/desktop test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/onboarding/OnboardingView.tsx apps/desktop/src/onboarding/OnboardingView.test.tsx
git commit -m "feat(desktop): onboarding workflow templates step (select + install)"
```

---

## Self-Review

**Spec coverage:**
- Flow `0→1→2→3` with new template step → Task 4 (Step type, brand, content, footer) ✅.
- Cards data-driven from `GET /catalog` (`listTemplateCatalog`), recommended pre-selected → Tasks 1, 4 (mount effect) ✅.
- Install via `POST /install` on setup; localStorage/`window`/`?onboard=1` dropped → Task 4 (Step 5 effect); never introduced ✅.
- No roles — card shows description + `bestFor` + "N steps" only → Task 4 (`TemplateCard`) ✅.
- Data-driven category grouping (header + count, first-seen order) → Tasks 2, 4 (`TemplateStep`) ✅.
- Brand "Step 1 of 2"/"Step 2 of 2" + info callout, 4 dots → Task 4 Step 6 ✅.
- Footer: back, live count, "Skip for now" at zero → Task 4 Step 8 ✅.
- "Installing N workflow templates" with names; zero-selected handled → Task 4 Step 9 ✅.
- Install failure surfaces error + returns to step 2; connection failure → step 1 → Task 4 Step 5 ✅.
- WorkflowIcon + `.template-*` CSS reusing tokens → Task 3 ✅.
- Tests: groupCatalog; api wrappers; step-2 render, preselect/count, toggle, skip label, install-with-ids → Tasks 1, 2, 4 ✅.

**Placeholder scan:** None. Test helpers `renderAndAdvanceToTemplates`/`clickByText` are described to reuse the file's existing harness (Task 4 Step 1 note) rather than left as TODO. ✅

**Type consistency:** `listTemplateCatalog`/`installTemplates` signatures match across Tasks 1 and 4; `BuiltInTemplateSummary` used in api, groupCatalog, OnboardingView, tests; `templateNames`/`selectedTemplateNames` consistent between OnboardingView and SetupPanel; `data-template-id` attribute matches the test selectors. ✅

**Open items to confirm during execution (not blocking):**
- The exact render/advance helper names in `OnboardingView.test.tsx` (reuse whatever exists; Task 4 Step 1 note).
- Whether `--err-soft`/`--err` tokens exist (they're used by the existing `.agent-load-error`, so yes).
