# Orchestrator Chat Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the orchestrator tab into a goal-scoped persistent chat with an always-visible composer for selected goals, while keeping workflow recommendations and workflow input as separate state.

**Architecture:** Add a dedicated orchestrator-message persistence path in the daemon, backed by a new SQLite table and goal-scoped list/create routes. A create request persists the user message, generates a non-mutating Orca reply through the selected goal's configured provider/model, persists that reply, emits message-created events, and leaves workflow state untouched. The desktop `OrcaChat` view loads the message timeline in parallel with workflow state and always renders the freeform composer whenever a goal is selected.

**Tech Stack:** TypeScript, Zod contracts, Fastify v5, better-sqlite3, React 18, Vitest, existing daemon event bus and model-provider registry. Spec at `docs/superpowers/specs/2026-05-26-orchestrator-chat-persistence-design.md`.

---

## File map

- `packages/contracts/src/index.ts`
  - Add goal-scoped orchestrator chat message schemas, list/create request/response schemas, and a new domain event type for message creation.
- `packages/contracts/src/index.test.ts`
  - Add contract coverage for chat message parsing and message-created event parsing.
- `apps/daemon/migrations/0013_orchestrator_messages.sql`
  - Add durable storage for goal-scoped orchestrator messages.
- `apps/daemon/src/migrations.ts`
  - Register the new migration.
- `apps/daemon/src/migrations.test.ts`
  - Verify the new table and indexes exist after migration.
- `apps/daemon/src/orchestrator-chat/projection.ts`
  - List messages by goal in ascending creation order.
- `apps/daemon/src/orchestrator-chat/usecases.ts`
  - Persist user messages, generate non-mutating replies, persist reply rows, and emit events.
- `apps/daemon/src/orchestrator-chat/routes.ts`
  - Register `GET /v1/goals/:goalId/orchestrator-messages` and `POST /v1/goals/:goalId/orchestrator-messages`.
- `apps/daemon/src/orchestrator-chat/usecases.test.ts`
  - Cover storage, goal scoping, missing-model errors, and reply generation behavior.
- `apps/daemon/src/orchestrator-chat/routes.test.ts`
  - Cover route validation, HTTP status codes, and response shapes.
- `apps/daemon/src/server.ts`
  - Wire the new routes into the main daemon server.
- `apps/desktop/src/api.ts`
  - Add list/create API wrappers for orchestrator messages.
- `apps/desktop/src/api.test.ts`
  - Add wrapper tests for the new endpoints.
- `apps/desktop/src/orchestrator/OrcaChat.tsx`
  - Load the message timeline, keep workflow state separate, render the no-goal empty state, and always show the composer when a goal is selected.
- `apps/desktop/src/orchestrator/OrcaChat.test.tsx`
  - Add regression coverage for the new chat behavior and keep the earlier workflow-input regression test.
- `apps/desktop/src/orchestrator/orca-chat.css`
  - Add layout styles for a bottom-anchored freeform composer and timeline message rows.

## Scope decisions locked for implementation

- Persist only chat messages in V1. Do not persist workflow banner/recommendation cards as chat rows.
- Use a new event type: `orchestrator.message.created`.
- `POST /v1/goals/:goalId/orchestrator-messages` returns both the persisted user message and the persisted Orca reply.
- If a selected goal has no orchestrator provider/model, the composer still renders, but send returns `409 goal_orchestrator_model_missing`.
- The reply path uses the existing `ModelProviderRegistry` with a simple structured schema such as `{ replyText: string }`.
- Freeform chat is read-only with respect to workflow state: no recommendation acceptance, no step-run mutation, no artifact creation, no decision writes.

---

### Task 1: Contracts and event schema

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Add tests for the new schemas in `packages/contracts/src/index.test.ts`:

