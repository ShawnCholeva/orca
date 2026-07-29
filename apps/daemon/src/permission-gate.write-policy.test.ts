// apps/daemon/src/permission-gate.write-policy.test.ts
// A step template may declare `workspaceWrites: "deny"` (pre-implementation steps
// do). Enforcement cannot live in the PermissionRequest path alone: that hook only
// fires when Claude Code would otherwise prompt, so anything auto-allowed by a
// workspace allow-rule never reaches it. This policy is evaluated from the
// PreToolUse write-gate, which fires for EVERY edit-tool call.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { EventBus } from "./events.js";
import { resolveStepWriteDenial, resolveToolPolicyDenial } from "./permission-gate.js";
import { listTransitionsByGoal, resetPreparedStatements as resetTx } from "./harness-transitions/usecases.js";

const tempDirs: string[] = [];
function createConfig(d: string): Config {
  return { dataDir: d, port: 8787, logLevel: "silent", sessionOutputTailBytes: 1048576, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1048576, memoryExtractionMaxInputBytes: 131072, memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node","t.js"], getAuthToken: () => "t" };
}

const NOW = "2026-01-01T00:00:00.000Z";
const WS_ROOT = "/tmp/orca-ws";

function seed(db: Database.Database, workspaceWrites: "deny" | undefined) {
  const step = {
    id: "research", ordinal: 0, name: "Research", instructions: "Ground the frame.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
    ...(workspaceWrites ? { workspaceWrites } : {}),
  };
  const snapshot = {
    id: "t", name: "T", description: "", version: 1, steps: [step], guardrails: [], graph: null,
    isBuiltIn: true, isLocked: false, scope: "global", scopeName: "", category: "Engineering",
    createdAt: NOW, updatedAt: NOW,
  };
  db.prepare(`INSERT INTO goals (id,title,intent,status,autonomy_level,created_at,updated_at,archived_at,operating_mode) VALUES ('g','x','','active',1,?,?,NULL,'human_review')`).run(NOW, NOW);
  db.prepare(`INSERT INTO workspaces (id,path,name,description,created_at,updated_at) VALUES ('ws',?,'m','',?,?)`).run(WS_ROOT, NOW, NOW);
  db.prepare(`INSERT INTO goal_workspaces (goal_id,workspace_id,attached_at) VALUES ('g','ws',?)`).run(NOW);
  db.prepare(`INSERT INTO workflow_templates (id,name,description,version,is_built_in,steps_json,guardrails_json,created_at,updated_at) VALUES ('t','T','',1,1,?,'[]',?,?)`).run(JSON.stringify([step]), NOW, NOW);
  db.prepare(`INSERT INTO workflow_runs (id,goal_id,template_id,template_version,status,started_at,template_snapshot_json) VALUES ('r','g','t',1,'active',?,?)`).run(NOW, JSON.stringify(snapshot));
  db.prepare(`INSERT INTO workflow_step_runs (id,goal_id,workflow_run_id,step_template_id,ordinal,status,started_at,fingerprint) VALUES ('sr','g','r','research',0,'active',?,'fp')`).run(NOW);
  db.prepare(`INSERT INTO sessions (id,goal_id,workspace_id,adapter_id,title,status,created_at,workflow_step_run_id) VALUES ('s','g','ws','claude-code','t','running',?,'sr')`).run(NOW);
}

let db: Database.Database;
beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-writepolicy-")); tempDirs.push(dir);
  db = openDatabase(createConfig(dir)); runMigrations(db, defaultMigrationsDir());
});
afterEach(() => { closeDatabase(); resetTx(); for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("resolveToolPolicyDenial", () => {
  // A PermissionRequest deny carries no reason field, so the agent sees only
  // "Denied by PermissionRequest hook" — which reads as an obstacle to route
  // around, not a rule. That is how a denied inline `node -e` probe became a
  // probe.mjs written to disk and run instead. PreToolUse CAN carry a reason.
  let ctx: () => { db: Database.Database; bus: EventBus; now: () => string; idFactory: () => string };
  beforeEach(() => {
    let n = 0;
    ctx = () => ({ db, bus: new EventBus(), now: () => NOW, idFactory: () => `id-${++n}` });
  });

  it("denies a hard-constraint bash command with a reason naming the violation", () => {
    seed(db, undefined);
    const reason = resolveToolPolicyDenial(ctx(), "s", { toolName: "Bash", toolInput: { command: "rm -rf /" } });
    expect(reason).toContain("destructive recursive delete");
  });

  it("records the hard-constraint deny as a tool_gate transition", () => {
    seed(db, undefined);
    resolveToolPolicyDenial(ctx(), "s", { toolName: "Bash", toolInput: { command: "cat ~/.ssh/id_rsa" } });
    const t = listTransitionsByGoal(db, "g").filter((x) => x.boundary === "tool_gate");
    expect(t).toHaveLength(1);
    expect(t[0]?.risk?.gate_decision).toBe("deny");
  });

  it("has no opinion on a benign bash command, leaving approval to the normal gate", () => {
    seed(db, undefined);
    expect(resolveToolPolicyDenial(ctx(), "s", { toolName: "Bash", toolInput: { command: "pnpm test" } })).toBeNull();
    expect(listTransitionsByGoal(db, "g").filter((x) => x.boundary === "tool_gate")).toHaveLength(0);
  });

  it("does not deny a readonly probe that merely mentions process.env", () => {
    seed(db, undefined);
    const command = `node -e "new D(process.env.HOME+'/.orca/orca.db',{readonly:true})"`;
    expect(resolveToolPolicyDenial(ctx(), "s", { toolName: "Bash", toolInput: { command } })).toBeNull();
  });

  it("still applies the step write policy", () => {
    seed(db, "deny");
    const reason = resolveToolPolicyDenial(ctx(), "s", { toolName: "Write", toolInput: { file_path: `${WS_ROOT}/a.ts` } });
    expect(reason).toMatch(/Research/);
  });
});

describe("resolveStepWriteDenial", () => {
  it("denies a Write into the workspace while a deny-step is active", () => {
    seed(db, "deny");
    const reason = resolveStepWriteDenial(db, "s", { toolName: "Write", toolInput: { file_path: `${WS_ROOT}/src/a.ts` } });
    expect(reason).toMatch(/Research/);
  });

  it("denies Edit and NotebookEdit too, not just Write", () => {
    seed(db, "deny");
    expect(resolveStepWriteDenial(db, "s", { toolName: "Edit", toolInput: { file_path: `${WS_ROOT}/a.ts` } })).toBeTruthy();
    expect(resolveStepWriteDenial(db, "s", { toolName: "NotebookEdit", toolInput: { notebook_path: `${WS_ROOT}/a.ipynb` } })).toBeTruthy();
  });

  it("allows the agent's own scratchpad outside the workspace", () => {
    // The live incident's probe.mjs lived here. Read-only steps still need scratch
    // space to think in; the policy protects the workspace, not the agent.
    seed(db, "deny");
    expect(resolveStepWriteDenial(db, "s", { toolName: "Write", toolInput: { file_path: "/private/tmp/claude-501/x/scratchpad/probe.mjs" } })).toBeNull();
  });

  it("allows a workspace write when the step does not declare a policy", () => {
    seed(db, undefined);
    expect(resolveStepWriteDenial(db, "s", { toolName: "Write", toolInput: { file_path: `${WS_ROOT}/src/a.ts` } })).toBeNull();
  });

  it("ignores non-edit tools", () => {
    seed(db, "deny");
    expect(resolveStepWriteDenial(db, "s", { toolName: "Read", toolInput: { file_path: `${WS_ROOT}/a.ts` } })).toBeNull();
    expect(resolveStepWriteDenial(db, "s", { toolName: "Bash", toolInput: { command: "ls" } })).toBeNull();
  });

  it("has no opinion when the pinned template snapshot will not parse", () => {
    // This runs on every edit-tool call. A parse failure must never break the
    // agent's turn — it degrades to ungoverned, which the normal gate still covers.
    seed(db, "deny");
    db.prepare("UPDATE workflow_runs SET template_snapshot_json = '{not json' WHERE id = 'r'").run();
    expect(() =>
      resolveStepWriteDenial(db, "s", { toolName: "Write", toolInput: { file_path: `${WS_ROOT}/a.ts` } })
    ).not.toThrow();
    expect(resolveStepWriteDenial(db, "s", { toolName: "Write", toolInput: { file_path: `${WS_ROOT}/a.ts` } })).toBeNull();
  });

  it("has no opinion on an unknown session", () => {
    // Fail-OPEN by design: this gate only ever adds a denial. An unattributable
    // session falls through to resolvePermissionDecision, which fails closed.
    seed(db, "deny");
    expect(resolveStepWriteDenial(db, "nope", { toolName: "Write", toolInput: { file_path: `${WS_ROOT}/a.ts` } })).toBeNull();
  });
});
