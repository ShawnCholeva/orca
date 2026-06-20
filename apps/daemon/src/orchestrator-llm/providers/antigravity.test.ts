import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { AntigravityShadowProvider } from "./antigravity.js";

type HookRequest = {
  url: string;
  body: { last_assistant_message?: string };
};

describe("AntigravityShadowProvider", () => {
  it("launches agy or override", () => {
    const provider = new AntigravityShadowProvider();
    expect(provider.launch({}).bin).toBe("agy");
    expect(provider.launch({ binOverride: "/bin/agy" }).bin).toBe("/bin/agy");
  });

  it("uses hook capture", () => {
    const provider = new AntigravityShadowProvider();
    expect(provider.captureMode()).toEqual({ kind: "hook" });
  });

  it("writes hooks.json and relay script under .agents", () => {
    const provider = new AntigravityShadowProvider();
    const cfg = provider.hookConfig({ goalId: "g1", resolverCommand: [process.execPath, "test-daemon.js"] });
    expect(cfg.files.map((f) => f.relPath).sort()).toEqual([
      ".agents/hooks.json",
      ".agents/orca-stop-hook.cjs",
    ]);
    const hooks = JSON.parse(cfg.files.find((f) => f.relPath === ".agents/hooks.json")!.contents);
    expect(hooks["orca-shadow-stop"].Stop[0].command).toBe("node .agents/orca-stop-hook.cjs");
    expect(cfg.files.find((f) => f.relPath === ".agents/orca-stop-hook.cjs")!.contents).toContain("transcriptPath");
  });

  it("parses orca action blocks", () => {
    const provider = new AntigravityShadowProvider();
    const parsed = provider.turnParser().parseAction('done\n<orca:action>{"kind":"wait"}</orca:action>');
    expect(parsed).toBe('{"kind":"wait"}');
  });

  it("relay posts the latest assistant or model transcript message", async () => {
    await withHookServer(async ({ port, requests }) => {
      const cwd = await writeRelay({ port });
      const transcriptPath = join(cwd, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ role: "assistant", message: "older assistant" }),
          JSON.stringify({ type: "model", content: [{ text: "latest model" }] }),
          JSON.stringify({ role: "user", message: "later user" }),
          JSON.stringify({ kind: "tool", text: "later tool" }),
          JSON.stringify({ source: "system", content: "later system" }),
          JSON.stringify({ text: "not assistant" }),
        ].join("\n"),
      );

      await runRelay(cwd, { transcriptPath });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("/v1/shadow-hooks/stop?goalId=g1");
      expect(requests[0]!.body.last_assistant_message).toBe("latest model");
    });
  });

  it("relay accepts undiscriminated assistant-shaped transcript fields", async () => {
    await withHookServer(async ({ port, requests }) => {
      const cwd = await writeRelay({ port });
      const transcriptPath = join(cwd, "transcript.jsonl");
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ role: "assistant", message: "older assistant" }),
          JSON.stringify({ text: "not assistant" }),
          JSON.stringify({ modelMessage: "model field" }),
        ].join("\n"),
      );

      await runRelay(cwd, { transcriptPath });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.last_assistant_message).toBe("model field");
    });
  });

  it("relay posts failure input with failure flag and text", async () => {
    await withHookServer(async ({ port, requests }) => {
      const cwd = await writeRelay({ port });

      await runRelay(cwd, { error: "model crashed" });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("/v1/shadow-hooks/stop?goalId=g1&failure=1");
      expect(requests[0]!.body.last_assistant_message).toBe("model crashed");
    });
  });

  it("relay reports malformed or missing transcript as a failure", async () => {
    await withHookServer(async ({ port, requests }) => {
      const cwd = await writeRelay({ port });

      await runRelay(cwd, { transcriptPath: join(cwd, "missing.jsonl") });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("/v1/shadow-hooks/stop?goalId=g1&failure=1");
      expect(requests[0]!.body.last_assistant_message).toMatch(/missing\.jsonl|ENOENT/);
    });

    await withHookServer(async ({ port, requests }) => {
      const cwd = await writeRelay({ port });
      const transcriptPath = join(cwd, "malformed.jsonl");
      await writeFile(transcriptPath, "{not json}\n");

      await runRelay(cwd, { transcriptPath });

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("/v1/shadow-hooks/stop?goalId=g1&failure=1");
      expect(requests[0]!.body.last_assistant_message).toMatch(/malformed transcript entry/);
    });
  });
});

/**
 * Build the resolver command for tests: a Node.js inline script that forwards
 * the `hook <relUrl> [--spool]` invocation to the test HTTP server via fetch.
 * Called as: node -e <script> hook <relUrl> [--spool] (stdin = JSON body)
 */
function makeTestResolverCommand(port: number): string[] {
  // The resolver is called as: <bin> <...args> hook <relUrl> [--spool]
  // We receive relUrl in process.argv at the position after "hook".
  const script =
    `const relUrl=process.argv[process.argv.indexOf('hook')+1];` +
    `const chunks=[];process.stdin.on('data',d=>chunks.push(d));` +
    `process.stdin.on('end',async()=>{` +
    `const body=Buffer.concat(chunks);` +
    `await fetch('http://127.0.0.1:${port}'+relUrl,{method:'POST',headers:{'Content-Type':'application/json'},body});` +
    `});`;
  return [process.execPath, "-e", script];
}

async function writeRelay(args: { port: number }) {
  const cwd = await mkdtemp(join(tmpdir(), "orca-antigravity-relay-"));
  const agentsDir = join(cwd, ".agents");
  await mkdir(agentsDir);
  const provider = new AntigravityShadowProvider();
  const cfg = provider.hookConfig({ goalId: "g1", resolverCommand: makeTestResolverCommand(args.port) });
  const relay = cfg.files.find((f) => f.relPath === ".agents/orca-stop-hook.cjs");
  if (!relay) throw new Error("missing relay script");
  await writeFile(join(cwd, relay.relPath), relay.contents);
  return cwd;
}

async function withHookServer(
  fn: (ctx: { port: number; requests: HookRequest[] }) => Promise<void>,
) {
  const requests: HookRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn({ port: (server.address() as AddressInfo).port, requests });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function runRelay(cwd: string, input: unknown) {
  const child = spawn(process.execPath, [".agents/orca-stop-hook.cjs"], { cwd });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect({ code, stderr, stdout }).toEqual({
    code: 0,
    stderr: "",
    stdout: JSON.stringify({ decision: "allow" }),
  });
}
