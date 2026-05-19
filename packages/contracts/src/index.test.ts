import { describe, expect, it } from "vitest";

import {
  AdapterId,
  AdapterSummary,
  AttachWorkspaceRequest,
  AttachWorkspaceResponse,
  CreateGoalDecisionRequest,
  CreateGoalMemoryRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  DecisionArchivedEventPayload,
  DecisionCandidate,
  DecisionConfirmedEventPayload,
  DecisionCreatedEventPayload,
  DecisionUpdatedEventPayload,
  DomainEventType,
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
  InspectWorkspacePreview,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  ListAdaptersResponse,
  ListGoalDecisionsResponse,
  ListGoalMemoryResponse,
  ListSessionsResponse,
  M4SessionErrorCode,
  M5DomainEventType,
  M3ErrorCode,
  M5Event,
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
  RefineGoalRequest,
  RefineGoalResponse,
  SessionDetail,
  SessionErrorFrame,
  SessionExtractionInput,
  SessionExtractionOutput,
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
  WorkspaceType
} from "./index.js";

const now = "2026-01-01T00:00:00.000Z";

const goalFixture = Goal.parse({
  id: "goal-1",
  title: "Launch M3",
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
  title: "Launch M3",
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

describe("M3 contracts", () => {
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

  it("keeps M1/M2 create request body valid and supports additive M3 fields", () => {
    expectRoundTrip(CreateGoalRequest.parse, { title: "Legacy create", description: "" }, { title: "Legacy create", description: "" });

    const request = {
      title: "M3 create",
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

  it("parses M3ErrorCode and rejects unknown literals", () => {
    expect(M3ErrorCode.parse("workspace_duplicate")).toBe("workspace_duplicate");
    expect(() => M3ErrorCode.parse("permission_denied")).toThrow();
  });

  it("keeps existing Goal schema compatible", () => {
    expectRoundTrip(Goal.parse, goalFixture, goalFixture);
  });
});

describe("M4 contracts", () => {
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
    expect(M4SessionErrorCode.parse("adapter_not_found")).toBe("adapter_not_found");

    expect(() => AdapterId.parse("custom-adapter")).toThrow();
    expect(() => SessionStatus.parse("paused")).toThrow();
    expect(() => M4SessionErrorCode.parse("permission_denied")).toThrow();
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
        role: " implementer ",
        instruction: "Do the work",
        title: " Session one "
      },
      {
        workspaceId: "ws-1",
        adapterId: "claude-code",
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
});

describe("M5 contracts", () => {
  it("parses M5 enums and event union", () => {
    expect(M5DomainEventType.parse("memory.item.promoted")).toBe("memory.item.promoted");
    expect(() => M5DomainEventType.parse("memory.item.deleted")).toThrow();

    const event = {
      type: "memory.item.archived" as const,
      payload: {
        memoryItemId: "mem-1",
        goalId: "goal-1"
      }
    };
    expectRoundTrip(M5Event.parse, event, event);
  });

  it("accepts valid M5 row shapes and list wrappers", () => {
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
      decisionText: "Do not add cloud sync in M5.",
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
      extractorVersion: "m5-deterministic-v1",
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
        title: "Ship M5",
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
      extractorVersion: "m5-deterministic-v1"
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

  it("accepts all M5 event payload schemas", () => {
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
        extractorVersion: "m5-deterministic-v1",
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
