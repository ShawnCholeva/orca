import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectWorkspace } from "./inspect.js";
import { WorkspaceInspectionError } from "./errors.js";

const execFile = promisify(execFileCb);

const tempDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-m3-inspect-"));
  tempDirs.push(dir);
  return dir;
}

async function initGitRepo(dir: string): Promise<void> {
  await execFile("git", ["init", dir]);
  await execFile("git", ["-C", dir, "config", "user.name", "Test User"]);
  await execFile("git", ["-C", dir, "config", "user.email", "test@example.com"]);
}

async function makeInitialCommit(dir: string): Promise<string> {
  await fs.writeFile(path.join(dir, "README.md"), "# Test Repo");
  await execFile("git", ["-C", dir, "add", "."]);
  await execFile("git", ["-C", dir, "commit", "-m", "Initial commit"]);
  const { stdout } = await execFile("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("inspectWorkspace", () => {
  it("rejects a relative path with invalid_input", async () => {
    const err = await inspectWorkspace("relative/path").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceInspectionError);
    expect(err.code).toBe("invalid_input");
  });

  it("rejects an empty string with invalid_input", async () => {
    const err = await inspectWorkspace("").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceInspectionError);
    expect(err.code).toBe("invalid_input");
  });

  it("returns not_found for a missing path", async () => {
    const err = await inspectWorkspace(`/tmp/orca-nonexistent-${Date.now()}`).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceInspectionError);
    expect(err.code).toBe("not_found");
  });

  it("returns not_a_directory for a file path", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "somefile.txt");
    await fs.writeFile(file, "hello");
    const err = await inspectWorkspace(file).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceInspectionError);
    expect(err.code).toBe("not_a_directory");
  });

  it("returns not_readable for an unreadable directory", async () => {
    // chmod semantics are unreliable on Windows
    if (process.platform === "win32") return;

    const dir = await makeTmpDir();
    const unreadable = path.join(dir, "noaccess");
    await fs.mkdir(unreadable);
    await fs.chmod(unreadable, 0o000);
    try {
      const err = await inspectWorkspace(unreadable).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceInspectionError);
      expect(err.code).toBe("not_readable");
    } finally {
      // Restore so afterEach cleanup can delete the directory
      await fs.chmod(unreadable, 0o755);
    }
  });

  it("returns workspaceType: folder and gitProbe: not_a_repo for a plain directory", async () => {
    const dir = await makeTmpDir();
    const result = await inspectWorkspace(dir);
    expect(result.workspaceType).toBe("folder");
    expect(result.gitProbe).toBe("not_a_repo");
    expect(result.branch).toBeNull();
    expect(result.isDirty).toBeNull();
    expect(result.name).toBe(path.basename(dir));
    expect(result.path).toBe(dir);
  });

  it("returns repo metadata for a clean git repo with an initial commit", async () => {
    const dir = await makeTmpDir();
    await initGitRepo(dir);
    const expectedBranch = await makeInitialCommit(dir);

    const result = await inspectWorkspace(dir);
    expect(result.workspaceType).toBe("repo");
    expect(result.gitProbe).toBe("ok");
    expect(result.branch).toBe(expectedBranch);
    expect(result.isDirty).toBe(false);
  });

  it("detects a dirty working tree", async () => {
    const dir = await makeTmpDir();
    await initGitRepo(dir);
    await makeInitialCommit(dir);
    await fs.writeFile(path.join(dir, "untracked.txt"), "dirt");

    const result = await inspectWorkspace(dir);
    expect(result.workspaceType).toBe("repo");
    expect(result.isDirty).toBe(true);
    expect(result.gitProbe).toBe("ok");
  });

  it("handles unborn HEAD (git init with no commits)", async () => {
    const dir = await makeTmpDir();
    await initGitRepo(dir);
    // No commits — HEAD is unborn; rev-parse exits non-zero

    const result = await inspectWorkspace(dir);
    expect(result.workspaceType).toBe("repo");
    expect(result.gitProbe).toBe("errored");
    expect(result.branch).toBeNull();
    expect(result.isDirty).toBeNull();
  });

  it("handles detached HEAD", async () => {
    const dir = await makeTmpDir();
    await initGitRepo(dir);
    await makeInitialCommit(dir);
    const { stdout } = await execFile("git", ["-C", dir, "rev-parse", "HEAD"]);
    const sha = stdout.trim();
    await execFile("git", ["-C", dir, "checkout", "--detach", sha]);

    const result = await inspectWorkspace(dir);
    expect(result.workspaceType).toBe("repo");
    expect(result.gitProbe).toBe("errored");
    expect(result.branch).toBeNull();
    expect(result.isDirty).toBeNull();
  });

  it("returns gitProbe: unavailable when git binary is absent from PATH", async () => {
    const dir = await makeTmpDir();
    await initGitRepo(dir);
    await makeInitialCommit(dir);

    const emptyBinDir = await makeTmpDir();
    const savedPath = process.env["PATH"];
    process.env["PATH"] = emptyBinDir;
    try {
      const result = await inspectWorkspace(dir);
      expect(result.gitProbe).toBe("unavailable");
      expect(result.workspaceType).toBe("repo");
      expect(result.branch).toBeNull();
      expect(result.isDirty).toBeNull();
    } finally {
      process.env["PATH"] = savedPath;
    }
  });

  it(
    "throws inspection_timeout when git hangs beyond the 5 s deadline",
    { timeout: 15_000 },
    async () => {
      // Simulating a hung git binary is POSIX-specific (trap '' TERM)
      if (process.platform === "win32") return;

      const repoDir = await makeTmpDir();
      await initGitRepo(repoDir);
      await makeInitialCommit(repoDir);

      // A fake git that ignores SIGTERM and sleeps indefinitely
      const fakeBinDir = await makeTmpDir();
      const fakeGit = path.join(fakeBinDir, "git");
      await fs.writeFile(fakeGit, "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
      await fs.chmod(fakeGit, 0o755);

      const savedPath = process.env["PATH"];
      process.env["PATH"] = `${fakeBinDir}:${savedPath}`;
      try {
        const err = await inspectWorkspace(repoDir).catch((e) => e);
        expect(err).toBeInstanceOf(WorkspaceInspectionError);
        expect(err.code).toBe("inspection_timeout");
      } finally {
        process.env["PATH"] = savedPath;
      }
    },
  );
});
