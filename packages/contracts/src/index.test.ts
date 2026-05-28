import { describe, expect, it } from "vitest";

import {
  AdapterId,
  Agent,
  AgentReadinessReport,
  AgentReadinessStatus,
  AdapterSummary,
  AuthStatus,
  AttachWorkspaceRequest,
  AttachWorkspaceResponse,
  CheckReadinessAllResponse,
  CheckReadinessOneResponse,
  CheckStep,
  CreateOrchestratorMessageRequest,
  CreateOrchestratorMessageResponse,
  CreateGoalDecisionRequest,
  CreateGoalMemoryRequest,
  CreateContextPackageRequest,
  CreateContextPackageResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  ContextAssembly,
  ContextAssemblyCompletedEventPayload,
  ContextAssemblyFailedEventPayload,
  ContextAssemblyFailureCode,
  ContextAssemblyInput,
  ContextAssemblyOutput,
  ContextAssemblyRequestedEventPayload,
  ContextAssemblyStatus,
  ContextPackage,
  ContextPackageCreatedEventPayload,
  ContextRole,
  ContextSourceRef,
  DecisionArchivedEventPayload,
  DecisionCandidate,
  DecisionConfirmedEventPayload,
  DecisionCreatedEventPayload,
  DecisionUpdatedEventPayload,
  DomainEvent,
  DomainEventType,
  ExtractSessionMemoryResponse,
  GetSessionResponse,
  CreateGoalRequest,
  GitProbe,
  GoalDecision,
  Goal,
  GoalDetailResponse,
  GoalMemoryItem,
  GoalRefinement,
  GuidedRefinementInput,
  GuidedRefinementOutput,
  GetContextPackageResponse,
  InspectWorkspacePreview,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  ListAdaptersResponse,
  ListContextPackagesQuery,
  ListContextPackagesResponse,
  ListGoalDecisionsResponse,
  ListGoalMemoryResponse,
  ListOrchestratorMessagesResponse,
  ListSessionsResponse,
  GoalWorkspaceErrorCode,
  MemoryDomainEventType,
  MemoryEvent,
  MemoryCandidate,
  MemoryExtraction,
  MemoryExtractionCompletedEventPayload,
  MemoryExtractionFailedEventPayload,
  MemoryExtractionRequestedEventPayload,
  MemoryExtractionStartedEventPayload,
  MemoryItemArchivedEventPayload,
  MemoryItemCreatedEventPayload,
  MemoryItemPromotedEventPayload,
  MemoryItemUpdatedEventPayload,
  PatchGoalDecisionRequest,
  PatchGoalMemoryRequest,
  OrchestratorChatMessage,
  RepairAction,
  RefineGoalRequest,
  RefineGoalResponse,
  SessionDetail,
  SessionErrorCode,
  SessionErrorFrame,
  SessionExtractionInput,
  SessionExtractionOutput,
  SessionCreatedEventPayload,
  SessionMemorySummary,
  SessionInputFrame,
  SessionOutputFrame,
  SessionOutputSnapshot,
  SessionResizeFrame,
  SessionStatus,
  SessionSubscribeFrame,
  SessionSummary,
  SessionUnsubscribeFrame,
  StartSessionRequest,
  StartSessionResponse,
  StopSessionRequest,
  StopSessionResponse,
  SkillExtensionPoint,
  Workspace,
  WorkspaceType,
  CreateGoalAndStartWorkflowRequest,
  CreateGoalAndStartWorkflowResponse,
} from "./index.js";

const now = "2026-01-01T00:00:00.000Z";

const goalFixture = Goal.parse({
  id: "goal-1",
  title: "Launch workspace planning",
  description: "Ship refinement and workspace support",
  status: "active",
  autonomyLevel: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null
});

const workspaceFixture = Workspace.parse({
  id: "ws-1",
  goalId: "goal-1",
  path: "/home/user/repo",
  name: "repo",
  workspaceType: "repo",
  branch: "main",
  isDirty: false,
  gitProbe: "ok",
  attachedAt: now
});

const guidedOutputFixture = GuidedRefinementOutput.parse({
  skillId: "guided-goal-refinement",
  title: "Launch workspace planning",
  description: "Implement deterministic refinement",
  successCriteria: ["Goal detail shows refinement"],
  constraints: ["No AI calls"],
  assumptions: ["Local filesystem available"]
});

function expectRoundTrip<T>(
  parse: (input: unknown) => T,
  input: unknown,
  expected: T
): void {
  const parsed = parse(input);
  expect(parsed).toEqual(expected);
  expect(JSON.parse(JSON.stringify(parsed)) as T).toEqual(expected);
}