```ts
import {
  CreateOrchestratorMessageRequest,
  CreateOrchestratorMessageResponse,
  ListOrchestratorMessagesResponse,
  OrchestratorChatMessage,
  DomainEvent,
} from "./index.js";

it("parses a goal-scoped orchestrator chat message", () => {
  expect(
    OrchestratorChatMessage.parse({
      id: "msg-1",
      goalId: "goal-1",
      role: "user",
      kind: "message",
      body: "Please keep the plan narrow.",
      correlationId: null,
      createdAt: "2026-05-26T12:00:00.000Z",
    }),
  ).toMatchObject({ id: "msg-1", role: "user" });
});

it("parses create/list orchestrator message payloads", () => {
  expect(CreateOrchestratorMessageRequest.parse({ body: "Need a rollout plan." })).toEqual({
    body: "Need a rollout plan.",
  });
  expect(
    ListOrchestratorMessagesResponse.parse({
      messages: [],
    }),
  ).toEqual({ messages: [] });
});

it("parses create response with user and orchestrator rows", () => {
  expect(
    CreateOrchestratorMessageResponse.parse({
      message: {
        id: "msg-user",
        goalId: "goal-1",
        role: "user",
        kind: "message",
        body: "Need a rollout plan.",
        correlationId: "corr-1",
        createdAt: "2026-05-26T12:00:00.000Z",
      },
      reply: {
        id: "msg-orca",
        goalId: "goal-1",
        role: "orchestrator",
        kind: "message",
        body: "Start with a bounded verification pass.",
        correlationId: "corr-1",
        createdAt: "2026-05-26T12:00:01.000Z",
      },
    }),
  ).toBeDefined();
});

it("parses orchestrator.message.created events", () => {
  expect(
    DomainEvent.parse({
      seq: 10,
      id: "evt-1",
      type: "orchestrator.message.created",
      goalId: "goal-1",
      payload: { messageId: "msg-1", role: "user" },
      createdAt: "2026-05-26T12:00:00.000Z",
    }),
  ).toMatchObject({ type: "orchestrator.message.created" });
});
```

- [ ] **Step 2: Run the contracts tests and confirm they fail**

Run: `pnpm --filter @orca/contracts test -- --run`
Expected: failures for missing `OrchestratorChatMessage`, request/response schemas, and the new domain event literal.

- [ ] **Step 3: Add the contracts**

Extend `packages/contracts/src/index.ts` with:

```ts
export const OrchestratorChatRole = z.enum(["user", "orchestrator", "system"]);
export type OrchestratorChatRole = z.infer<typeof OrchestratorChatRole>;

export const OrchestratorChatMessageKind = z.enum(["message"]);
export type OrchestratorChatMessageKind = z.infer<typeof OrchestratorChatMessageKind>;

export const OrchestratorChatMessage = z.object({
  id: z.string(),
  goalId: z.string(),
  role: OrchestratorChatRole,
  kind: OrchestratorChatMessageKind,
  body: z.string().trim().min(1).max(4000),
  correlationId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type OrchestratorChatMessage = z.infer<typeof OrchestratorChatMessage>;

export const ListOrchestratorMessagesResponse = z.object({
  messages: z.array(OrchestratorChatMessage),
});
export type ListOrchestratorMessagesResponse = z.infer<typeof ListOrchestratorMessagesResponse>;

export const CreateOrchestratorMessageRequest = z.object({
  body: z.string().trim().min(1).max(4000),
});
export type CreateOrchestratorMessageRequest = z.infer<typeof CreateOrchestratorMessageRequest>;

export const CreateOrchestratorMessageResponse = z.object({
  message: OrchestratorChatMessage,
  reply: OrchestratorChatMessage,
});
export type CreateOrchestratorMessageResponse = z.infer<typeof CreateOrchestratorMessageResponse>;
```

Also add `"orchestrator.message.created"` to `DomainEventType`.

- [ ] **Step 4: Run the contracts tests and typecheck**

Run:

```bash
pnpm --filter @orca/contracts typecheck
pnpm --filter @orca/contracts test -- --run
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): add orchestrator chat schemas"
```

---

### Task 2: SQLite migration and daemon projection helpers

**Files:**
- Create: `apps/daemon/migrations/0013_orchestrator_messages.sql`
- Modify: `apps/daemon/src/migrations.ts`
- Modify: `apps/daemon/src/migrations.test.ts`
- Create: `apps/daemon/src/orchestrator-chat/projection.ts`
- Test: `apps/daemon/src/orchestrator-chat/usecases.test.ts`

- [ ] **Step 1: Write the failing migration/projection tests**

Create `apps/daemon/src/orchestrator-chat/usecases.test.ts` with a minimal listing assertion that currently fails because the table and query helpers do not exist:

