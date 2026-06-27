import { describe, expect, it, beforeEach } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";
import { EventBus } from "../../events.js";
import {
  duplicateTemplate,
  installBuiltInTemplates,
  reconcileBuiltInTemplates,
  upgradeInstalledBuiltInTemplates,
  UnknownBuiltInTemplateError,
} from "./usecases.js";

let db: Database.Database;
function ctx() {
  return { db, bus: new EventBus(), now: () => "2026-01-01T00:00:00.000Z" };
}
beforeEach(() => {
  db = new DatabaseCtor(":memory:");
  runMigrations(db, defaultMigrationsDir());
});

describe("installBuiltInTemplates", () => {
  it("installs only the requested catalog ids as built-in/locked rows", () => {
    const templates = installBuiltInTemplates(ctx(), ["orca/adaptive-delivery", "orca/code-review"]);
    expect(templates.map((t) => t.id).sort()).toEqual(["orca/adaptive-delivery", "orca/code-review"].sort());
    expect(templates.every((t) => t.isBuiltIn && t.isLocked)).toBe(true);
    const count = db.prepare("SELECT COUNT(*) c FROM workflow_templates").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("is idempotent — re-installing the same id does not duplicate", () => {
    installBuiltInTemplates(ctx(), ["orca/adaptive-delivery"]);
    installBuiltInTemplates(ctx(), ["orca/adaptive-delivery"]);
    const count = db.prepare("SELECT COUNT(*) c FROM workflow_templates WHERE id = ?").get("orca/adaptive-delivery") as { c: number };
    expect(count.c).toBe(1);
  });

  it("rejects ids not in the catalog", () => {
    expect(() => installBuiltInTemplates(ctx(), ["orca/nope"])).toThrow(UnknownBuiltInTemplateError);
  });

  it("installs nothing for an empty list", () => {
    expect(installBuiltInTemplates(ctx(), [])).toEqual([]);
  });
});

describe("reconcileBuiltInTemplates", () => {
  function insertBuiltIn(id: string) {
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, '', 1, 1, 1, '[]', '[]', 't', 't')"
    ).run(id, id);
  }

  it("deletes built-ins not in the catalog when they have no runs", () => {
    insertBuiltIn("orca/engineering");
    reconcileBuiltInTemplates(db);
    const row = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get("orca/engineering");
    expect(row).toBeUndefined();
  });

  it("preserves a stale built-in that still has a workflow run", () => {
    insertBuiltIn("orca/engineering");
    db.prepare(
      "INSERT INTO goals (id, title, description, status, created_at, updated_at) VALUES ('g1','t','d','active','t','t')"
    ).run();
    db.prepare(
      "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES ('r1','g1','orca/engineering',1,'completed','t')"
    ).run();
    reconcileBuiltInTemplates(db);
    const row = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get("orca/engineering");
    expect(row).toBeTruthy();
  });

  it("never touches catalog templates", () => {
    installBuiltInTemplates(ctx(), ["orca/adaptive-delivery"]);
    reconcileBuiltInTemplates(db);
    const row = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get("orca/adaptive-delivery");
    expect(row).toBeTruthy();
  });
});

describe("category persistence", () => {
  it("upsertBuiltInTemplate persists category from catalog definition", () => {
    installBuiltInTemplates(ctx(), ["orca/adaptive-delivery"]);
    const row = db
      .prepare("SELECT category FROM workflow_templates WHERE id = ?")
      .get("orca/adaptive-delivery") as { category: string } | undefined;
    expect(row?.category).toBe("Engineering");
  });

  it("installBuiltInTemplates returns templates with category field", () => {
    const [template] = installBuiltInTemplates(ctx(), ["orca/code-review"]);
    expect(template?.category).toBe("Engineering");
  });

  it("duplicateTemplate inherits source category", () => {
    installBuiltInTemplates(ctx(), ["orca/bug-triage-fix"]);
    const copy = duplicateTemplate(ctx(), { sourceTemplateId: "orca/bug-triage-fix", name: "Copy" });
    expect(copy.category).toBe("Engineering");
  });
});

describe("upgradeInstalledBuiltInTemplates", () => {
  function insertOldBuiltIn(id: string, version: number) {
    const steps = JSON.stringify([
      {
        id: "old_step",
        ordinal: 0,
        name: "Old Step",
        instructions: "do",
        outputSchema: [{ key: "s", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      },
    ]);
    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, '', ?, 1, 1, ?, '[]', ?, ?)"
    ).run(id, id, version, steps, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  }

  it("upgrades an installed built-in to the current catalog version", () => {
    insertOldBuiltIn("orca/bug-triage-fix", 1);
    upgradeInstalledBuiltInTemplates(ctx());
    const row = db
      .prepare("SELECT version, steps_json, graph_json FROM workflow_templates WHERE id = ?")
      .get("orca/bug-triage-fix") as { version: number; steps_json: string; graph_json: string | null };
    expect(row.version).toBe(4);
    expect(row.steps_json).toContain('"id":"done"');
    expect(row.graph_json).not.toBeNull();
  });

  it("does not install built-ins that were never installed", () => {
    upgradeInstalledBuiltInTemplates(ctx());
    const count = db
      .prepare("SELECT COUNT(*) c FROM workflow_templates WHERE is_built_in = 1")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("leaves an already-current built-in unchanged (version-guarded no-op)", () => {
    installBuiltInTemplates(ctx(), ["orca/bug-triage-fix"]);
    const before = db
      .prepare("SELECT version FROM workflow_templates WHERE id = ?")
      .get("orca/bug-triage-fix") as { version: number };
    upgradeInstalledBuiltInTemplates(ctx());
    const after = db
      .prepare("SELECT version FROM workflow_templates WHERE id = ?")
      .get("orca/bug-triage-fix") as { version: number };
    expect(after.version).toBe(before.version);
  });
});
