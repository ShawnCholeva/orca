import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../migrations.js";
import { seedAdapterExecutionModes } from "./execution-modes.js";
import { registerAdapterExecutionModeRoutes } from "./execution-modes-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function newApp() {
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  const supported: Record<string, ("shadow_session" | "one_shot")[]> = {
    "claude-code": ["shadow_session", "one_shot"],
    codex: ["one_shot", "shadow_session"],
  };
  seedAdapterExecutionModes(db, () => "2026-05-28T00:00:00.000Z", supported);
  const app = Fastify();
  registerAdapterExecutionModeRoutes(app, {
    db,
    now: () => "2026-05-28T01:00:00.000Z",
    supportedByAdapter: supported,
  });
  return app;
}

describe("adapter execution-modes routes", () => {
  it("GET /v1/adapters/execution-modes returns all configs", async () => {
    const app = newApp();
    const res = await app.inject({ method: "GET", url: "/v1/adapters/execution-modes" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { configs: Array<{ adapterId: string }> };
    expect(body.configs.map((c) => c.adapterId)).toEqual(
      expect.arrayContaining(["claude-code", "codex"])
    );
  });

  it("PUT /v1/adapters/:id/execution-modes updates config", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/adapters/codex/execution-modes",
      payload: {
        adapterId: "codex",
        enabledExecutionModes: [
          { mode: "shadow_session", preferred: true },
          { mode: "one_shot" },
        ],
        disabledExecutionModes: [],
      },
    });
    expect(res.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/v1/adapters/execution-modes" });
    const body = get.json() as { configs: Array<{ adapterId: string; enabledExecutionModes: Array<{ mode: string; preferred?: boolean }> }> };
    const codex = body.configs.find((c) => c.adapterId === "codex")!;
    expect(codex.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");
  });

  it("PUT with invalid invariants returns 400", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/adapters/claude-code/execution-modes",
      payload: {
        adapterId: "claude-code",
        enabledExecutionModes: [{ mode: "shadow_session" }], // no preferred
        disabledExecutionModes: [{ mode: "one_shot", reason: "x" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT mismatched adapterId in body vs URL returns 400", async () => {
    const app = newApp();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/adapters/codex/execution-modes",
      payload: {
        adapterId: "claude-code",
        enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
        disabledExecutionModes: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
