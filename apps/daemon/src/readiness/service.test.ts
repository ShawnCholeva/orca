import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "../db.js";
import { runMigrations, defaultMigrationsDir } from "../migrations.js";
import { seedAgents, setAgentConnected, listAgents } from "../agents.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { AgentAdapter } from "../adapters/types.js";
import { ReadinessService, UnknownAgentError } from "./service.js";
import { AgentReadinessReport, type AgentReadinessStatus, type CheckStep } from "@orca/contracts";

function makeAdapter(id: string, opts: {
  install: CheckStep & { version?: string };
  auth: CheckStep;
  throws?: boolean;
}): AgentAdapter {
  return {
    id: id as never,
    title: id,
    supportedExecutionModes: ["shadow_session" as const],
    contextDelivery: { mode: "preview_only", maxBytes: 32768 },
    async resolveSpawn() { throw new Error("unused"); },
    async probeAvailability() { return { status: "available" as const }; },
    async checkInstalled() {
      if (opts.throws) throw new Error("boom");
      return opts.install;
    },
    async checkAuth() { return opts.auth; },
    repairFor(s: AgentReadinessStatus) {
      if (s === "ready") return undefined;
      return { kind: "run_command" as const, command: `${id} fix`, label: "Fix" };
    },
    supportsModel: () => false,
  };
}

let db: Database.Database;
beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-svc-"));
  db = openDatabase({
    dataDir: dir, port: 0, logLevel: "silent",
    sessionOutputTailBytes: 1024, sessionStopGraceMs: 100, sessionWsBufferLimitBytes: 1024,
    memoryExtractionMaxInputBytes: 1024, memoryExtractionTimeoutMs: 1000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "t",
  });
  runMigrations(db, defaultMigrationsDir());
  seedAgents(db);
});
afterEach(() => closeDatabase());

describe("ReadinessService.checkAgent", () => {
  it("install ok + auth ready → status ready, persisted", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("claude-code", {
      install: { name: "installed", ok: true, command: "claude --version", version: "1.2.3" },
      auth: { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
    }));
    setAgentConnected(db, "claude-code", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("claude-code");
    expect(report.status).toBe("ready");
    expect(report.steps).toHaveLength(2);
    const row = listAgents(db).find((a) => a.id === "claude-code")!;
    expect(row.readiness?.status).toBe("ready");
  });

  it("install fails → status missing, auth skipped", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex", {
      install: { name: "installed", ok: false, command: "codex --version", detail: "not found" },
      auth: { name: "authenticated", ok: false, authStatus: "needs_auth", command: "codex login status" },
    }));
    setAgentConnected(db, "codex", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("codex");
    expect(report.status).toBe("missing");
    expect(report.steps).toHaveLength(1);
    expect(report.repair).toBeDefined();
  });

  it("authStatus needs_auth → status needs_auth, repair set", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex", {
      install: { name: "installed", ok: true, command: "codex --version" },
      auth: { name: "authenticated", ok: false, authStatus: "needs_auth", command: "codex login status" },
    }));
    setAgentConnected(db, "codex", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("codex");
    expect(report.status).toBe("needs_auth");
    expect(report.repair?.command).toBe("codex fix");
  });

  it("adapter throws → persisted failed report (not stale)", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("codex", {
      install: { name: "installed", ok: true, command: "codex --version" },
      auth: { name: "authenticated", ok: true, authStatus: "ready", command: "codex login status" },
      throws: true,
    }));
    setAgentConnected(db, "codex", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("codex");
    expect(report.status).toBe("failed");
    const row = listAgents(db).find((a) => a.id === "codex")!;
    expect(row.readiness?.status).toBe("failed");
  });

  it("adapter throws without failed repair → report remains contract-valid", async () => {
    const registry = new AdapterRegistry();
    registry.register({
      ...makeAdapter("codex", {
        install: { name: "installed", ok: true, command: "codex --version" },
        auth: { name: "authenticated", ok: true, authStatus: "ready", command: "codex login status" },
        throws: true,
      }),
      repairFor() {
        return undefined;
      },
    });
    setAgentConnected(db, "codex", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const report = await svc.checkAgent("codex");
    expect(() => AgentReadinessReport.parse(report)).not.toThrow();
    expect(report.repair).toBeUndefined();
  });

  it("unknown agent throws UnknownAgentError", async () => {
    const svc = new ReadinessService(db, new AdapterRegistry());
    await expect(svc.checkAgent("nope")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("dedups concurrent calls for the same id", async () => {
    let count = 0;
    const registry = new AdapterRegistry();
    registry.register({
      ...makeAdapter("claude-code", {
        install: { name: "installed", ok: true, command: "claude --version" },
        auth: { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
      }),
      async checkInstalled() {
        count++;
        await new Promise((r) => setTimeout(r, 50));
        return { name: "installed" as const, ok: true, command: "claude --version" };
      },
    });
    setAgentConnected(db, "claude-code", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    await Promise.all([svc.checkAgent("claude-code"), svc.checkAgent("claude-code")]);
    expect(count).toBe(1);
  });
});

describe("ReadinessService.checkSelected", () => {
  it("runs only connected agents in parallel", async () => {
    const registry = new AdapterRegistry();
    registry.register(makeAdapter("claude-code", {
      install: { name: "installed", ok: true, command: "claude --version" },
      auth: { name: "authenticated", ok: true, authStatus: "ready", command: "claude auth status --json" },
    }));
    registry.register(makeAdapter("codex", {
      install: { name: "installed", ok: true, command: "codex --version" },
      auth: { name: "authenticated", ok: false, authStatus: "needs_auth", command: "codex login status" },
    }));
    setAgentConnected(db, "claude-code", true);
    setAgentConnected(db, "codex", true);
    const svc = new ReadinessService(db, registry, () => "2026-05-22T00:00:00.000Z");
    const reports = await svc.checkSelected();
    expect(reports.map((r) => r.agentId).sort()).toEqual(["claude-code", "codex"]);
  });
});
