import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig } from "./config.js";

const UuidSchema = z.string().uuid();

const ORCA_ENV_KEYS = [
  "ORCA_DATA_DIR",
  "ORCA_PORT",
  "ORCA_LOG_LEVEL",
  "ORCA_TOKEN",
  "ORCA_SESSION_OUTPUT_TAIL_BYTES",
  "ORCA_SESSION_WS_BUFFER_LIMIT_BYTES"
] as const;

const createdDirs: string[] = [];

function setOrcaEnv(overrides: Partial<Record<(typeof ORCA_ENV_KEYS)[number], string>>): void {
  for (const key of ORCA_ENV_KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const key of ORCA_ENV_KEYS) {
    delete process.env[key];
  }

  for (const dirPath of createdDirs.splice(0)) {
    rmSync(dirPath, { recursive: true, force: true });
  }
});

it("exposes a non-empty hookResolverCommand", () => {
  const cfg = loadConfig();
  expect(Array.isArray(cfg.hookResolverCommand)).toBe(true);
  expect(cfg.hookResolverCommand.length).toBeGreaterThan(0);
});

it("hookResolverCommand re-invokes the daemon exactly as launched (carries execArgv loader flags)", () => {
  // Regression: dropping process.execArgv made the baked hook command
  // `node src/index.ts ...`, which under tsx (dev) fails with ERR_MODULE_NOT_FOUND
  // because plain node can't resolve the `.js`-specified TS imports. The resolver
  // must re-invoke with the same loader flags the daemon itself was started with.
  const prev = process.env.ORCA_SIDECAR_BIN;
  delete process.env.ORCA_SIDECAR_BIN;
  try {
    const cfg = loadConfig();
    expect(cfg.hookResolverCommand).toEqual([
      process.execPath,
      ...process.execArgv,
      process.argv[1] ?? "",
    ]);
  } finally {
    if (prev === undefined) delete process.env.ORCA_SIDECAR_BIN;
    else process.env.ORCA_SIDECAR_BIN = prev;
  }
});

it("hookResolverCommand uses ORCA_SIDECAR_BIN verbatim when set (prod SEA)", () => {
  const prev = process.env.ORCA_SIDECAR_BIN;
  process.env.ORCA_SIDECAR_BIN = "/opt/orca/orca-daemon";
  try {
    expect(loadConfig().hookResolverCommand).toEqual(["/opt/orca/orca-daemon"]);
  } finally {
    if (prev === undefined) delete process.env.ORCA_SIDECAR_BIN;
    else process.env.ORCA_SIDECAR_BIN = prev;
  }
});

describe("loadConfig", () => {
  it("uses ORCA_DATA_DIR override and ensures the directory exists", () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "orca-config-test-"));
    rmSync(dataDir, { recursive: true, force: true });
    createdDirs.push(dataDir);

    setOrcaEnv({ ORCA_DATA_DIR: dataDir });

    const config = loadConfig();

    expect(config.dataDir).toBe(dataDir);
    expect(existsSync(dataDir)).toBe(true);
  });

  it("generates UUID token when unset and preserves explicit ORCA_TOKEN", () => {
    setOrcaEnv({});
    const configWithGeneratedToken = loadConfig();

    expect(UuidSchema.safeParse(configWithGeneratedToken.getAuthToken()).success).toBe(
      true
    );

    setOrcaEnv({ ORCA_TOKEN: "local-dev-token" });
    const configWithEnvToken = loadConfig();

    expect(configWithEnvToken.getAuthToken()).toBe("local-dev-token");
  });

  it("uses a default session output tail cap and supports ORCA_SESSION_OUTPUT_TAIL_BYTES override", () => {
    setOrcaEnv({});
    const configDefault = loadConfig();
    expect(configDefault.sessionOutputTailBytes).toBe(1024 * 1024);

    setOrcaEnv({ ORCA_SESSION_OUTPUT_TAIL_BYTES: "64" });
    const configOverride = loadConfig();
    expect(configOverride.sessionOutputTailBytes).toBe(64);
  });

  it("uses a default WS buffer limit and supports ORCA_SESSION_WS_BUFFER_LIMIT_BYTES override", () => {
    setOrcaEnv({});
    const configDefault = loadConfig();
    expect(configDefault.sessionWsBufferLimitBytes).toBe(1024 * 1024);

    setOrcaEnv({ ORCA_SESSION_WS_BUFFER_LIMIT_BYTES: "512" });
    const configOverride = loadConfig();
    expect(configOverride.sessionWsBufferLimitBytes).toBe(512);
  });
});