```ts
it("lists orchestrator messages for a goal in ascending created_at order", () => {
  db.exec(`
    INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at)
    VALUES
      ('msg-1', 'goal-1', 'user', 'message', 'first', NULL, '2026-05-26T12:00:00.000Z'),
      ('msg-2', 'goal-1', 'orchestrator', 'message', 'second', 'corr-1', '2026-05-26T12:00:01.000Z')
  `);

  expect(listOrchestratorMessagesByGoal(db, "goal-1").map((m) => m.id)).toEqual([
    "msg-1",
    "msg-2",
  ]);
});
```

Add a migration assertion in `apps/daemon/src/migrations.test.ts`:

```ts
it("creates orchestrator_messages with a goal_id index", () => {
  const cols = db.prepare("PRAGMA table_info(orchestrator_messages)").all();
  expect(cols.map((c: { name: string }) => c.name)).toEqual([
    "id",
    "goal_id",
    "role",
    "kind",
    "body",
    "correlation_id",
    "created_at",
  ]);
});
```

- [ ] **Step 2: Run the failing daemon tests**

Run:

```bash
pnpm --filter @orca/daemon test -- migrations.test.ts orchestrator-chat/usecases.test.ts
```

Expected: failures for missing migration file/table and missing `listOrchestratorMessagesByGoal`.

- [ ] **Step 3: Add the migration and projection helper**

Create `apps/daemon/migrations/0013_orchestrator_messages.sql`:

```sql
CREATE TABLE orchestrator_messages (
  id             TEXT PRIMARY KEY,
  goal_id        TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('user', 'orchestrator', 'system')),
  kind           TEXT NOT NULL CHECK (kind IN ('message')),
  body           TEXT NOT NULL,
  correlation_id TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_orchestrator_messages_goal_created
  ON orchestrator_messages(goal_id, created_at, id);
```

Register the migration in `apps/daemon/src/migrations.ts`, then create `apps/daemon/src/orchestrator-chat/projection.ts` with:

```ts
import type Database from "better-sqlite3";
import { OrchestratorChatMessage, type OrchestratorChatMessage as OrchestratorChatMessageT } from "@orca/contracts";

export function listOrchestratorMessagesByGoal(
  db: Database.Database,
  goalId: string,
): OrchestratorChatMessageT[] {
  const rows = db
    .prepare(
      `SELECT id, goal_id, role, kind, body, correlation_id, created_at
         FROM orchestrator_messages
        WHERE goal_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(goalId) as Array<Record<string, unknown>>;

  return rows.map((row) =>
    OrchestratorChatMessage.parse({
      id: row.id,
      goalId: row.goal_id,
      role: row.role,
      kind: row.kind,
      body: row.body,
      correlationId: row.correlation_id ?? null,
      createdAt: row.created_at,
    }),
  );
}
```

- [ ] **Step 4: Re-run the targeted daemon tests**

Run:

```bash
pnpm --filter @orca/daemon test -- migrations.test.ts orchestrator-chat/usecases.test.ts
```

Expected: the migration test passes and the projection helper test moves green or fails later on missing usecases only.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/migrations/0013_orchestrator_messages.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts apps/daemon/src/orchestrator-chat/projection.ts apps/daemon/src/orchestrator-chat/usecases.test.ts
git commit -m "feat(daemon): add orchestrator message storage"
```

---

### Task 3: Daemon usecases for message persistence and non-mutating reply generation

**Files:**
- Create: `apps/daemon/src/orchestrator-chat/usecases.ts`
- Modify: `apps/daemon/src/orchestrator-chat/usecases.test.ts`
- Reference: `apps/daemon/src/llm/types.ts`
- Reference: `apps/daemon/src/llm/registry.ts`
- Reference: `apps/daemon/src/goals.ts`
- Reference: `apps/daemon/src/workflows/runs/projection.ts`

- [ ] **Step 1: Write the failing usecase tests**

Extend `apps/daemon/src/orchestrator-chat/usecases.test.ts` with three focused cases:

