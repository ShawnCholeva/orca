import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AdapterId, ContextAssembly, ContextPackage, DomainEvent } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const now = "2026-01-01T00:00:00.000Z";

const pkg: ContextPackage = {
  id: "pkg-1",
  goalId: "goal-1",
  supersedesPackageId: null,
  adapterId: "shell-manual" as AdapterId,
  workspaceId: "ws-1",
  role: "engineer",
  objective: "Summarize the goal before starting",
  status: "ready",
  renderedContext: "# Objective\nSummarize the goal before starting\n",
  renderedBytes: 42,
  estimatedTokens: 11,
  truncated: false,
  sparse: false,
  sourceCount: 2,
  sources: [
    { type: "goal", id: "goal-1", sourceSessionId: null, label: "Goal", reason: "required", marker: "[S1]" },
    { type: "memory_item", id: "mem-1", sourceSessionId: null, label: "Constraint", reason: "high_confidence", marker: "[S2]" },
  ],
  warnings: [],
  sourceFingerprint: "fp-1",
  assemblerVersion: "0.1.0",
  createdAt: now,
};

const succeededAssembly: ContextAssembly = {
  id: "asm-1",
  goalId: "goal-1",
  packageId: "pkg-1",
  replacePackageId: null,
  adapterId: "shell-manual" as AdapterId,
  workspaceId: "ws-1",
  role: "engineer",
  objectiveHash: "obj-hash",
  sourceFingerprint: "fp-1",
  assemblerVersion: "0.1.0",
  requestFingerprint: "req-fp-1",
  status: "succeeded",
  trigger: "prepare",
  failureCode: null,
  failureMessage: null,
  requestedAt: now,
  startedAt: now,
  finishedAt: now,
};

const pendingAssembly: ContextAssembly = {
  ...succeededAssembly,
  id: "asm-pending",
  packageId: null,
  status: "pending",
  finishedAt: null,
};

const failedAssembly: ContextAssembly = {
  ...succeededAssembly,
  id: "asm-failed",
  packageId: null,
  status: "failed",
  failureCode: "output_too_large",
  failureMessage: "Rendered context exceeds 32 KiB limit",
  finishedAt: now,
};

function makeDomainEvent(type: DomainEvent["type"], goalId = "goal-1"): DomainEvent {
  return { seq: 1, id: "evt-1", type, goalId, payload: {}, createdAt: now };
}

function mockApi(overrides: Record<string, unknown> = {}) {
  vi.doMock("../../api", () => ({
    openEventStream: vi.fn().mockReturnValue({ close: vi.fn() }),
    listContextPackages: vi.fn().mockResolvedValue({ packages: [], assemblies: [] }),
    getContextPackage: vi.fn().mockResolvedValue({ package: pkg }),
    toErrorMessage: (err: unknown, fallback: string) =>
      err instanceof Error ? err.message : fallback,
    ...overrides,
  }));
}