describe("goal refinement and workspace contracts", () => {
  it("extends domain event type and skill extension point literals", () => {
    expect(DomainEventType.parse("goal.refined")).toBe("goal.refined");
    expect(DomainEventType.parse("workspace.attached")).toBe("workspace.attached");
    expect(DomainEventType.parse("workspace.removed")).toBe("workspace.removed");
    expect(SkillExtensionPoint.parse("goal.refine")).toBe("goal.refine");

    expect(() => DomainEventType.parse("workspace.patched")).toThrow();
    expect(() => SkillExtensionPoint.parse("goal.rethink")).toThrow();
  });

  it("parses WorkspaceType and GitProbe literals", () => {
    expect(WorkspaceType.parse("repo")).toBe("repo");
    expect(WorkspaceType.parse("folder")).toBe("folder");
    expect(GitProbe.parse("ok")).toBe("ok");
    expect(GitProbe.parse("not_a_repo")).toBe("not_a_repo");

    expect(() => WorkspaceType.parse("archive")).toThrow();
    expect(() => GitProbe.parse("timeout")).toThrow();
  });

  it("parses Workspace and rejects invalid workspace shape", () => {
    expectRoundTrip(Workspace.parse, workspaceFixture, workspaceFixture);
    expect(() => Workspace.parse({ ...workspaceFixture, workspaceType: "archive" })).toThrow();
  });

  it("parses GoalRefinement and rejects non-array fields", () => {
    const refinement = {
      goalId: "goal-1",
      skillId: "guided-goal-refinement",
      successCriteria: ["a"],
      constraints: ["b"],
      assumptions: ["c"],
      refinedAt: now
    };

    expectRoundTrip(GoalRefinement.parse, refinement, refinement);
    expect(() => GoalRefinement.parse({ ...refinement, constraints: "not-array" })).toThrow();
  });

  it("parses GuidedRefinementInput with default and rejects blank title", () => {
    expectRoundTrip(GuidedRefinementInput.parse, { title: "Goal" }, { title: "Goal", description: "" });
    expect(() => GuidedRefinementInput.parse({ title: "" })).toThrow();
  });

  it("parses GuidedRefinementOutput and rejects wrong skill id", () => {
    expectRoundTrip(GuidedRefinementOutput.parse, guidedOutputFixture, guidedOutputFixture);
    expect(() => GuidedRefinementOutput.parse({ ...guidedOutputFixture, skillId: "quick-goal" })).toThrow();
  });

  it("keeps legacy create request body valid and supports refined workspace fields", () => {
    expectRoundTrip(CreateGoalRequest.parse, { title: "Legacy create", description: "" }, { title: "Legacy create", description: "" });

    const request = {
      title: "Refined create",
      description: "",
      refined: guidedOutputFixture,
      workspaces: [{ inputPath: "/tmp/ws", name: "workspace" }]
    };
    expectRoundTrip(CreateGoalRequest.parse, request, request);
    expect(() => CreateGoalRequest.parse({ ...request, workspaces: [{ inputPath: "", name: "x" }] })).toThrow();
  });

  it("parses RefineGoalRequest strictly and rejects unknown keys", () => {
    expectRoundTrip(RefineGoalRequest.parse, { title: "Refine me" }, { title: "Refine me", description: "" });
    expect(() => RefineGoalRequest.parse({ title: "Refine me", description: "", skillId: "x" })).toThrow();
  });

  it("parses RefineGoalResponse and rejects invalid draft", () => {
    expectRoundTrip(RefineGoalResponse.parse, { draft: guidedOutputFixture }, { draft: guidedOutputFixture });
    expect(() => RefineGoalResponse.parse({ draft: { ...guidedOutputFixture, constraints: [""] } })).toThrow();
  });

  it("parses InspectWorkspaceRequest strictly and rejects unknown keys", () => {
    expectRoundTrip(InspectWorkspaceRequest.parse, { inputPath: "/tmp/ws" }, { inputPath: "/tmp/ws" });
    expect(() => InspectWorkspaceRequest.parse({ inputPath: "/tmp/ws", extra: true })).toThrow();
  });

  it("parses InspectWorkspacePreview and response", () => {
    const preview = {
      path: workspaceFixture.path,
      name: workspaceFixture.name,
      workspaceType: workspaceFixture.workspaceType,
      branch: workspaceFixture.branch,
      isDirty: workspaceFixture.isDirty,
      gitProbe: workspaceFixture.gitProbe
    };

    expectRoundTrip(InspectWorkspacePreview.parse, preview, preview);
    expectRoundTrip(InspectWorkspaceResponse.parse, { preview }, { preview });

    expect(() => InspectWorkspacePreview.parse({ ...preview, gitProbe: "bad" })).toThrow();
    expect(() => InspectWorkspaceResponse.parse({ preview: { path: "/tmp" } })).toThrow();
  });

  it("parses AttachWorkspaceRequest strictly and AttachWorkspaceResponse", () => {
    expectRoundTrip(AttachWorkspaceRequest.parse, { inputPath: "/tmp/ws" }, { inputPath: "/tmp/ws" });
    expect(() => AttachWorkspaceRequest.parse({ inputPath: "/tmp/ws", unknown: "x" })).toThrow();

    const response = { workspace: workspaceFixture };
    expectRoundTrip(AttachWorkspaceResponse.parse, response, response);
    expect(() => AttachWorkspaceResponse.parse({ workspace: { ...workspaceFixture, id: 1 } })).toThrow();
  });

  it("parses GoalDetailResponse and rejects invalid nested structures", () => {
    const detail = {
      goal: goalFixture,
      refinement: {
        goalId: "goal-1",
        skillId: "guided-goal-refinement",
        successCriteria: ["a"],
        constraints: ["b"],
        assumptions: ["c"],
        refinedAt: now
      },
      workspaces: [workspaceFixture]
    };

    expectRoundTrip(GoalDetailResponse.parse, detail, detail);
    expect(() => GoalDetailResponse.parse({ ...detail, workspaces: [{ ...workspaceFixture, path: 1 }] })).toThrow();
  });

  it("parses GoalWorkspaceErrorCode and rejects unknown literals", () => {
    expect(GoalWorkspaceErrorCode.parse("workspace_duplicate")).toBe("workspace_duplicate");
    expect(() => GoalWorkspaceErrorCode.parse("permission_denied")).toThrow();
  });

  it("keeps existing Goal schema compatible", () => {
    expectRoundTrip(Goal.parse, goalFixture, goalFixture);
  });
});

describe("AdapterId now includes gemini-cli", () => {
  it("accepts gemini-cli", () => {
    expect(AdapterId.parse("gemini-cli")).toBe("gemini-cli");
  });
});