```ts
it("persists a user message and orchestrator reply for a goal", async () => {
  const result = await createOrchestratorMessage(
    { db, bus, modelProviderRegistry, now: () => NOW, idFactory },
    "goal-1",
    { body: "Need a rollout plan." },
  );

  expect(result.message.role).toBe("user");
  expect(result.reply.role).toBe("orchestrator");
  expect(listOrchestratorMessagesByGoal(db, "goal-1")).toHaveLength(2);
});

it("returns goal_orchestrator_model_missing when the goal lacks provider/model", async () => {
  await expect(
    createOrchestratorMessage(
      { db, bus, modelProviderRegistry, now: () => NOW, idFactory },
      "goal-without-model",
      { body: "Need a rollout plan." },
    ),
  ).rejects.toMatchObject({ code: "goal_orchestrator_model_missing" });
});

it("does not mutate workflow recommendations or step-run state", async () => {
  const beforeCount = db.prepare("SELECT COUNT(*) AS count FROM recommendations").get() as { count: number };
  await createOrchestratorMessage(
    { db, bus, modelProviderRegistry, now: () => NOW, idFactory },
    "goal-1",
    { body: "Need a rollout plan." },
  );
  const afterCount = db.prepare("SELECT COUNT(*) AS count FROM recommendations").get() as { count: number };
  expect(afterCount.count).toBe(beforeCount.count);
});
```

- [ ] **Step 2: Run the usecase tests and confirm they fail**

Run: `pnpm --filter @orca/daemon test -- orchestrator-chat/usecases.test.ts`
Expected: failures for missing `createOrchestratorMessage` and missing error types.

- [ ] **Step 3: Implement the usecase**

Create `apps/daemon/src/orchestrator-chat/usecases.ts` with:

- a `GoalOrchestratorModelMissingError`
- an internal `buildGuidancePrompt(...)` helper that uses:
  - goal title and description
  - active workflow run id if present
  - current step id if present
- a small response schema:

```ts
const GuidanceReply = z.object({
  replyText: z.string().trim().min(1).max(4000),
});
```

- a `createOrchestratorMessage(...)` usecase that:
  1. loads the goal
  2. validates provider/model presence
  3. persists the user row
  4. calls `provider.complete()` with a non-mutating system prompt
  5. persists the orchestrator reply row with the same `correlationId`
  6. inserts and emits `orchestrator.message.created` events after commit
  7. returns `{ message, reply }`

Keep the transaction boundary around persistence and event-row insertion only. Do not open a long transaction around the model call.

- [ ] **Step 4: Re-run the usecase tests**

Run: `pnpm --filter @orca/daemon test -- orchestrator-chat/usecases.test.ts`
Expected: all orchestrator-chat usecase tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-chat/usecases.ts apps/daemon/src/orchestrator-chat/usecases.test.ts
git commit -m "feat(daemon): persist orchestrator chat replies"
```

---

### Task 4: Goal-scoped routes and server wiring

**Files:**
- Create: `apps/daemon/src/orchestrator-chat/routes.ts`
- Create: `apps/daemon/src/orchestrator-chat/routes.test.ts`
- Modify: `apps/daemon/src/server.ts`

- [ ] **Step 1: Write the failing route tests**

Create `apps/daemon/src/orchestrator-chat/routes.test.ts` with route-level coverage:

```ts
it("GET /v1/goals/:goalId/orchestrator-messages returns goal-scoped rows", async () => {
  const response = await server.inject({
    method: "GET",
    url: "/v1/goals/goal-1/orchestrator-messages",
    headers: AUTH_HEADERS,
  });

  expect(response.statusCode).toBe(200);
  expect(ListOrchestratorMessagesResponse.parse(JSON.parse(response.body)).messages).toHaveLength(2);
});

it("POST /v1/goals/:goalId/orchestrator-messages returns message and reply", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/v1/goals/goal-1/orchestrator-messages",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    payload: { body: "Need a rollout plan." },
  });

  expect(response.statusCode).toBe(201);
  expect(CreateOrchestratorMessageResponse.parse(JSON.parse(response.body))).toBeDefined();
});

