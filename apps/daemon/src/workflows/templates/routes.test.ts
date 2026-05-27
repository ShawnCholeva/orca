import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  GetWorkflowTemplateResponse,
  ListWorkflowTemplatesResponse,
  WorkflowTemplateResponse,
} from "@orca/contracts";
import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { bootstrapRegistries } from "../../registry/bootstrap.js";
import { createServer } from "../../server.js";

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
const NOW = "2026-01-01T00:00:00.000Z";

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => "test-token",
  };
}

beforeAll(() => {
  bootstrapRegistries();
});

function seedTemplate(db: Database.Database, row: { id: string; name: string; isBuiltIn: boolean; isLocked: boolean }): void {
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    row.id,
    row.name,
    "desc",
    1,
    row.isBuiltIn ? 1 : 0,
    row.isLocked ? 1 : 0,
    JSON.stringify([
      {
        id: "step-1",
        ordinal: 0,
        name: "Step 1",
        instructions: "Produce the goal brief.",
        outputSchema: [{ key: "goal_brief", type: "string", required: true }],
      },
    ]),
    JSON.stringify([]),
    NOW,
    NOW
  );
}

describe("workflow template routes", () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-template-routes-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("create -> list -> get -> update -> duplicate flow works", async () => {
    const createdResp = await server.inject({
      method: "POST",
      url: "/v1/workflow-templates",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        name: "My Template",
        description: "desc",
        steps: [
          {
            id: "intake",
            name: "Intake",
            instructions: "Ask the user for input and capture a goal brief.",
            outputSchema: [{ key: "goal_brief", type: "string", required: true }],
          },
        ],
        guardrails: [],
      },
    });
    expect(createdResp.statusCode).toBe(201);
    const created = WorkflowTemplateResponse.parse(JSON.parse(createdResp.body));
    expect(created.template.version).toBe(1);

    const listResp = await server.inject({
      method: "GET",
      url: "/v1/workflow-templates",
      headers: AUTH_HEADERS,
    });
    expect(listResp.statusCode).toBe(200);
    const listed = ListWorkflowTemplatesResponse.parse(JSON.parse(listResp.body));
    expect(listed.templates.some((t) => t.id === created.template.id)).toBe(true);

    const getResp = await server.inject({
      method: "GET",
      url: `/v1/workflow-templates/${encodeURIComponent(created.template.id)}`,
      headers: AUTH_HEADERS,
    });
    expect(getResp.statusCode).toBe(200);
    const fetched = GetWorkflowTemplateResponse.parse(JSON.parse(getResp.body));
    expect(fetched.template.id).toBe(created.template.id);

    const patchResp = await server.inject({
      method: "PATCH",
      url: `/v1/workflow-templates/${encodeURIComponent(created.template.id)}`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        name: "My Template v2",
        description: "desc2",
        steps: [
          {
            id: "intake",
            ordinal: 2,
            name: "Intake",
            instructions: "Ask the user for input and capture a goal brief.",
            outputSchema: [{ key: "goal_brief", type: "string", required: true }],
          },
        ],
        guardrails: [],
      },
    });
    expect(patchResp.statusCode).toBe(200);
    const updated = WorkflowTemplateResponse.parse(JSON.parse(patchResp.body));
    expect(updated.template.version).toBe(2);
    expect(updated.template.steps[0]?.ordinal).toBe(2);

    const duplicateResp = await server.inject({
      method: "POST",
      url: `/v1/workflow-templates/${encodeURIComponent(created.template.id)}/duplicate`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { sourceTemplateId: created.template.id, name: "My Copy" },
    });
    expect(duplicateResp.statusCode).toBe(201);
    const duplicated = WorkflowTemplateResponse.parse(JSON.parse(duplicateResp.body));
    expect(duplicated.template.id).not.toBe(created.template.id);
    expect(duplicated.template.version).toBe(1);
    expect(duplicated.template.isLocked).toBe(false);
  });

  it("updating built-in template returns 409", async () => {
    seedTemplate(db, { id: "orca/engineering", name: "Engineering", isBuiltIn: true, isLocked: true });

    const response = await server.inject({
      method: "PATCH",
      url: "/v1/workflow-templates/orca%2Fengineering",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        name: "Nope",
        description: "nope",
        steps: [
          {
            id: "intake",
            name: "Intake",
            instructions: "Ask the user for input and capture a goal brief.",
            outputSchema: [{ key: "goal_brief", type: "string", required: true }],
          },
        ],
        guardrails: [],
      },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe("workflow_template_locked");
  });
});