describe("agent readiness contracts", () => {
  it("accepts every persisted status", () => {
    for (const s of ["unchecked", "ready", "missing", "needs_auth", "misconfigured", "failed"] as const) {
      expect(AgentReadinessStatus.parse(s)).toBe(s);
    }
  });

  it("rejects the transient 'checking' status (UI-only)", () => {
    expect(() => AgentReadinessStatus.parse("checking")).toThrow();
  });

  it("AuthStatus is a closed union of three values", () => {
    for (const s of ["ready", "needs_auth", "misconfigured"] as const) {
      expect(AuthStatus.parse(s)).toBe(s);
    }
    expect(() => AuthStatus.parse("ok")).toThrow();
  });

  it("CheckStep validates a minimal install step", () => {
    expect(
      CheckStep.parse({ name: "installed", ok: true, command: "claude --version" })
    ).toMatchObject({ name: "installed", ok: true });
  });

  it("CheckStep requires authStatus only on authenticated steps", () => {
    // install step with no authStatus passes
    expect(CheckStep.parse({ name: "installed", ok: false, command: "claude --version" })).toBeDefined();
    // auth step with authStatus passes
    expect(
      CheckStep.parse({
        name: "authenticated",
        ok: true,
        authStatus: "ready",
        command: "claude auth status --json"
      })
    ).toBeDefined();
  });

  it("RepairAction.run_command requires `command`", () => {
    expect(() =>
      RepairAction.parse({ kind: "run_command", label: "Sign in" })
    ).toThrow();
    expect(
      RepairAction.parse({ kind: "run_command", command: "claude auth login", label: "Sign in" })
    ).toBeDefined();
  });

  it("RepairAction.install_url requires `url`", () => {
    expect(() => RepairAction.parse({ kind: "install_url", label: "Install" })).toThrow();
    expect(
      RepairAction.parse({ kind: "install_url", url: "https://example.invalid", label: "Install" })
    ).toBeDefined();
  });

  it("AgentReadinessReport round-trips", () => {
    const r = {
      agentId: "claude-code",
      status: "ready" as const,
      steps: [
        { name: "installed" as const, ok: true, command: "claude --version" },
        { name: "authenticated" as const, ok: true, authStatus: "ready" as const, command: "claude auth status --json" }
      ],
      checkedAt: "2026-05-22T00:00:00.000Z",
      version: "1.2.3"
    };
    expect(AgentReadinessReport.parse(r)).toEqual(r);
  });

  it("CheckReadinessAllResponse wraps an array of reports", () => {
    expect(CheckReadinessAllResponse.parse({ reports: [] })).toEqual({ reports: [] });
  });

  it("CheckReadinessOneResponse wraps a single report", () => {
    const report = {
      agentId: "codex",
      status: "needs_auth" as const,
      steps: [
        { name: "installed" as const, ok: true, command: "codex --version" },
        { name: "authenticated" as const, ok: false, authStatus: "needs_auth" as const, command: "codex login status" }
      ],
      repair: { kind: "run_command" as const, command: "codex login", label: "Sign in to Codex" },
      checkedAt: "2026-05-22T00:00:00.000Z"
    };
    expect(CheckReadinessOneResponse.parse({ report })).toEqual({ report });
  });

  it("Agent schema accepts an optional readiness field", () => {
    const base = {
      id: "claude-code",
      name: "Claude Code",
      shortLabel: "x",
      description: "x",
      swatch: "#000",
      recommended: true,
      connected: true,
      sortOrder: 10,
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z"
    };
    expect(Agent.parse(base)).toBeDefined();
    expect(Agent.parse({ ...base, readiness: null })).toBeDefined();
  });
});

describe("orchestrator chat contracts", () => {
  it("parses a goal-scoped orchestrator chat message", () => {
    expect(
      OrchestratorChatMessage.parse({
        id: "msg-1",
        goalId: "goal-1",
        role: "user",
        kind: "message",
        body: "Please keep the plan narrow.",
        correlationId: null,
        createdAt: "2026-05-26T12:00:00.000Z"
      })
    ).toMatchObject({ id: "msg-1", role: "user" });
  });

  it("parses create/list orchestrator message payloads", () => {
    expect(CreateOrchestratorMessageRequest.parse({ body: "Need a rollout plan." })).toEqual({
      body: "Need a rollout plan."
    });
    expect(
      ListOrchestratorMessagesResponse.parse({
        messages: []
      })
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
          createdAt: "2026-05-26T12:00:00.000Z"
        },
        reply: {
          id: "msg-orca",
          goalId: "goal-1",
          role: "orchestrator",
          kind: "message",
          body: "Start with a bounded verification pass.",
          correlationId: "corr-1",
          createdAt: "2026-05-26T12:00:01.000Z"
        }
      })
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
        createdAt: "2026-05-26T12:00:00.000Z"
      })
    ).toMatchObject({ type: "orchestrator.message.created" });
  });
});