it("POST /v1/goals/:goalId/orchestrator-messages returns 409 when no model is configured", async () => {
  const response = await server.inject({
    method: "POST",
    url: "/v1/goals/goal-without-model/orchestrator-messages",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    payload: { body: "Need a rollout plan." },
  });

  expect(response.statusCode).toBe(409);
});
```

- [ ] **Step 2: Run the route tests and confirm they fail**

Run: `pnpm --filter @orca/daemon test -- orchestrator-chat/routes.test.ts`
Expected: failures for missing route registration and handler logic.

- [ ] **Step 3: Implement the routes**

Create `apps/daemon/src/orchestrator-chat/routes.ts` in the same style as other daemon route modules:

```ts
export function registerOrchestratorChatRoutes(
  server: FastifyInstance,
  deps: OrchestratorChatRouteDeps,
): void {
  server.get("/v1/goals/:goalId/orchestrator-messages", async (request, reply) => {
    // 404 if goal missing, otherwise list rows with ListOrchestratorMessagesResponse
  });

  server.post("/v1/goals/:goalId/orchestrator-messages", async (request, reply) => {
    // parse CreateOrchestratorMessageRequest
    // 404 goal missing
    // 409 model missing
    // 201 with CreateOrchestratorMessageResponse
  });
}
```

Wire it in `apps/daemon/src/server.ts` next to the other goal-scoped route registration calls.

- [ ] **Step 4: Run route, server, and HTTP-surface tests**

Run:

```bash
pnpm --filter @orca/daemon test -- orchestrator-chat/routes.test.ts server.test.ts workflows/__tests__/http-surface.test.ts
```

Expected: the new routes pass, existing HTTP surfaces stay green.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-chat/routes.ts apps/daemon/src/orchestrator-chat/routes.test.ts apps/daemon/src/server.ts
git commit -m "feat(daemon): add orchestrator chat routes"
```

---

### Task 5: Desktop API wrappers and orchestrator chat UI

**Files:**
- Modify: `apps/desktop/src/api.ts`
- Modify: `apps/desktop/src/api.test.ts`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx`
- Modify: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`
- Modify: `apps/desktop/src/orchestrator/orca-chat.css`

- [ ] **Step 1: Write the failing desktop tests**

Add API wrapper tests in `apps/desktop/src/api.test.ts`:

```ts
it("listOrchestratorMessages fetches goal-scoped chat rows", async () => {
  const response = await api.listOrchestratorMessages("goal-1");
  expect(response.messages[0]?.id).toBe("msg-1");
});

it("createOrchestratorMessage posts a goal-scoped chat message", async () => {
  const response = await api.createOrchestratorMessage("goal-1", { body: "Need a rollout plan." });
  expect(response.reply.role).toBe("orchestrator");
});
```

Extend `apps/desktop/src/orchestrator/OrcaChat.test.tsx` with:

```ts
it("shows a start/select-goal prompt and no composer when no goal is selected", async () => {
  render(<OrcaChat goals={[goal]} selectedGoalId={null} connectionStatus="open" />);
  expect(await screen.findByText(/start a goal|select a goal/i)).toBeInTheDocument();
  expect(screen.queryByPlaceholderText(/message orca/i)).toBeNull();
});

it("shows the composer even when there are no pending workflow recommendations", async () => {
  setupRunLoad(workflowRecommendation({ status: "dismissed" }));
  listRecommendationsMock.mockResolvedValue({ recommendations: [], generations: [] });
  render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
  expect(await screen.findByPlaceholderText("Message Orca…")).toBeInTheDocument();
});

it("renders both the workflow answer box and the freeform composer", async () => {
  setupRunLoad(workflowRecommendation({ status: "accepted" }));
  render(<OrcaChat goals={[goal]} selectedGoalId="goal-1" connectionStatus="open" />);
  expect(await screen.findByPlaceholderText("Answer the intake question…")).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Message Orca…")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the failing desktop tests**

Run:

```bash
pnpm --filter @orca/desktop test -- api.test.ts OrcaChat.test.tsx
```

Expected: failures for missing API wrappers and missing chat composer behavior.

- [ ] **Step 3: Add the API wrappers**

In `apps/desktop/src/api.ts`, add:

```ts
export async function listOrchestratorMessages(goalId: string): Promise<ListOrchestratorMessagesResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/orchestrator-messages`,
    { method: "GET", headers: authHeaders(token) },
    ListOrchestratorMessagesResponse,
    "List orchestrator messages failed",
  );
}

export async function createOrchestratorMessage(
  goalId: string,
  input: CreateOrchestratorMessageRequest,
): Promise<CreateOrchestratorMessageResponse> {
  const body = CreateOrchestratorMessageRequest.parse(input);
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/orchestrator-messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(body),
    },
    CreateOrchestratorMessageResponse,
    "Create orchestrator message failed",
  );
}
```