describe("ContextPreviewPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("idle state shows guidance to click Prepare context", async () => {
    mockApi();
    const { ContextPreviewPanel } = await import("../context-preview-panel");

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={null}
          pkg={null}
          onStartSession={vi.fn()}
          onRegenerate={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".context-preview-panel--idle")).toBeTruthy();
    expect(container.querySelector(".context-preview-idle-hint")?.textContent).toContain(
      "Prepare context",
    );
    expect(container.querySelector(".context-preview-body")).toBeNull();
  });

  it("preparing state shows spinner; subsequent ready event transitions to ready", async () => {
    let capturedOnEvent: ((e: DomainEvent) => void) | null = null;

    const listContextPackages = vi.fn().mockResolvedValue({
      packages: [pkg],
      assemblies: [{ ...pendingAssembly, status: "succeeded", packageId: "pkg-1" }],
    });
    const getContextPackage = vi.fn().mockResolvedValue({ package: pkg });

    mockApi({
      openEventStream: vi.fn().mockImplementation(
        (handlers: { onEvent: (e: DomainEvent) => void }) => {
          capturedOnEvent = handlers.onEvent;
          return { close: vi.fn() };
        },
      ),
      listContextPackages,
      getContextPackage,
    });

    const { ContextPreviewPanel } = await import("../context-preview-panel");

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={pendingAssembly}
          pkg={null}
          onStartSession={vi.fn()}
          onRegenerate={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".context-preview-preparing")).toBeTruthy();
    expect(container.querySelector(".context-preview-body")).toBeNull();

    expect(capturedOnEvent).not.toBeNull();

    await act(async () => {
      capturedOnEvent!(makeDomainEvent("context.package.created"));
      // flush microtask chain for async refetch
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listContextPackages).toHaveBeenCalled();
    expect(getContextPackage).toHaveBeenCalledWith("pkg-1");
    expect(container.querySelector(".context-preview-body")).toBeTruthy();
    expect(container.querySelector(".context-preview-preparing")).toBeNull();
  });

  it("failed assembly with output_too_large shows right message and Retry button", async () => {
    mockApi();
    const { ContextPreviewPanel } = await import("../context-preview-panel");

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={failedAssembly}
          pkg={null}
          onStartSession={vi.fn()}
          onRegenerate={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".context-preview-failed")).toBeTruthy();
    expect(container.querySelector(".context-preview-failure-message")?.textContent).toContain(
      "exceeds the size limit",
    );
    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    );
    expect(retryBtn).toBeTruthy();
    expect(container.querySelector(".context-preview-body")).toBeNull();
  });

  it("failed assembly with internal_error shows right message", async () => {
    mockApi();
    const { ContextPreviewPanel } = await import("../context-preview-panel");

    const internalErrorAssembly: ContextAssembly = {
      ...failedAssembly,
      id: "asm-internal",
      failureCode: "internal_error",
      failureMessage: "Something went wrong",
    };

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={internalErrorAssembly}
          pkg={null}
          onStartSession={vi.fn()}
          onRegenerate={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".context-preview-failure-message")?.textContent).toContain(
      "internal error",
    );
    expect(
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Retry"),
    ).toBeTruthy();
  });

  it("sparse state shows Sparse badge and 'Context is thin' note", async () => {
    mockApi();
    const { ContextPreviewPanel } = await import("../context-preview-panel");

    const sparsePkg: ContextPackage = { ...pkg, id: "pkg-sparse", sparse: true };
    const sparseAssembly: ContextAssembly = {
      ...succeededAssembly,
      id: "asm-sparse",
      packageId: "pkg-sparse",
    };

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={sparseAssembly}
          pkg={sparsePkg}
          onStartSession={vi.fn()}
          onRegenerate={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".context-preview-badge--sparse")).toBeTruthy();
    expect(container.querySelector(".context-preview-sparse-note")?.textContent).toContain(
      "Context is thin",
    );
  });

  it("truncated state shows Truncated badge", async () => {
    mockApi();
    const { ContextPreviewPanel } = await import("../context-preview-panel");

    const truncatedPkg: ContextPackage = { ...pkg, id: "pkg-trunc", truncated: true };
    const truncatedAssembly: ContextAssembly = {
      ...succeededAssembly,
      id: "asm-trunc",
      packageId: "pkg-trunc",
    };

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={truncatedAssembly}
          pkg={truncatedPkg}
          onStartSession={vi.fn()}
          onRegenerate={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".context-preview-badge--truncated")).toBeTruthy();
    expect(container.querySelector(".context-preview-badge--sparse")).toBeNull();
  });

  it("Regenerate button calls onRegenerate with the current package id", async () => {
    mockApi();
    const { ContextPreviewPanel } = await import("../context-preview-panel");

    const onRegenerate = vi.fn();

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={succeededAssembly}
          pkg={pkg}
          onStartSession={vi.fn()}
          onRegenerate={onRegenerate}
          onRetry={vi.fn()}
        />,
      );
    });

    const regenBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Regenerate",
    );
    expect(regenBtn).toBeTruthy();

    await act(async () => {
      regenBtn?.click();
    });

    expect(onRegenerate).toHaveBeenCalledWith("pkg-1");
  });

  it("Retry button calls onRetry with no arguments", async () => {
    mockApi();
    const { ContextPreviewPanel } = await import("../context-preview-panel");

    const onRetry = vi.fn();

    await act(async () => {
      createRoot(container).render(
        <ContextPreviewPanel
          goalId="goal-1"
          assembly={failedAssembly}
          pkg={null}
          onStartSession={vi.fn()}
          onRegenerate={vi.fn()}
          onRetry={onRetry}
        />,
      );
    });

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Retry",
    );
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn?.click();
    });

    expect(onRetry).toHaveBeenCalledWith();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