describe("session contracts", () => {
  const sessionSummaryFixture = SessionSummary.parse({
    id: "sess-1",
    goalId: "goal-1",
    workspaceId: "ws-1",
    adapterId: "shell-manual",
    role: null,
    title: "Shell session",
    status: "created",
    createdAt: now,
    startedAt: null,
    exitedAt: null
  });

  const sessionDetailFixture = SessionDetail.parse({
    ...sessionSummaryFixture,
    instruction: "show status",
    pid: null,
    command: null,
    args: null,
    cwd: null,
    terminalCols: null,
    terminalRows: null,
    exitCode: null,
    exitSignal: null,
    failureReason: null,
    failureDetail: null,
    archivedAt: null
  });

  const outputSnapshotFixture = SessionOutputSnapshot.parse({
    sessionId: "sess-1",
    firstByteOffset: 0,
    nextSeq: 1,
    totalBytesKept: 10,
    chunks: [{ seq: 0, byteOffset: 0, dataBase64: "b3JjYS1wdHktb2sK" }]
  });

  it("appends the new domain event literals in order", () => {
    const sessionEvents = DomainEventType.options.filter((eventType) =>
      eventType.startsWith("session.")
    );
    expect(sessionEvents).toEqual([
      "session.created",
      "session.started",
      "session.exited",
      "session.failed",
      "session.stopped"
    ]);
  });

  it("parses session/adapters enums and rejects unknown literals", () => {
    expect(AdapterId.parse("codex")).toBe("codex");
    expect(SessionStatus.parse("running")).toBe("running");
    expect(SessionErrorCode.parse("adapter_not_found")).toBe("adapter_not_found");

    expect(() => AdapterId.parse("custom-adapter")).toThrow();
    expect(() => SessionStatus.parse("paused")).toThrow();
    expect(() => SessionErrorCode.parse("permission_denied")).toThrow();
  });

  it("parses adapter schemas", () => {
    const adapter = {
      id: "shell-manual" as const,
      title: "Shell",
      availability: "available" as const,
      detail: "Ready"
    };
    expectRoundTrip(AdapterSummary.parse, adapter, adapter);
    expectRoundTrip(
      ListAdaptersResponse.parse,
      { adapters: [adapter] },
      { adapters: [adapter] }
    );
  });

  it("parses session summary/detail/snapshot and lifecycle responses", () => {
    expectRoundTrip(SessionSummary.parse, sessionSummaryFixture, sessionSummaryFixture);
    expectRoundTrip(SessionDetail.parse, sessionDetailFixture, sessionDetailFixture);
    expectRoundTrip(SessionOutputSnapshot.parse, outputSnapshotFixture, outputSnapshotFixture);
    expectRoundTrip(
      CreateSessionResponse.parse,
      { session: sessionDetailFixture },
      { session: sessionDetailFixture }
    );
    expectRoundTrip(
      ListSessionsResponse.parse,
      { sessions: [sessionSummaryFixture] },
      { sessions: [sessionSummaryFixture] }
    );
    expectRoundTrip(
      GetSessionResponse.parse,
      { session: sessionDetailFixture, output: outputSnapshotFixture },
      { session: sessionDetailFixture, output: outputSnapshotFixture }
    );
    expectRoundTrip(
      StartSessionResponse.parse,
      { session: sessionDetailFixture },
      { session: sessionDetailFixture }
    );
    expectRoundTrip(
      StopSessionResponse.parse,
      { session: sessionDetailFixture },
      { session: sessionDetailFixture }
    );
  });

  it("parses strict create/start/stop requests and rejects unknown fields", () => {
    expectRoundTrip(
      CreateSessionRequest.parse,
      {
        workspaceId: "ws-1",
        adapterId: "claude-code",
        contextPackageId: "pkg-1",
        role: " implementer ",
        instruction: "Do the work",
        title: " Session one "
      },
      {
        workspaceId: "ws-1",
        adapterId: "claude-code",
        contextPackageId: "pkg-1",
        role: "implementer",
        instruction: "Do the work",
        title: "Session one"
      }
    );
    expect(() =>
      CreateSessionRequest.parse({
        workspaceId: "ws-1",
        adapterId: "claude-code",
        extra: true
      })
    ).toThrow();
    expect(() =>
      CreateSessionRequest.parse({
        workspaceId: "ws-1",
        adapterId: "claude-code",
        contextPackageId: 1
      })
    ).toThrow();

    expectRoundTrip(
      StartSessionRequest.parse,
      { terminalCols: 120, terminalRows: 30 },
      { terminalCols: 120, terminalRows: 30 }
    );
    expect(() =>
      StartSessionRequest.parse({ terminalCols: 120, terminalRows: 30, extra: true })
    ).toThrow();

    expectRoundTrip(StopSessionRequest.parse, {}, {});
    expect(() => StopSessionRequest.parse({ grace: true })).toThrow();
  });

  it("parses strict websocket frames and rejects unknown fields", () => {
    expectRoundTrip(
      SessionSubscribeFrame.parse,
      { type: "session.subscribe", sessionId: "sess-1" },
      { type: "session.subscribe", sessionId: "sess-1" }
    );
    expect(() =>
      SessionSubscribeFrame.parse({
        type: "session.subscribe",
        sessionId: "sess-1",
        extra: true
      })
    ).toThrow();

    expectRoundTrip(
      SessionUnsubscribeFrame.parse,
      { type: "session.unsubscribe", sessionId: "sess-1" },
      { type: "session.unsubscribe", sessionId: "sess-1" }
    );
    expect(() =>
      SessionUnsubscribeFrame.parse({
        type: "session.unsubscribe",
        sessionId: "sess-1",
        extra: true
      })
    ).toThrow();

    expectRoundTrip(
      SessionInputFrame.parse,
      { type: "session.input", sessionId: "sess-1", dataBase64: "YQ==" },
      { type: "session.input", sessionId: "sess-1", dataBase64: "YQ==" }
    );
    expect(() =>
      SessionInputFrame.parse({
        type: "session.input",
        sessionId: "sess-1",
        dataBase64: "YQ==",
        extra: true
      })
    ).toThrow();

    expectRoundTrip(
      SessionResizeFrame.parse,
      { type: "session.resize", sessionId: "sess-1", cols: 80, rows: 24 },
      { type: "session.resize", sessionId: "sess-1", cols: 80, rows: 24 }
    );
    expect(() =>
      SessionResizeFrame.parse({
        type: "session.resize",
        sessionId: "sess-1",
        cols: 80,
        rows: 24,
        extra: true
      })
    ).toThrow();

    expectRoundTrip(
      SessionOutputFrame.parse,
      {
        type: "session.output",
        sessionId: "sess-1",
        seq: 0,
        byteOffset: 0,
        dataBase64: "Yg=="
      },
      {
        type: "session.output",
        sessionId: "sess-1",
        seq: 0,
        byteOffset: 0,
        dataBase64: "Yg=="
      }
    );
    expect(() =>
      SessionOutputFrame.parse({
        type: "session.output",
        sessionId: "sess-1",
        seq: 0,
        byteOffset: 0,
        dataBase64: "Yg==",
        extra: true
      })
    ).toThrow();

    expectRoundTrip(
      SessionErrorFrame.parse,
      {
        type: "session.error",
        sessionId: "sess-1",
        code: "unknown_session",
        message: "missing session"
      },
      {
        type: "session.error",
        sessionId: "sess-1",
        code: "unknown_session",
        message: "missing session"
      }
    );
    expect(() =>
      SessionErrorFrame.parse({
        type: "session.error",
        code: "unknown_session",
        message: "missing session",
        extra: true
      })
    ).toThrow();
  });

  it("parses session.created payload with optional contextPackageId", () => {
    const payloadWithContext = {
      sessionId: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as const,
      contextPackageId: "pkg-1"
    };
    expectRoundTrip(
      SessionCreatedEventPayload.parse,
      payloadWithContext,
      payloadWithContext
    );

    const payloadWithoutContext = {
      sessionId: "sess-2",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as const
    };
    expectRoundTrip(
      SessionCreatedEventPayload.parse,
      payloadWithoutContext,
      payloadWithoutContext
    );
    expect(() =>
      SessionCreatedEventPayload.parse({
        ...payloadWithContext,
        contextPackageId: 123
      })
    ).toThrow();
  });
});

