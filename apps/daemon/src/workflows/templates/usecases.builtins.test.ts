import { describe, expect, it, beforeEach } from "vitest";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";
import { EventBus } from "../../events.js";
import {
  installBuiltInTemplates,
  reconcileBuiltInTemplates,
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
    const templates = installBuiltInTemplates(ctx(), ["orca/brainstorm", "orca/code-review"]);
    expect(templates.map((t) => t.id).sort()).toEqual(["orca/brainstorm", "orca/code-review"]);
    expect(templates.every((t) => t.isBuiltIn && t.isLocked)).toBe(true);
    const count = db.prepare("SELECT COUNT(*) c FROM workflow_templates").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("is idempotent — re-installing the same id does not duplicate", () => {
    installBuiltInTemplates(ctx(), ["orca/brainstorm"]);
    installBuiltInTemplates(ctx(), ["orca/brainstorm"]);
    const count = db.prepare("SELECT COUNT(*) c FROM workflow_templates WHERE id = ?").get("orca/brainstorm") as { c: number };
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
    installBuiltInTemplates(ctx(), ["orca/brainstorm"]);
    reconcileBuiltInTemplates(db);
    const row = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get("orca/brainstorm");
    expect(row).toBeTruthy();
  });
});
