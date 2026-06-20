import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const DEFAULT_PORT = 8787;
const DEFAULT_SESSION_OUTPUT_TAIL_BYTES = 1024 * 1024;
const DEFAULT_SESSION_STOP_GRACE_MS = 5000;
const DEFAULT_SESSION_WS_BUFFER_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MEMORY_EXTRACTION_MAX_INPUT_BYTES = 131072;
const DEFAULT_MEMORY_EXTRACTION_TIMEOUT_MS = 15000;

const LogLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent"
]);

const EnvSchema = z.object({
  ORCA_DATA_DIR: z.string().min(1).optional(),
  ORCA_PORT: z.string().optional(),
  ORCA_LOG_LEVEL: LogLevelSchema.optional(),
  ORCA_TOKEN: z.string().min(1).optional(),
  ORCA_SESSION_OUTPUT_TAIL_BYTES: z.string().optional(),
  ORCA_SESSION_STOP_GRACE_MS: z.string().optional(),
  ORCA_SESSION_WS_BUFFER_LIMIT_BYTES: z.string().optional(),
  ORCA_MEMORY_EXTRACTION_MAX_INPUT_BYTES: z.string().optional(),
  ORCA_MEMORY_EXTRACTION_TIMEOUT_MS: z.string().optional()
});

const PortSchema = z.coerce.number().int().min(1).max(65535);
const SessionOutputTailBytesSchema = z.coerce.number().int().positive();
const SessionStopGraceMsSchema = z.coerce.number().int().positive();
const SessionWsBufferLimitBytesSchema = z.coerce.number().int().positive();
const MemoryExtractionMaxInputBytesSchema = z.coerce.number().int().positive();
const MemoryExtractionTimeoutMsSchema = z.coerce.number().int().positive();

export interface Config {
  dataDir: string;
  port: number;
  logLevel: z.infer<typeof LogLevelSchema>;
  sessionOutputTailBytes: number;
  sessionStopGraceMs: number;
  sessionWsBufferLimitBytes: number;
  memoryExtractionMaxInputBytes: number;
  memoryExtractionTimeoutMs: number;
  hookResolverCommand: string[];
  getAuthToken: () => string;
}

function resolveDefaultDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const baseDir =
      appData && appData.length > 0
        ? appData
        : path.join(os.homedir(), "AppData", "Roaming");

    return path.join(baseDir, "Orca");
  }

  return path.join(os.homedir(), ".orca");
}

export function loadConfig(): Config {
  const env = EnvSchema.parse(process.env);

  const dataDir = env.ORCA_DATA_DIR ?? resolveDefaultDataDir();
  mkdirSync(dataDir, { recursive: true });

  const port =
    env.ORCA_PORT === undefined ? DEFAULT_PORT : PortSchema.parse(env.ORCA_PORT);

  const authToken = env.ORCA_TOKEN ?? randomUUID();
  const logLevel = env.ORCA_LOG_LEVEL ?? "info";
  const sessionOutputTailBytes =
    env.ORCA_SESSION_OUTPUT_TAIL_BYTES === undefined
      ? DEFAULT_SESSION_OUTPUT_TAIL_BYTES
      : SessionOutputTailBytesSchema.parse(env.ORCA_SESSION_OUTPUT_TAIL_BYTES);

  const sessionStopGraceMs =
    env.ORCA_SESSION_STOP_GRACE_MS === undefined
      ? DEFAULT_SESSION_STOP_GRACE_MS
      : SessionStopGraceMsSchema.parse(env.ORCA_SESSION_STOP_GRACE_MS);

  const sessionWsBufferLimitBytes =
    env.ORCA_SESSION_WS_BUFFER_LIMIT_BYTES === undefined
      ? DEFAULT_SESSION_WS_BUFFER_LIMIT_BYTES
      : SessionWsBufferLimitBytesSchema.parse(env.ORCA_SESSION_WS_BUFFER_LIMIT_BYTES);

  const memoryExtractionMaxInputBytes =
    env.ORCA_MEMORY_EXTRACTION_MAX_INPUT_BYTES === undefined
      ? DEFAULT_MEMORY_EXTRACTION_MAX_INPUT_BYTES
      : MemoryExtractionMaxInputBytesSchema.parse(env.ORCA_MEMORY_EXTRACTION_MAX_INPUT_BYTES);

  const memoryExtractionTimeoutMs =
    env.ORCA_MEMORY_EXTRACTION_TIMEOUT_MS === undefined
      ? DEFAULT_MEMORY_EXTRACTION_TIMEOUT_MS
      : MemoryExtractionTimeoutMsSchema.parse(env.ORCA_MEMORY_EXTRACTION_TIMEOUT_MS);

  const sidecarBin = process.env.ORCA_SIDECAR_BIN?.trim();
  const hookResolverCommand =
    sidecarBin && sidecarBin.length > 0
      ? [sidecarBin]
      : [process.execPath, process.argv[1] ?? ""];

  return {
    dataDir,
    port,
    logLevel,
    sessionOutputTailBytes,
    sessionStopGraceMs,
    sessionWsBufferLimitBytes,
    memoryExtractionMaxInputBytes,
    memoryExtractionTimeoutMs,
    hookResolverCommand,
    getAuthToken: () => authToken
  };
}