describe("memory contracts", () => {
  it("parses memory event enums and event union", () => {
    expect(MemoryDomainEventType.parse("memory.item.promoted")).toBe("memory.item.promoted");
    expect(() => MemoryDomainEventType.parse("memory.item.deleted")).toThrow();

    const event = {
      type: "memory.item.archived" as const,
      payload: {
        memoryItemId: "mem-1",
        goalId: "goal-1"
      }
    };
    expectRoundTrip(MemoryEvent.parse, event, event);
  });

  it("accepts valid memory row shapes and list wrappers", () => {
    const memoryItem = {
      id: "mem-1",
      goalId: "goal-1",
      type: "constraint" as const,
      status: "candidate" as const,
      content: "Use pnpm only",
      contentHash: "hash-1",
      confidence: 0.8,
      sourceType: "session" as const,
      sourceId: null,
      sourceSessionId: "sess-1",
      sourceExtractionId: "ext-1",
      sourceOffsetFirst: 10,
      sourceOffsetLast: 20,
      createdAt: now,
      updatedAt: now,
      promotedAt: null,
      archivedAt: null
    };
    const decision = {
      id: "dec-1",
      goalId: "goal-1",
      title: "Keep local-first",
      decisionText: "Do not add cloud sync to shared memory.",
      rationale: "Scope control",
      status: "proposed" as const,
      confirmationRequired: true,
      confidence: 0.7,
      sourceType: "session" as const,
      sourceId: null,
      sourceSessionId: "sess-1",
      sourceExtractionId: "ext-1",
      sourceOffsetFirst: 5,
      sourceOffsetLast: 25,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      archivedAt: null
    };
    const summary = {
      id: "sum-1",
      sessionId: "sess-1",
      goalId: "goal-1",
      extractionId: "ext-1",
      headline: "Session found one blocker",
      summaryText: "The run stopped due to a missing env var.",
      truncated: false,
      sourceOffsetFirst: 0,
      sourceOffsetLast: 99,
      createdAt: now
    };
    const extraction = {
      id: "ext-1",
      goalId: "goal-1",
      sessionId: "sess-1",
      trigger: "manual" as const,
      status: "succeeded" as const,
      extractorVersion: "memory-deterministic-v1",
      sourceFingerprint: "abc123",
      sourceOffsetFirst: 0,
      sourceOffsetLast: 99,
      summaryId: "sum-1",
      itemCount: 1,
      decisionCount: 1,
      promotedCount: 0,
      failureCode: null,
      failureMessage: null,
      requestedAt: now,
      startedAt: now,
      finishedAt: now
    };

    expectRoundTrip(GoalMemoryItem.parse, memoryItem, memoryItem);
    expectRoundTrip(GoalDecision.parse, decision, decision);
    expectRoundTrip(SessionMemorySummary.parse, summary, summary);
    expectRoundTrip(MemoryExtraction.parse, extraction, extraction);
    expectRoundTrip(
      ExtractSessionMemoryResponse.parse,
      { extraction },
      { extraction }
    );
    expectRoundTrip(
      ListGoalMemoryResponse.parse,
      { items: [memoryItem] },
      { items: [memoryItem] }
    );
    expectRoundTrip(
      ListGoalDecisionsResponse.parse,
      { items: [decision] },
      { items: [decision] }
    );
  });

  it("accepts valid extractor input/output schemas", () => {
    const input = {
      goal: {
        id: "goal-1",
        title: "Ship shared memory",
        status: "active" as const,
        archived: false
      },
      refinement: {
        id: "ref-1",
        problemStatement: "Capture durable goal memory",
        constraints: ["local-first"],
        successCriteria: ["memory rows survive restart"],
        stakeholders: ["developer"]
      },
      workspaces: [
        {
          id: "ws-1",
          label: "orca",
          rootPath: "/home/user/orca"
        }
      ],
      session: {
        id: "sess-1",
        adapterId: "shell-manual" as const,
        role: null,
        instructions: "run tests",
        exitCode: 0,
        terminalReason: "exited",
        startedAt: now,
        terminatedAt: now
      },
      outputTail: {
        text: "Tests passed",
        byteOffsetFirst: 0,
        byteOffsetLast: 12,
        truncated: false
      },
      extractorVersion: "memory-deterministic-v1"
    };
    const memoryCandidate = {
      type: "validation_result" as const,
      content: "pnpm -r test passed cleanly",
      confidence: 0.95,
      sourceOffsetFirst: 0,
      sourceOffsetLast: 12,
      promoteEligible: true
    };
    const decisionCandidate = {
      title: "Keep retry manual",
      decisionText: "Retry remains explicit via endpoint.",
      confidence: 0.8,
      confirmationRequired: true,
      sourceOffsetFirst: 0,
      sourceOffsetLast: 12
    };
    const output = {
      summary: {
        headline: "Tests passed",
        text: "No failures in this run.",
        truncated: false
      },
      memoryCandidates: [memoryCandidate],
      decisionCandidates: [decisionCandidate]
    };

    expectRoundTrip(SessionExtractionInput.parse, input, input);
    expectRoundTrip(MemoryCandidate.parse, memoryCandidate, memoryCandidate);
    expectRoundTrip(DecisionCandidate.parse, decisionCandidate, decisionCandidate);
    expectRoundTrip(SessionExtractionOutput.parse, output, output);
  });

  it("accepts all memory event payload schemas", () => {
    const payloads: Array<[parse: (input: unknown) => unknown, input: unknown]> = [
      [
        MemoryExtractionRequestedEventPayload.parse,
        { extractionId: "ext-1", goalId: "goal-1", sessionId: "sess-1", trigger: "manual" }
      ],
      [
        MemoryExtractionStartedEventPayload.parse,
        { extractionId: "ext-1", goalId: "goal-1", sessionId: "sess-1" }
      ],
      [
        MemoryExtractionCompletedEventPayload.parse,
        {
          extractionId: "ext-1",
          goalId: "goal-1",
          sessionId: "sess-1",
          summaryId: "sum-1",
          itemCount: 2,
          decisionCount: 1,
          promotedCount: 1,
          truncated: true
        }
      ],
      [
        MemoryExtractionFailedEventPayload.parse,
        {
          extractionId: "ext-1",
          goalId: "goal-1",
          sessionId: "sess-1",
          failureCode: "invalid_output"
        }
      ],
      [
        MemoryItemCreatedEventPayload.parse,
        {
          memoryItemId: "mem-1",
          goalId: "goal-1",
          type: "constraint",
          status: "candidate",
          sourceType: "session",
          sourceSessionId: "sess-1",
          sourceExtractionId: "ext-1"
        }
      ],
      [
        MemoryItemUpdatedEventPayload.parse,
        { memoryItemId: "mem-1", goalId: "goal-1", type: "constraint", status: "promoted" }
      ],
      [
        MemoryItemPromotedEventPayload.parse,
        { memoryItemId: "mem-1", goalId: "goal-1", type: "constraint" }
      ],
      [MemoryItemArchivedEventPayload.parse, { memoryItemId: "mem-1", goalId: "goal-1" }],
      [
        DecisionCreatedEventPayload.parse,
        {
          decisionId: "dec-1",
          goalId: "goal-1",
          status: "proposed",
          confirmationRequired: true,
          sourceType: "session",
          sourceSessionId: "sess-1",
          sourceExtractionId: "ext-1"
        }
      ],
      [DecisionUpdatedEventPayload.parse, { decisionId: "dec-1", goalId: "goal-1", status: "confirmed" }],
      [DecisionConfirmedEventPayload.parse, { decisionId: "dec-1", goalId: "goal-1" }],
      [DecisionArchivedEventPayload.parse, { decisionId: "dec-1", goalId: "goal-1" }]
    ];

    for (const [parse, input] of payloads) {
      expect(parse(input)).toEqual(input);
    }
  });

  it("rejects oversized row/request/output fields", () => {
    expect(() =>
      GoalMemoryItem.parse({
        id: "mem-1",
        goalId: "goal-1",
        type: "constraint",
        status: "candidate",
        content: "x".repeat(4001),
        contentHash: "hash-1",
        confidence: null,
        sourceType: "manual",
        sourceId: null,
        sourceSessionId: null,
        sourceExtractionId: null,
        sourceOffsetFirst: null,
        sourceOffsetLast: null,
        createdAt: now,
        updatedAt: now,
        promotedAt: null,
        archivedAt: null
      })
    ).toThrow();
    expect(() =>
      SessionMemorySummary.parse({
        id: "sum-1",
        sessionId: "sess-1",
        goalId: "goal-1",
        extractionId: "ext-1",
        headline: "x".repeat(201),
        summaryText: "ok",
        truncated: false,
        sourceOffsetFirst: 0,
        sourceOffsetLast: 1,
        createdAt: now
      })
    ).toThrow();
    expect(() =>
      CreateGoalDecisionRequest.parse({
        title: "x".repeat(201),
        decisionText: "ok"
      })
    ).toThrow();
    expect(() =>
      MemoryExtraction.parse({
        id: "ext-1",
        goalId: "goal-1",
        sessionId: "sess-1",
        trigger: "manual",
        status: "failed",
        extractorVersion: "memory-deterministic-v1",
        sourceFingerprint: "abc123",
        sourceOffsetFirst: null,
        sourceOffsetLast: null,
        summaryId: null,
        itemCount: 0,
        decisionCount: 0,
        promotedCount: 0,
        failureCode: "internal_error",
        failureMessage: "x".repeat(501),
        requestedAt: now,
        startedAt: now,
        finishedAt: now
      })
    ).toThrow();
  });

  it("rejects unknown or forbidden event payload fields", () => {
    expect(() =>
      MemoryItemCreatedEventPayload.parse({
        memoryItemId: "mem-1",
        goalId: "goal-1",
        type: "constraint",
        status: "candidate",
        sourceType: "session",
        sourceSessionId: "sess-1",
        sourceExtractionId: "ext-1",
        content: "secret text"
      })
    ).toThrow();
    expect(() =>
      DecisionCreatedEventPayload.parse({
        decisionId: "dec-1",
        goalId: "goal-1",
        status: "proposed",
        confirmationRequired: true,
        sourceType: "session",
        sourceSessionId: "sess-1",
        sourceExtractionId: "ext-1",
        decisionText: "never include in events"
      })
    ).toThrow();
    expect(() =>
      MemoryExtractionCompletedEventPayload.parse({
        extractionId: "ext-1",
        goalId: "goal-1",
        sessionId: "sess-1",
        summaryId: "sum-1",
        itemCount: 1,
        decisionCount: 0,
        promotedCount: 0,
        truncated: false,
        summaryText: "forbidden"
      })
    ).toThrow();
  });

  it("rejects invalid enums and invalid request status usage", () => {
    expect(() =>
      CreateGoalMemoryRequest.parse({
        type: "constraint",
        content: "x",
        status: "archived"
      })
    ).toThrow();
    expect(() =>
      CreateGoalDecisionRequest.parse({
        title: "t",
        decisionText: "x",
        status: "archived"
      })
    ).toThrow();
    expect(() => PatchGoalMemoryRequest.parse({})).toThrow();
    expect(() => PatchGoalMemoryRequest.parse({ status: "invalid" })).toThrow();
    expect(() => PatchGoalDecisionRequest.parse({})).toThrow();
    expect(() => PatchGoalDecisionRequest.parse({ status: "done" })).toThrow();
  });

  it("enforces extractor candidate count caps", () => {
    const memoryCandidate = { type: "note" as const, content: "x", promoteEligible: false };
    const decisionCandidate = { title: "t", decisionText: "x", confirmationRequired: true };

    expect(() =>
      SessionExtractionOutput.parse({
        memoryCandidates: new Array(26).fill(memoryCandidate),
        decisionCandidates: []
      })
    ).toThrow();
    expect(() =>
      SessionExtractionOutput.parse({
        memoryCandidates: [],
        decisionCandidates: new Array(11).fill(decisionCandidate)
      })
    ).toThrow();
  });

  it("keeps session read schemas back-compatible while allowing latest extraction fields", () => {
    const withLatest = {
      id: "sess-2",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as const,
      role: null,
      title: "Shell session",
      status: "exited" as const,
      createdAt: now,
      startedAt: now,
      exitedAt: now,
      latestExtraction: {
        id: "ext-2",
        status: "failed" as const,
        requestedAt: now,
        finishedAt: now,
        failureCode: "timeout" as const,
        truncated: true
      },
      latestSummaryHeadline: "Timed out before full completion"
    };

    expect(SessionSummary.parse(withLatest)).toEqual(withLatest);
    expect(() =>
      SessionSummary.parse({
        ...withLatest,
        latestExtraction: { ...withLatest.latestExtraction, failureCode: "unknown" }
      })
    ).toThrow();
  });
});

