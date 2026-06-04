# Worker Permission Modes — Phase 1B (Desktop UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the user-facing half of worker permission modes to the Orca desktop chat: a per-goal **Auto-run / Ask-in-chat** toggle, and an **Allow / Deny** approval card rendered from `pendingApproval` chat messages — so Ask-in-chat is actually usable.

**Architecture:** Two new self-contained React components in `apps/desktop/src/orchestrator/` (a toggle and an approval card), each calling a thin new api-client function, wired into `OrcaChat.tsx`. The toggle reads the goal's current `workerPermissionMode` and PUTs changes; the card POSTs an allow/deny decision for a held permission hook. A one-line App SSE change keeps the toggle live across clients.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react, `@orca/contracts`. Daemon Phase 1A endpoints already exist: `PUT /v1/goals/:goalId/worker-permission-mode` and `POST /v1/goals/:goalId/permission-approvals/:approvalId`.

**Scope note:** Phase 1B of spec `docs/superpowers/specs/2026-06-03-orca-worker-permission-modes-design.md`. **Allow/Deny only** — the "Always allow" button is deferred to Phase 2 (it needs the native-config writer to be meaningful; a button that can't remember would mislead). Phase 1A (daemon) is already merged on this branch.

---

## Key codebase facts (verified — do not re-derive)

- **api client patterns** (`apps/desktop/src/api.ts`): mutations use a private `requestVoid(url, opts, errMsg)` (see `submitWorkerAnswers`, line 947) or `fetch` + `parseResponse` (see `updateGoal`, line 695). `loadConfig()` returns `{ baseUrl, token }`; `authHeaders(token)` adds the bearer header. Mirror `submitWorkerAnswers` exactly for POSTs.
- **Contracts** (already added in Phase 1A, rebuilt into dist): `Goal.workerPermissionMode: "ask" | "auto"`, `PendingApproval { approvalId, sessionId, toolName, summary, detail? }`, `OrchestratorChatMessage.pendingApproval?`. If a desktop type error claims these are missing, run `cd packages/contracts && pnpm build` once (do NOT stage `dist/` or `tsconfig.tsbuildinfo`).
- **Self-contained card pattern**: `WorkerQuestionForm` (inline in `OrcaChat.tsx`) calls `submitWorkerAnswers` itself and manages `submitted`/`expired` state. `MarkDoneConfirmCard.tsx` is the separate-file presentational pattern. The new components are separate files (like `MarkDoneConfirmCard`) but self-contained (call the api, like `WorkerQuestionForm`).
- **Message rendering** (`OrcaChat.tsx`): the `messages.map(...)` routes by role; non-user/non-internal/non-paraphrased messages render via `ChatMessageRow`, whose orca branch renders the body plus `{message.pendingQuestion && <WorkerQuestionForm goalId={goalId} pending={message.pendingQuestion} />}`. The approval card goes right after that.
- **App goal refresh** (`apps/desktop/src/App.tsx`): `GOAL_LIST_EVENTS = new Set<DomainEventType>(["goal.created","goal.updated","goal.archived"])` (line 42) triggers `loadGoals()` on SSE. `goal.worker_permission_mode_changed` (added to the contracts `DomainEventType` enum in Phase 1A) must be added here so a mode change refreshes the goals list.
- **Test harness**: component tests use `@testing-library/react` + `vitest`, mocking `../api` (see `OrcaChat.test.tsx` and `MarkDoneConfirmCard.test.tsx`). Run desktop tests: `cd apps/desktop && pnpm vitest run <path>`. Typecheck: `cd apps/desktop && pnpm tsc --noEmit`.
- The unicode ellipsis in existing UI strings is U+2026 (`…`).

---

## File structure

- **Create:** `apps/desktop/src/orchestrator/PermissionApprovalCard.tsx` — renders a `pendingApproval`; Allow/Deny buttons; calls `submitPermissionDecision`; submitted/error states.
- **Create:** `apps/desktop/src/orchestrator/WorkerPermissionToggle.tsx` — segmented Auto-run / Ask-in-chat control bound to a goal's mode; calls `setWorkerPermissionMode`; optimistic local state.
- **Create:** the two `.test.tsx` siblings.
- **Modify:** `apps/desktop/src/api.ts` — add `submitPermissionDecision`, `setWorkerPermissionMode`.
- **Modify:** `apps/desktop/src/orchestrator/OrcaChat.tsx` — render the card for `pendingApproval` messages; render the toggle when a goal is selected.
- **Modify:** `apps/desktop/src/orchestrator/OrcaChat.test.tsx` — cases for card + toggle presence.
- **Modify:** `apps/desktop/src/App.tsx` — add `goal.worker_permission_mode_changed` to `GOAL_LIST_EVENTS`.

---

## Task 1: api client functions

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Test: covered indirectly via the component tests (Tasks 2-3, which mock `../api`); this task is verified by `tsc` + exact mirroring of the tested-by-usage `submitWorkerAnswers`. (This matches the repo's convention — api mutation fns are not unit-tested directly; they're mocked in component tests.)

- [ ] **Step 1: Add `submitPermissionDecision`**

After `submitWorkerAnswers` in `apps/desktop/src/api.ts`, add (mirroring its `requestVoid` POST shape):

```ts
export async function submitPermissionDecision(
  goalId: string,
  approvalId: string,
  decision: "allow" | "deny",
  remember = false,
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/permission-approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ decision, remember }),
    },
    "Submit permission decision failed",
  );
}
```

- [ ] **Step 2: Add `setWorkerPermissionMode`**

```ts
export async function setWorkerPermissionMode(
  goalId: string,
  workerPermissionMode: "ask" | "auto",
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/worker-permission-mode`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ workerPermissionMode }),
    },
    "Set worker permission mode failed",
  );
}
```

(Confirm `requestVoid` accepts any 2xx; the daemon returns `{ ok: true, ... }` with 200 — `requestVoid` ignores the body, which is correct here.)

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/desktop && pnpm tsc --noEmit`
Expected: no errors. (If `requestVoid` is declared below these functions in the file, hoisting handles it — it's a function declaration. If lint requires ordering, place the new functions after `requestVoid`'s definition near `submitWorkerAnswers`.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/api.ts
git commit -m "feat(desktop): api client for permission decision + worker permission mode"
```
End commit messages in this plan with:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

---

## Task 2: `PermissionApprovalCard` component

**Files:**
- Create: `apps/desktop/src/orchestrator/PermissionApprovalCard.tsx`
- Test: `apps/desktop/src/orchestrator/PermissionApprovalCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/orchestrator/PermissionApprovalCard.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const submitPermissionDecisionMock = vi.fn();
vi.mock("../api", () => ({
  submitPermissionDecision: (...args: unknown[]) => submitPermissionDecisionMock(...args),
}));

const pending = { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "rm -rf build", detail: "rm -rf build --force" };

describe("PermissionApprovalCard", () => {
  beforeEach(() => {
    submitPermissionDecisionMock.mockReset();
    submitPermissionDecisionMock.mockResolvedValue(undefined);
  });

  it("renders the tool name and summary", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    expect(screen.getByText(/Bash/)).toBeInTheDocument();
    expect(screen.getByText(/rm -rf build/)).toBeInTheDocument();
  });

  it("calls submitPermissionDecision with allow when Allow is clicked", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => {
      expect(submitPermissionDecisionMock).toHaveBeenCalledWith("g1", "a1", "allow");
    });
  });

  it("calls submitPermissionDecision with deny when Deny is clicked", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByText("Deny"));
    await waitFor(() => {
      expect(submitPermissionDecisionMock).toHaveBeenCalledWith("g1", "a1", "deny");
    });
  });

  it("disables the buttons after a decision is submitted", async () => {
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => {
      expect((screen.getByText("Allow") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText("Deny") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("shows an error and re-enables the buttons if the decision fails", async () => {
    submitPermissionDecisionMock.mockRejectedValueOnce(new Error("nope"));
    const { PermissionApprovalCard } = await import("./PermissionApprovalCard");
    render(<PermissionApprovalCard goalId="g1" pending={pending} />);
    fireEvent.click(screen.getByText("Allow"));
    expect(await screen.findByText(/could not be submitted/i)).toBeInTheDocument();
    expect((screen.getByText("Allow") as HTMLButtonElement).disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/PermissionApprovalCard.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/desktop/src/orchestrator/PermissionApprovalCard.tsx`:

```tsx
import { useState } from "react";
import type { PendingApproval } from "@orca/contracts";
import { submitPermissionDecision } from "../api";

export function PermissionApprovalCard({ goalId, pending }: { goalId: string; pending: PendingApproval }) {
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "allow" | "deny") {
    setSubmitting(true);
    setError(null);
    try {
      await submitPermissionDecision(goalId, pending.approvalId, decision);
      setDecided(decision);
    } catch {
      setError("That decision could not be submitted — the request may have expired.");
    } finally {
      setSubmitting(false);
    }
  }

  const locked = submitting || decided !== null;

  return (
    <div className="orca-chat-approval">
      <p className="orca-chat-approval-tool">
        <span className="mono">{pending.toolName}</span>
        <span className="orca-chat-approval-summary">{pending.summary}</span>
      </p>
      {pending.detail && pending.detail !== pending.summary && (
        <details className="orca-chat-approval-details">
          <summary className="workflow-banner-subtitle">Details</summary>
          <pre className="orca-chat-approval-detail">{pending.detail}</pre>
        </details>
      )}
      <div className="orca-chat-approval-actions">
        <button
          type="button"
          className="submit-button"
          disabled={locked}
          onClick={() => void decide("allow")}
        >
          Allow
        </button>
        <button
          type="button"
          className="orca-chat-approval-deny"
          disabled={locked}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
      </div>
      {decided && (
        <p className="orca-chat-approval-status mono">{decided === "allow" ? "✓ Allowed" : "✕ Denied"}</p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
```

Note: the button labels are **static** ("Allow"/"Deny") so `getByText("Allow")` keeps resolving after a decision; decided state is conveyed by disabling both buttons plus a separate status line. This keeps the tests stable.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/PermissionApprovalCard.test.tsx`
Expected: PASS (5 tests). Button labels are static ("Allow"/"Deny"), so `getByText` stays stable across the decided state.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/PermissionApprovalCard.tsx apps/desktop/src/orchestrator/PermissionApprovalCard.test.tsx
git commit -m "feat(desktop): PermissionApprovalCard (Allow/Deny) for pending tool approvals"
```

---

## Task 3: `WorkerPermissionToggle` component

**Files:**
- Create: `apps/desktop/src/orchestrator/WorkerPermissionToggle.tsx`
- Test: `apps/desktop/src/orchestrator/WorkerPermissionToggle.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/orchestrator/WorkerPermissionToggle.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setWorkerPermissionModeMock = vi.fn();
vi.mock("../api", () => ({
  setWorkerPermissionMode: (...args: unknown[]) => setWorkerPermissionModeMock(...args),
}));

describe("WorkerPermissionToggle", () => {
  beforeEach(() => {
    setWorkerPermissionModeMock.mockReset();
    setWorkerPermissionModeMock.mockResolvedValue(undefined);
  });

  it("reflects the current mode (ask) as the active option", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    const ask = screen.getByRole("button", { name: /Ask-in-chat/ });
    expect(ask.getAttribute("aria-pressed")).toBe("true");
    const auto = screen.getByRole("button", { name: /Auto-run/ });
    expect(auto.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches to auto and calls setWorkerPermissionMode when Auto-run clicked", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-run/ }));
    await waitFor(() => {
      expect(setWorkerPermissionModeMock).toHaveBeenCalledWith("g1", "auto");
    });
    // optimistic: Auto-run becomes active immediately
    expect(screen.getByRole("button", { name: /Auto-run/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not call the api when clicking the already-active mode", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="auto" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-run/ }));
    expect(setWorkerPermissionModeMock).not.toHaveBeenCalled();
  });

  it("reverts the optimistic mode if the api call fails", async () => {
    setWorkerPermissionModeMock.mockRejectedValueOnce(new Error("nope"));
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-run/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Ask-in-chat/ }).getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("disables both options when disabled", async () => {
    const { WorkerPermissionToggle } = await import("./WorkerPermissionToggle");
    render(<WorkerPermissionToggle goalId="g1" mode="ask" disabled={true} />);
    expect((screen.getByRole("button", { name: /Auto-run/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Ask-in-chat/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/WorkerPermissionToggle.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/desktop/src/orchestrator/WorkerPermissionToggle.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { WorkerPermissionMode } from "@orca/contracts";
import { setWorkerPermissionMode } from "../api";

export function WorkerPermissionToggle({
  goalId,
  mode,
  disabled,
}: {
  goalId: string;
  mode: WorkerPermissionMode;
  disabled: boolean;
}) {
  // Optimistic local mode; re-sync if the prop (server truth) changes.
  const [current, setCurrent] = useState<WorkerPermissionMode>(mode);
  useEffect(() => { setCurrent(mode); }, [mode]);

  async function choose(next: WorkerPermissionMode) {
    if (next === current) return;
    const previous = current;
    setCurrent(next); // optimistic
    try {
      await setWorkerPermissionMode(goalId, next);
    } catch {
      setCurrent(previous); // revert on failure
    }
  }

  return (
    <div className="orca-perm-toggle" role="group" aria-label="Worker tool permissions">
      <span className="orca-perm-toggle-label mono">tools</span>
      <button
        type="button"
        className={`orca-perm-toggle-opt${current === "auto" ? " orca-perm-toggle-opt--active" : ""}`}
        aria-pressed={current === "auto"}
        disabled={disabled}
        onClick={() => void choose("auto")}
      >
        Auto-run
      </button>
      <button
        type="button"
        className={`orca-perm-toggle-opt${current === "ask" ? " orca-perm-toggle-opt--active" : ""}`}
        aria-pressed={current === "ask"}
        disabled={disabled}
        onClick={() => void choose("ask")}
      >
        Ask-in-chat
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/WorkerPermissionToggle.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/WorkerPermissionToggle.tsx apps/desktop/src/orchestrator/WorkerPermissionToggle.test.tsx
git commit -m "feat(desktop): WorkerPermissionToggle (Auto-run / Ask-in-chat) control"
```

---

## Task 4: Wire into `OrcaChat` + App live-refresh

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Write the failing tests (OrcaChat integration)**

Add to `apps/desktop/src/orchestrator/OrcaChat.test.tsx`. First, the existing mock of `../api` must also export the two new functions (add them to the `vi.mock("../api", ...)` object): `submitPermissionDecision: (...a: unknown[]) => submitPermissionDecisionMock(...a)` and `setWorkerPermissionMode: (...a: unknown[]) => setWorkerPermissionModeMock(...a)`, with `const submitPermissionDecisionMock = vi.fn();` / `const setWorkerPermissionModeMock = vi.fn();` declared alongside the other mocks and reset in `beforeEach` (default-resolve them). Then add:

```tsx
  it("renders the permission toggle reflecting the goal's mode when a goal is selected", async () => {
    setupRunLoad();
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[{ ...goal, workerPermissionMode: "ask" }]} selectedGoalId="goal-1" connectionStatus="open" />);
    expect(await screen.findByRole("button", { name: /Ask-in-chat/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ask-in-chat/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders an Allow/Deny approval card for a message with pendingApproval", async () => {
    setupRunLoad();
    listOrchestratorMessagesMock.mockResolvedValue({
      messages: [{
        id: "m-approve", goalId: "goal-1", role: "orchestrator", kind: "message",
        body: "The agent wants to run Bash.", correlationId: "c1", createdAt: now,
        pendingApproval: { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "rm -rf build" },
      }],
    });
    const { OrcaChat } = await import("./OrcaChat");
    render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
    expect(await screen.findByText("Allow")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
    expect(screen.getByText(/rm -rf build/)).toBeInTheDocument();
  });
```

(The `goal` test fixture in this file now needs `workerPermissionMode: "ask"` to satisfy the `Goal` type — add it to the `const goal: Goal = {...}` literal near the top. The contracts default means runtime parse is fine, but the TS literal must include it since `Goal` now has the field. Verify by tsc.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx -t "permission toggle"`
and `... -t "approval card"`
Expected: FAIL — toggle/card not rendered.

- [ ] **Step 3: Render the approval card in `ChatMessageRow`**

In `OrcaChat.tsx`, import the components near the other orchestrator imports:

```tsx
import { PermissionApprovalCard } from "./PermissionApprovalCard";
import { WorkerPermissionToggle } from "./WorkerPermissionToggle";
```

In `ChatMessageRow`, in the non-user (orca) branch, right after the `{message.pendingQuestion && <WorkerQuestionForm ... />}` line, add:

```tsx
        {message.pendingApproval && (
          <PermissionApprovalCard goalId={goalId} pending={message.pendingApproval} />
        )}
```

- [ ] **Step 4: Render the toggle when a goal is selected**

In `OrcaChat.tsx`, inside the `{selectedGoal && (` fragment near the top (e.g. right after the opening `<>` / before or after the header `SystemCard`), add the toggle bound to the goal's mode and gated on connection:

```tsx
            <WorkerPermissionToggle
              goalId={selectedGoal.id}
              mode={selectedGoal.workerPermissionMode}
              disabled={!connected}
            />
```

(`connected` is the existing `connectionStatus === "open"` derived boolean in this component. `selectedGoal.workerPermissionMode` is now on the `Goal` type.)

- [ ] **Step 5: Add the SSE live-refresh event in `App.tsx`**

In `apps/desktop/src/App.tsx`, add `"goal.worker_permission_mode_changed"` to the `GOAL_LIST_EVENTS` set (line 42):

```ts
const GOAL_LIST_EVENTS = new Set<DomainEventType>(["goal.created", "goal.updated", "goal.archived", "goal.worker_permission_mode_changed"]);
```

- [ ] **Step 6: Run the OrcaChat tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/orchestrator/OrcaChat.test.tsx`
Expected: PASS (new cases + existing). Update any existing test whose `goal`/`goals` literal now fails tsc by adding `workerPermissionMode: "ask"`.

- [ ] **Step 7: Typecheck + full desktop suite**

Run: `cd apps/desktop && pnpm tsc --noEmit`
Expected: clean.

Run: `cd apps/desktop && pnpm vitest run`
Expected: PASS. Fix any other test with a `Goal` literal missing the new field.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx apps/desktop/src/App.tsx
git commit -m "feat(desktop): wire permission toggle + approval card into Orca chat"
```

---

## Task 5: Styles (presentation polish)

**Files:**
- Modify: `apps/desktop/src/orchestrator/orca-chat.css`

The components reference a few new classes (`orca-chat-approval*`, `orca-perm-toggle*`). Functionality and tests don't depend on CSS, but the UI should be presentable.

- [ ] **Step 1: Add styles**

Append to `apps/desktop/src/orchestrator/orca-chat.css` (match the file's existing variable/spacing conventions — read a few existing rules like `.orca-chat-question` and `.submit-button` first, then mirror their look):

```css
.orca-perm-toggle { display: flex; align-items: center; gap: 6px; margin: 6px 0 10px; }
.orca-perm-toggle-label { opacity: 0.6; font-size: 11px; }
.orca-perm-toggle-opt { font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: transparent; color: inherit; cursor: pointer; }
.orca-perm-toggle-opt--active { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.3); }
.orca-perm-toggle-opt:disabled { opacity: 0.4; cursor: default; }

.orca-chat-approval { margin-top: 8px; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; }
.orca-chat-approval-tool { display: flex; gap: 8px; align-items: baseline; margin: 0 0 6px; }
.orca-chat-approval-summary { font-size: 13px; }
.orca-chat-approval-detail { white-space: pre-wrap; font-size: 12px; opacity: 0.85; margin: 4px 0 0; }
.orca-chat-approval-actions { display: flex; gap: 8px; }
.orca-chat-approval-deny { font-size: 12px; padding: 3px 12px; border-radius: 6px; border: 1px solid rgba(255,120,120,0.4); background: transparent; color: inherit; cursor: pointer; }
.orca-chat-approval-deny:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 2: Verify the app still builds**

Run: `cd apps/desktop && pnpm tsc --noEmit` and `cd apps/desktop && pnpm vitest run src/orchestrator/`
Expected: clean / PASS (CSS doesn't affect tests; this just confirms nothing else regressed).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/orchestrator/orca-chat.css
git commit -m "style(desktop): styles for permission toggle and approval card"
```

---

## Final Verification

- [ ] **Full desktop gates**

Run: `cd apps/desktop && pnpm vitest run && pnpm tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Manual smoke (recommended):** With a goal in `ask` mode and a workflow running, trigger a worker tool that isn't pre-approved → an Allow/Deny card appears in the chat; click Allow → the agent proceeds. Flip the toggle to Auto-run → subsequent tool calls run without a card. Flip back to Ask-in-chat → cards return. Confirm the toggle reflects the change after an SSE refresh.

---

## Spec coverage check (Phase 1B scope)

- Per-goal **live toggle in chat** (Auto-run / Ask-in-chat) → Tasks 3, 4 (+ App SSE refresh).
- **Allow/Deny approval card** from `pendingApproval` → Tasks 2, 4.
- api wiring to the Phase 1A endpoints → Task 1.
- Presentation → Task 5.

**Out of Phase 1B:** the "Always allow" button (Phase 2, with the native-config writer); Codex/Antigravity (Phases 3-4). The api `submitPermissionDecision` already accepts a `remember` param (defaults false) so Phase 2 only adds the button.
