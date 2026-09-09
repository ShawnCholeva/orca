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

/**
 * Every worker pane is created at this fixed size and never resized: the
 * orchestrator's busy/idle detection reads the pane as text, and a narrower pane
 * wraps the status line its BUSY pattern matches on. Viewers must therefore
 * render AT this geometry rather than reshape it — a viewer with a different
 * column count puts every cursor-addressed redraw in the wrong place.
 */
export const WORKER_PANE_COLS = 220;
export const WORKER_PANE_ROWS = 50;

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
  const res = await r.run([
    "new-session", "-d", "-s", name,
    "-x", String(WORKER_PANE_COLS), "-y", String(WORKER_PANE_ROWS),
    ...envArgs, "-c", cwd, command,
  ]);
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

/**
 * Writes raw terminal bytes to a pane, as a tty would deliver them. `-H` takes
 * hex byte values, so control characters and escape sequences (Enter, arrows,
 * Ctrl-C) survive intact — unlike `-l`, which is text-only. This is how a human
 * at the embedded terminal reaches a tmux-backed agent, which has no pty handle
 * in the daemon to write to.
 */
export async function sendRawBytes(r: TmuxRunner, name: string, bytes: Buffer): Promise<boolean> {
  if (bytes.length === 0) return true;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  const res = await r.run(["send-keys", "-t", name, "-H", ...hex]);
  return res.code === 0;
}

/**
 * Streams everything the pane draws into a file, which the daemon then tails.
 *
 * Deliberately NOT `pipe-pane -o`: that flag TOGGLES. It opens a pipe only when
 * none is open and closes the one that is — so calling it twice leaves the pane
 * unpiped. The tmux server outlives the daemon, so a worker's pipe is still open
 * across a daemon restart, and reattach's call was silently switching capture OFF
 * for that worker. Every other daemon restart therefore blinded the whole system
 * to what its agents were doing. Plain `pipe-pane` replaces whatever is there and
 * is safe to call as often as we like.
 */
export async function pipePaneToFile(r: TmuxRunner, name: string, filePath: string): Promise<void> {
  await r.run(["pipe-pane", "-t", name, `cat >> ${JSON.stringify(filePath)}`]);
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