describe("Context package contracts", () => {
  const sourceFixture = {
    type: "memory_item" as const,
    id: "mem-1",
    sourceSessionId: "sess-1",
    label: "Constraint: local-first",
    reason: "required" as const,
    marker: "[S1]"
  };

  const packageFixture = {
    id: "pkg-1",
    goalId: "goal-1",
    supersedesPackageId: null,
    adapterId: "shell-manual" as const,
    workspaceId: "ws-1",
    role: "engineer" as const,
    objective: "Ship bounded context package",
    status: "ready" as const,
    renderedContext: "## Objective\n- Ship bounded context package",
    renderedBytes: 42,
    estimatedTokens: 11,
    truncated: false,
    sparse: false,
    sourceCount: 1,
    sources: [sourceFixture],
    warnings: [],
    sourceFingerprint: "srcfp-1",
    assemblerVersion: "context-deterministic-v1",
    createdAt: now
  };

  const assemblyFixture = {
    id: "asm-1",
    goalId: "goal-1",
    packageId: "pkg-1",
    replacePackageId: null,
    adapterId: "shell-manual" as const,
    workspaceId: "ws-1",
    role: "engineer" as const,
    objectiveHash: "obj-1",
    sourceFingerprint: "srcfp-1",
    assemblerVersion: "context-deterministic-v1",
    requestFingerprint: "reqfp-1",
    status: "succeeded" as const,
    trigger: "prepare" as const,
    failureCode: null,
    failureMessage: null,
    requestedAt: now,
    startedAt: now,
    finishedAt: now
  };

  it("parses context rows, request, responses, and event payloads", () => {
    expectRoundTrip(ContextSourceRef.parse, sourceFixture, sourceFixture);
    expectRoundTrip(ContextPackage.parse, packageFixture, packageFixture);
    expectRoundTrip(ContextAssembly.parse, assemblyFixture, assemblyFixture);

    const request = {
      adapterId: "shell-manual" as const,
      role: "architect" as const,
      objective: "Plan deterministic assembly",
      workspaceId: "ws-1"
    };
    expectRoundTrip(CreateContextPackageRequest.parse, request, request);
    expectRoundTrip(ListContextPackagesQuery.parse, {}, { limit: 20 });

    const createResponse = {
      package: packageFixture,
      assembly: assemblyFixture,
      reused: false
    };
    expectRoundTrip(
      CreateContextPackageResponse.parse,
      createResponse,
      createResponse
    );
    expectRoundTrip(
      ListContextPackagesResponse.parse,
      { packages: [packageFixture], assemblies: [assemblyFixture] },
      { packages: [packageFixture], assemblies: [assemblyFixture] }
    );
    expectRoundTrip(
      GetContextPackageResponse.parse,
      { package: packageFixture },
      { package: packageFixture }
    );

    const eventPayloads: Array<[parse: (input: unknown) => unknown, input: unknown]> = [
      [
        ContextAssemblyRequestedEventPayload.parse,
        {
          assemblyId: "asm-1",
          goalId: "goal-1",
          adapterId: "shell-manual",
          role: "engineer"
        }
      ],
      [
        ContextAssemblyCompletedEventPayload.parse,
        {
          assemblyId: "asm-1",
          goalId: "goal-1",
          packageId: "pkg-1",
          sourceCount: 4,
          renderedBytes: 1024,
          truncated: false
        }
      ],
      [
        ContextAssemblyFailedEventPayload.parse,
        {
          assemblyId: "asm-2",
          goalId: "goal-1",
          failureCode: "invalid_output"
        }
      ],
      [
        ContextPackageCreatedEventPayload.parse,
        {
          packageId: "pkg-1",
          goalId: "goal-1",
          adapterId: "shell-manual",
          role: "engineer",
          sourceCount: 4,
          renderedBytes: 1024
        }
      ]
    ];

    for (const [parse, input] of eventPayloads) {
      expect(parse(input)).toEqual(input);
    }
  });

  it("rejects oversized context package fields and source/warning caps", () => {
    expect(() =>
      ContextPackage.parse({
        ...packageFixture,
        renderedBytes: 32769
      })
    ).toThrow();
    expect(() =>
      ContextPackage.parse({
        ...packageFixture,
        objective: "x".repeat(4001)
      })
    ).toThrow();
    expect(() =>
      ContextPackage.parse({
        ...packageFixture,
        warnings: new Array(11).fill("warn")
      })
    ).toThrow();
    expect(() =>
      ContextPackage.parse({
        ...packageFixture,
        sources: new Array(61).fill(sourceFixture)
      })
    ).toThrow();
    expect(() =>
      ContextAssembly.parse({
        ...assemblyFixture,
        failureMessage: "x".repeat(257)
      })
    ).toThrow();
  });

  it("rejects forbidden content fields on strict context event payloads", () => {
    expect(() =>
      ContextPackageCreatedEventPayload.parse({
        packageId: "pkg-1",
        goalId: "goal-1",
        adapterId: "shell-manual",
        role: "engineer",
        sourceCount: 2,
        renderedBytes: 256,
        renderedContext: "do not leak"
      })
    ).toThrow();
    expect(() =>
      ContextAssemblyFailedEventPayload.parse({
        assemblyId: "asm-1",
        goalId: "goal-1",
        failureCode: "internal_error",
        objective: "forbidden"
      })
    ).toThrow();
    expect(() =>
      ContextAssemblyCompletedEventPayload.parse({
        assemblyId: "asm-1",
        goalId: "goal-1",
        packageId: "pkg-1",
        sourceCount: 2,
        renderedBytes: 256,
        truncated: false,
        assemblerInput: { raw: true }
      })
    ).toThrow();
  });

  it("rejects invalid context enum values", () => {
    expect(() => ContextRole.parse("qa")).toThrow();
    expect(() => ContextAssemblyStatus.parse("queued")).toThrow();
    expect(() => ContextAssemblyFailureCode.parse("timeout")).toThrow();
  });

  it("parses internal assembly IO schemas", () => {
    const input = {
      goal: {
        id: "goal-1",
        title: "Ship context packages",
        status: "active" as const,
        archivedAt: null
      },
      refinement: {
        id: "ref-1",
        version: 2,
        objective: "Bounded assembly",
        constraints: ["local-first"],
        successCriteria: ["events are content-free"],
        scopeNotes: "No provider integrations"
      },
      workspace: {
        id: "ws-1",
        name: "orca",
        pathDisplay: "/home/shawn/projects/orca",
        branch: "main",
        dirty: false
      },
      role: "reviewer" as const,
      adapterId: "shell-manual" as const,
      objective: "Validate context package contracts only",
      memory: [
        {
          id: "mem-1",
          type: "constraint" as const,
          status: "promoted" as const,
          content: "Keep payloads content-free",
          contentHash: "hash-1",
          confidence: 0.9,
          sourceSessionId: "sess-1",
          createdAt: now,
          updatedAt: now
        }
      ],
      decisions: [
        {
          id: "dec-1",
          title: "No transcript reads",
          decisionText: "Assembler never imports transcript modules.",
          rationale: null,
          status: "confirmed" as const,
          confirmationRequired: true,
          confidence: 0.9,
          sourceSessionId: "sess-1",
          createdAt: now,
          confirmedAt: now,
          updatedAt: now
        }
      ],
      siblingSummaries: [
        {
          id: "sum-1",
          sessionId: "sess-2",
          headline: "Regression checks pass",
          summaryText: "Shared memory loop remains green.",
          truncated: false,
          createdAt: now
        }
      ],
      budget: {
        maxBytes: 32768,
        perSectionMaxBytes: 8192,
        estimatedTokenBudget: 8192
      }
    };
    expectRoundTrip(ContextAssemblyInput.parse, input, input);

    const output = {
      sections: [
        {
          kind: "objective" as const,
          title: "Objective",
          body: "Validate bounded context package contract surface.",
          markers: ["[G1]"]
        }
      ],
      sources: [sourceFixture],
      warnings: [],
      truncated: false,
      sparse: false,
      estimatedTokens: 10
    };
    expectRoundTrip(ContextAssemblyOutput.parse, output, output);
  });
});

