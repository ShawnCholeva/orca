import { execFile } from "node:child_process";
import { join } from "node:path";

export interface TmuxRunner {
  run(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

/**
 * Each daemon runs its sessions on its own tmux server, at a socket beside its
 * database. The owner tag below stops the reaper from killing another daemon's
 * workers; the socket stops any daemon from seeing them. A test that boots
 * `startDaemon()` against a temp dir gets an empty server of its own, and the
 * developer's live workers are not reachable from it by any code path, tagged
 * or not. Inspect a daemon's sessions with `tmux -S <dataDir>/tmux.sock ls`.
 */
export function tmuxSocketPath(dataDir: string): string {
  return join(dataDir, "tmux.sock");
}

export function defaultTmuxRunner(socketPath: string): TmuxRunner {
  return {
    run: (args, input) =>
      new Promise((resolve) => {
        const cp = execFile("tmux", ["-S", socketPath, ...args], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code : (err ? 1 : 0);
          resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
        });
        if (input !== undefined) { try { cp.stdin?.end(input); } catch { /* ignore */ } }
      }),
  };
}

/**
 * Every session a daemon creates carries the data dir that owns it, in the
 * tmux session environment. Before each daemon had its own socket, tmux was
 * shared by every daemon on the machine — the real one, a second data dir, a
 * test that boots `startDaemon()` against a temp dir — and the boot reaper
 * killed what it did not recognise. Without an owner it recognised nothing that
 * was not in its own database, so a test run killed every live worker on the
 * developer's tmux server, twice per suite. The tag stays as the reaper's
 * second check: a session on this socket that is not ours is still left alone.
 */
export const TMUX_OWNER_VAR = "ORCA_OWNER";

/** The owner tag a session was created with, or null when untagged / gone. */
export async function sessionOwner(r: TmuxRunner, name: string): Promise<string | null> {
  const res = await r.run(["show-environment", "-t", name, TMUX_OWNER_VAR]);
  if (res.code !== 0) return null;
  const line = res.stdout.trim();
  if (!line.startsWith(`${TMUX_OWNER_VAR}=`)) return null;
  return line.slice(TMUX_OWNER_VAR.length + 1);
}

export async function newSession(
  r: TmuxRunner,
  name: string,
  cwd: string,
  command: string,
  env: Record<string, string> = {}
): Promise<{ code: number }> {
  // tmux 3.0+: -e KEY=VAL sets the spawned process env without leaking into the server.
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // Idempotent — but a name that was still live is a fact worth a line: it means
  // a session was replaced under a reused name, which is one of the few ways an
  // agent dies with no signal.
  const replaced = await r.run(["kill-session", "-t", name]);
  if (replaced.code === 0) console.warn(`[tmux] new-session replaced a live session ${name}`);
  const res = await r.run(["new-session", "-d", "-s", name, "-x", "220", "-y", "50", ...envArgs, "-c", cwd, command]);
  return { code: res.code };
}

export async function capturePane(r: TmuxRunner, name: string): Promise<string> {
  return (await r.run(["capture-pane", "-t", name, "-p"])).stdout;
}

export async function paste(r: TmuxRunner, name: string, buf: string, text: string): Promise<void> {
  await r.run(["load-buffer", "-b", buf, "-"], text);
  await r.run(["paste-buffer", "-b", buf, "-t", name, "-d", "-p"]);
}

export async function sendEnter(r: TmuxRunner, name: string): Promise<void> {
  await r.run(["send-keys", "-t", name, "Enter"]);
}

export async function sendKey(r: TmuxRunner, name: string, key: string): Promise<void> {
  await r.run(["send-keys", "-t", name, key]);
}

export async function pipePaneToFile(r: TmuxRunner, name: string, filePath: string): Promise<void> {
  await r.run(["pipe-pane", "-o", "-t", name, `cat >> ${JSON.stringify(filePath)}`]);
}

/**
 * `reason` names the caller. Every worker death without an exit signal has had
 * to be reconstructed from timestamps; a kill that actually removed a live
 * session (exit 0) now says who asked for it.
 */
export async function killSession(r: TmuxRunner, name: string, reason = "unspecified"): Promise<void> {
  const res = await r.run(["kill-session", "-t", name]);
  if (res.code === 0) console.log(`[tmux] killed ${name} (${reason})`);
}

export async function hasSession(r: TmuxRunner, name: string): Promise<boolean> {
  return (await r.run(["has-session", "-t", name])).code === 0;
}

// Every live tmux session name. Empty when tmux has no running server/sessions
// (a nonzero exit), so callers never treat "no server" as an error.
export async function listSessions(r: TmuxRunner): Promise<string[]> {
  const res = await r.run(["list-sessions", "-F", "#{session_name}"]);
  if (res.code !== 0) return [];
  return res.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}
