import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiAdapter } from "./gemini.js";
import type { RunCheckFn } from "./gemini.js";

const ok = (p: string) => () => Promise.resolve({ resolvedPath: p });
const missing = () => Promise.resolve({ error: "not_found" as const, tried: ["gemini"] });

describe("GeminiAdapter.checkInstalled", () => {
  it("returns ok + version on exit 0", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "gemini 0.5.0", stderr: "", durationMs: 1, timedOut: false });
    const step = await new GeminiAdapter(ok("/usr/bin/gemini"), run, () => ({}), () => false).checkInstalled();
    expect(step.ok).toBe(true);
    expect(step.version).toBe("0.5.0");
  });

  it("returns missing on ENOENT", async () => {
    const step = await new GeminiAdapter(missing, vi.fn(), () => ({}), () => false).checkInstalled();
    expect(step.ok).toBe(false);
  });
});

describe("GeminiAdapter.checkAuth modes", () => {
  it("GEMINI_API_KEY → ready (gemini_api_key)", async () => {
    const env = () => ({ GEMINI_API_KEY: "secret" });
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), env, () => false);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toContain("gemini_api_key");
  });

  it("GOOGLE_API_KEY + GOOGLE_GENAI_USE_VERTEXAI=true → ready (vertex_api_key)", async () => {
    const env = () => ({ GOOGLE_API_KEY: "AIza-redacted", GOOGLE_GENAI_USE_VERTEXAI: "true" });
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), env, () => false);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toContain("vertex_api_key");
  });

  it("GOOGLE_CLOUD_PROJECT + LOCATION + ADC file → ready (vertex_adc)", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "g-adc-"));
    const cred = path.join(tmp, "adc.json");
    writeFileSync(cred, "{}");
    const env = () => ({
      GOOGLE_CLOUD_PROJECT: "proj",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_APPLICATION_CREDENTIALS: cred,
    });
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), env, (p) => p === cred);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("ready");
    expect(step.detail).toContain("vertex_adc");
  });

  it("no env, no settings file → needs_auth", async () => {
    const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), () => ({}), () => false);
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("needs_auth");
  });

  it("settings.json says vertex-ai but no credentials → misconfigured", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "g-settings-"));
    mkdirSync(path.join(tmp, ".gemini"));
    const settings = path.join(tmp, ".gemini", "settings.json");
    writeFileSync(settings, JSON.stringify({ selectedAuthType: "vertex-ai" }));
    const env = () => ({ HOME: tmp });
    const a = new GeminiAdapter(
      ok("/usr/bin/gemini"),
      vi.fn(),
      env,
      (p) => p === settings,
      (p) => (p === settings ? JSON.stringify({ selectedAuthType: "vertex-ai" }) : ""),
    );
    const step = await a.checkAuth();
    expect(step.authStatus).toBe("misconfigured");
  });
});

describe("GeminiAdapter.repairFor", () => {
  const a = new GeminiAdapter(ok("/usr/bin/gemini"), vi.fn(), () => ({}), () => false);
  it("needs_auth includes requiresAppRestart for env-based fixes", () => {
    expect(a.repairFor("needs_auth")).toMatchObject({ requiresAppRestart: true });
  });
});
