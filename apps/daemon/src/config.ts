import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const DEFAULT_PORT = 8787;

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
  ORCA_TOKEN: z.string().min(1).optional()
});

const PortSchema = z.coerce.number().int().min(1).max(65535);

export interface Config {
  dataDir: string;
  port: number;
  logLevel: z.infer<typeof LogLevelSchema>;
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

  return {
    dataDir,
    port,
    logLevel,
    getAuthToken: () => authToken
  };
}