describe("CreateGoalAndStartWorkflowRequest", () => {
  it("accepts minimal valid input with workflowTemplateId", () => {
    const result = CreateGoalAndStartWorkflowRequest.safeParse({
      title: "My Goal",
      workflowTemplateId: "orca/engineering",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing workflowTemplateId", () => {
    const result = CreateGoalAndStartWorkflowRequest.safeParse({ title: "My Goal" });
    expect(result.success).toBe(false);
  });

  it("rejects empty workflowTemplateId", () => {
    const result = CreateGoalAndStartWorkflowRequest.safeParse({
      title: "My Goal",
      workflowTemplateId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("CreateGoalAndStartWorkflowResponse", () => {
  it("parses full success", () => {
    const r = CreateGoalAndStartWorkflowResponse.parse({
      ok: true,
      goalId: "g-1",
      workflowRunId: "r-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.goalId).toBe("g-1");
      expect(r.workflowRunId).toBe("r-1");
    }
  });

  it("parses startWorkflowRun failure (no runId)", () => {
    const r = CreateGoalAndStartWorkflowResponse.parse({
      ok: false,
      goalId: "g-1",
      bootstrapError: { phase: "startWorkflowRun", message: "template not found" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bootstrapError.phase).toBe("startWorkflowRun");
      expect(r.workflowRunId).toBeUndefined();
    }
  });

  it("parses requestDecision failure (runId present)", () => {
    const r = CreateGoalAndStartWorkflowResponse.parse({
      ok: false,
      goalId: "g-1",
      workflowRunId: "r-1",
      bootstrapError: { phase: "requestDecision", message: "orchestrator error" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bootstrapError.phase).toBe("requestDecision");
      expect(r.workflowRunId).toBe("r-1");
    }
  });
});

import {
  ExecutionMode,
  AdapterExecutionModeConfig,
  validateAdapterExecutionModeConfig,
} from "./index.js";

describe("ExecutionMode and AdapterExecutionModeConfig", () => {
  it("parses both execution modes", () => {
    expect(ExecutionMode.parse("shadow_session")).toBe("shadow_session");
    expect(ExecutionMode.parse("one_shot")).toBe("one_shot");
    expect(() => ExecutionMode.parse("invalid")).toThrow();
  });

  it("validates a valid config", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
      disabledExecutionModes: [{ mode: "one_shot", reason: "post 2026-06-15 -p billing" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(true);
  });

  it("rejects config with no preferred entry", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session" }],
      disabledExecutionModes: [],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.reason).toMatch(/preferred/); }
  });

  it("rejects config with multiple preferred entries", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [
        { mode: "shadow_session", preferred: true },
        { mode: "one_shot", preferred: true },
      ],
      disabledExecutionModes: [],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.reason).toMatch(/exactly one preferred/); }
  });

  it("rejects config with intersecting enabled and disabled", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
      disabledExecutionModes: [{ mode: "shadow_session", reason: "x" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.reason).toMatch(/cannot be both enabled and disabled/); }
  });

  it("rejects empty enabled list", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [],
      disabledExecutionModes: [{ mode: "shadow_session", reason: "x" }, { mode: "one_shot", reason: "y" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session", "one_shot"]);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.reason).toMatch(/non-empty/); }
  });

  it("rejects mode not in supportedExecutionModes", () => {
    const config: AdapterExecutionModeConfig = {
      adapterId: "claude-code",
      enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
      disabledExecutionModes: [{ mode: "one_shot", reason: "x" }],
    };
    const result = validateAdapterExecutionModeConfig(config, ["shadow_session"]); // one_shot not supported
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.reason).toMatch(/not supported/); }
  });
});
