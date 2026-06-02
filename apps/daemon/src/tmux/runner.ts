import { execFile } from "node:child_process";

export interface TmuxRunner {
  run(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

export function defaultTmuxRunner(): TmuxRunner {
  return {
    run: (args, input) =>
      new Promise((resolve) => {
        const cp = execFile("tmux", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code : (err ? 1 : 0);
          resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
        });
        if (input !== undefined) { try { cp.stdin?.end(input); } catch { /* ignore */ } }
      }),
  };
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
  await r.run(["kill-session", "-t", name]); // idempotent
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

export async function killSession(r: TmuxRunner, name: string): Promise<void> {
  await r.run(["kill-session", "-t", name]);
}

export async function hasSession(r: TmuxRunner, name: string): Promise<boolean> {
  return (await r.run(["has-session", "-t", name])).code === 0;
}

export async function listOrcaSessions(r: TmuxRunner, prefix: string): Promise<string[]> {
  const out = await r.run(["list-sessions", "-F", "#{session_name}"]);
  if (out.code !== 0) return [];
  return out.stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(prefix));
}