- [ ] **Step 4: Implement the `OrcaChat` UI changes**

Refactor `apps/desktop/src/orchestrator/OrcaChat.tsx` so it loads and renders:

- `messages`
- `messageDraft`
- `sendingMessage`
- `messageError`
- existing workflow state in a separate slice

Concrete requirements:

- when `selectedGoalId === null`, return only the start/select-goal prompt
- when a goal is selected, call `listOrchestratorMessages(goalId)` during load
- refresh on `orchestrator.message.created`
- append the create response after send or trigger a refresh
- render a bottom composer with placeholder `Message Orca…`
- keep the existing workflow `request_user_input` UI visible when present
- remove the behavior where `No pending workflow recommendations` implies there is no chat input

Use a bottom layout similar to:

```tsx
<div className="orca-chat">
  <div className="orca-chat-scroll scroll">{/* timeline + workflow cards */}</div>
  {selectedGoal && (
    <form className="orca-chat-composer" onSubmit={handleSendMessage}>
      <textarea
        value={messageDraft}
        onChange={(event) => setMessageDraft(event.target.value)}
        placeholder="Message Orca…"
      />
      <button type="submit" disabled={sendingMessage || messageDraft.trim().length === 0}>
        {sendingMessage ? "Sending…" : "Send"}
      </button>
    </form>
  )}
</div>
```

- [ ] **Step 5: Run the desktop suite**

Run:

```bash
pnpm --filter @orca/desktop test -- api.test.ts OrcaChat.test.tsx
pnpm --filter @orca/desktop typecheck
pnpm --filter @orca/desktop build
```

Expected: all three commands exit 0. Existing Vite chunk warnings are acceptable if the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/api.test.ts apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx apps/desktop/src/orchestrator/orca-chat.css
git commit -m "feat(desktop): add persistent orchestrator chat"
```

---

### Task 6: End-to-end verification and cleanup

**Files:**
- Modify as needed: touched files from Tasks 1-5 only

- [ ] **Step 1: Run the full targeted verification set**

Run:

```bash
pnpm --filter @orca/contracts typecheck
pnpm --filter @orca/contracts test -- --run
pnpm --filter @orca/daemon test -- orchestrator-chat/usecases.test.ts orchestrator-chat/routes.test.ts server.test.ts
pnpm --filter @orca/desktop test -- api.test.ts OrcaChat.test.tsx
pnpm --filter @orca/desktop typecheck
pnpm --filter @orca/desktop build
```

Expected: all commands exit 0.

- [ ] **Step 2: Manually review the final diff for scope**

Check:

```bash
git diff -- packages/contracts/src/index.ts apps/daemon/src/orchestrator-chat apps/daemon/src/server.ts apps/desktop/src/api.ts apps/desktop/src/orchestrator/OrcaChat.tsx
```

Confirm:

- no workflow mutation paths were added to freeform chat
- no recommendation status updates happen on message send
- no goal-less chat route was added
- no unrelated files were modified

- [ ] **Step 3: Final commit or squash per branch policy**

If keeping task commits:

```bash
git status --short
```

Expected: no unintended dirty files beyond known user-owned worktree changes.

- [ ] **Step 4: Record any follow-up explicitly instead of expanding scope**

If anything remains out of scope, write it down in the handoff:

```md
- chat timeline currently persists only message rows; workflow cards are rendered live from workflow state
- no streaming partial reply UI in V1
- no edit/delete message actions in V1
```

---

## Self-review checklist

- Spec coverage:
  - always-visible composer for selected goals: Task 5
  - no-goal empty state: Task 5
  - goal-scoped persistence: Tasks 2-4
  - non-mutating reply generation: Task 3
  - event-driven refresh: Tasks 1, 4, 5
  - workflow input + composer coexistence: Task 5
- Placeholder scan:
  - no `TODO`/`TBD` markers remain
  - every route, test target, and command has an exact file path or command
- Type consistency:
  - event name fixed as `orchestrator.message.created`
  - request/response names fixed as `CreateOrchestratorMessageRequest`, `CreateOrchestratorMessageResponse`, and `ListOrchestratorMessagesResponse`
  - data entity fixed as `OrchestratorChatMessage`
