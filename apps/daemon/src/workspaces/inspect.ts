import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import type { InspectWorkspacePreview } from "@orca/contracts";
import {
  invalidInput,
  notFound,
  notADirectory,
  notReadable,
  inspectionTimeout,
} from "./errors.js";

const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER = 1_048_576; // 1 MB
const INSPECTION_TIMEOUT_MS = 5000;

type GitMeta = {
  branch: string | null;
  isDirty: boolean | null;
  gitProbe: "ok" | "unavailable" | "errored";
};

function runGitCommand(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" as const },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

async function probeGit(canonical: string): Promise<GitMeta> {
  let branchRaw: string;
  try {
    branchRaw = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], canonical);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { branch: null, isDirty: null, gitProbe: "unavailable" };
    }
    return { branch: null, isDirty: null, gitProbe: "errored" };
  }

  const branch = branchRaw.trim();

  // Detached HEAD reports the literal string "HEAD"
  if (branch === "HEAD") {
    return { branch: null, isDirty: null, gitProbe: "errored" };
  }

  try {
    const statusOut = await runGitCommand(["status", "--porcelain"], canonical);
    return { branch, isDirty: statusOut.length > 0, gitProbe: "ok" };
  } catch {
    return { branch: null, isDirty: null, gitProbe: "errored" };
  }
}

async function doInspect(inputPath: string): Promise<InspectWorkspacePreview> {
  let canonical: string;
  try {
    canonical = await fs.realpath(inputPath);
  } catch {
    throw notFound(inputPath);
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(canonical);
  } catch {
    throw notFound(canonical);
  }

  if (!stat.isDirectory()) {
    throw notADirectory(canonical);
  }

  try {
    await fs.access(canonical, fs.constants.R_OK);
  } catch {
    throw notReadable(canonical);
  }

  let isRepo: boolean;
  try {
    await fs.stat(path.join(canonical, ".git"));
    isRepo = true;
  } catch {
    isRepo = false;
  }

  const name = path.basename(canonical);

  if (!isRepo) {
    return {
      path: canonical,
      name,
      workspaceType: "folder" as const,
      branch: null,
      isDirty: null,
      gitProbe: "not_a_repo" as const,
    };
  }

  const gitMeta = await probeGit(canonical);
  return {
    path: canonical,
    name,
    workspaceType: "repo" as const,
    ...gitMeta,
  };
}

export async function inspectWorkspace(inputPath: string): Promise<InspectWorkspacePreview> {
  if (!inputPath || inputPath.length > 1024 || !path.isAbsolute(inputPath)) {
    throw invalidInput(
      !inputPath
        ? "inputPath must be a non-empty string"
        : inputPath.length > 1024
          ? "inputPath must not exceed 1024 characters"
          : "inputPath must be an absolute path",
    );
  }

  let tid: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    tid = setTimeout(() => reject(inspectionTimeout(inputPath)), INSPECTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([doInspect(inputPath), timeoutPromise]);
  } finally {
    clearTimeout(tid!);
  }
}
