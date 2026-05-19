#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const sidecarDir = path.join(pkgRoot, "dist", "sidecar");
const runtimeDir = path.join(sidecarDir, "runtime");
const token = "m4-015-sidecar-smoke-token";
const sentinel = "orca-sidecar-smoke";
const isWindows = process.platform === "win32";

function computeTargetTriple() {
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (!arch) throw new Error(`Unsupported arch: ${process.arch}`);
  const platformPart = {
    linux: "unknown-linux-gnu",
    darwin: "apple-darwin",
    win32: "pc-windows-msvc",
  }[process.platform];
  if (!platformPart) throw new Error(`Unsupported platform: ${process.platform}`);
  return `${arch}-${platformPart}`;
}

function execFileChecked(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { maxBuffer: 20 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to pick an ephemeral port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeBase64(value) {
  return Buffer.from(String(value), "base64").toString("utf8");
}

async function requestJson(baseUrl, method, urlPath, body) {
  const headers = { authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${baseUrl}${urlPath}`, init);
  if (!response.ok) {
    throw new Error(`${method} ${urlPath} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForHealth(baseUrl, daemon) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`sidecar exited before health check passed (exit ${daemon.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) return;
    } catch {
      // Retry until the daemon is listening.
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for sidecar health");
}

function openEventsSocket(baseUrl) {
  const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/v1/events?token=${token}`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for WebSocket message"));
    }, timeoutMs);

    function onMessage(raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(parsed);
      }
    }

    ws.on("message", onMessage);
  });
}

function collectOutput(detail) {
  return detail.output.chunks
    .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
    .join("");
}

async function main() {
  console.log("[m4-015] building sidecar...");
  await execFileChecked(process.execPath, [path.join(here, "build-sidecar.mjs")], {
    cwd: pkgRoot,
  });

  const binaryPath = path.join(
    sidecarDir,
    `orca-daemon-${computeTargetTriple()}${isWindows ? ".exe" : ""}`,
  );
  if (!existsSync(binaryPath)) throw new Error(`missing sidecar binary: ${binaryPath}`);
  if (!existsSync(runtimeDir)) throw new Error(`missing sidecar runtime: ${runtimeDir}`);

  const rootDir = mkdtempSync(path.join(os.tmpdir(), "orca-m4-015-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const dataDir = path.join(rootDir, "daemon-data");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const port = await pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const daemonOutput = { stdout: "", stderr: "" };
  const daemon = spawn(binaryPath, [], {
    env: {
      ...process.env,
      ORCA_DATA_DIR: dataDir,
      ORCA_LOG_LEVEL: "silent",
      ORCA_PORT: String(port),
      ORCA_RUNTIME_DIR: runtimeDir,
      ORCA_SHELL: isWindows ? "cmd.exe" : "/bin/sh",
      ORCA_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  daemon.stdout.setEncoding("utf8");
  daemon.stderr.setEncoding("utf8");
  daemon.stdout.on("data", (chunk) => {
    daemonOutput.stdout = `${daemonOutput.stdout}${chunk}`.slice(-16_384);
  });
  daemon.stderr.on("data", (chunk) => {
    daemonOutput.stderr = `${daemonOutput.stderr}${chunk}`.slice(-16_384);
  });

  let ws;
  try {
    await waitForHealth(baseUrl, daemon);

    const { goal } = await requestJson(baseUrl, "POST", "/v1/goals", {
      title: "M4-015 Sidecar Smoke",
      description: "Bundled daemon PTY smoke",
      workspaces: [{ inputPath: workspaceDir }],
    });

    const goalDetail = await requestJson(baseUrl, "GET", `/v1/goals/${goal.id}`);
    const workspaceId = goalDetail.workspaces[0]?.id;
    if (!workspaceId) throw new Error("created goal did not include an attached workspace");

    const { adapters } = await requestJson(baseUrl, "GET", "/v1/adapters");
    const shellManual = adapters.find((adapter) => adapter.id === "shell-manual");
    if (shellManual?.availability !== "available") {
      throw new Error("shell-manual adapter is not available in bundled daemon");
    }

    const { session } = await requestJson(baseUrl, "POST", `/v1/goals/${goal.id}/sessions`, {
      workspaceId,
      adapterId: "shell-manual",
      title: "Sidecar smoke shell",
    });

    ws = await openEventsSocket(baseUrl);
    ws.send(JSON.stringify({ type: "session.subscribe", sessionId: session.id }));

    await requestJson(baseUrl, "POST", `/v1/sessions/${session.id}/start`, {
      terminalCols: 80,
      terminalRows: 24,
    });

    const outputPromise = waitForMessage(
      ws,
      (message) =>
        message.type === "session.output" &&
        message.sessionId === session.id &&
        decodeBase64(message.dataBase64).includes(sentinel),
    );

    ws.send(JSON.stringify({
      type: "session.input",
      sessionId: session.id,
      dataBase64: Buffer.from(`echo ${sentinel}\n`).toString("base64"),
    }));

    await outputPromise;

    const stoppedPromise = waitForMessage(
      ws,
      (message) =>
        message.type === "session.stopped" &&
        message.payload?.sessionId === session.id,
    );
    await requestJson(baseUrl, "POST", `/v1/sessions/${session.id}/stop`);
    await stoppedPromise;

    const detail = await requestJson(baseUrl, "GET", `/v1/sessions/${session.id}`);
    if (detail.session.status !== "stopped") {
      throw new Error(`expected stopped session, found ${detail.session.status}`);
    }
    if (!collectOutput(detail).includes(sentinel)) {
      throw new Error("session output tail did not include smoke sentinel");
    }

    console.log("[m4-015] sidecar PTY smoke passed");
  } catch (error) {
    if (daemonOutput.stderr.length > 0) {
      console.error("[m4-015] daemon stderr tail:");
      console.error(daemonOutput.stderr);
    }
    throw error;
  } finally {
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => daemon.once("exit", resolve)),
      sleep(2_000),
    ]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
    rmSync(rootDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[m4-015] smoke failed:", error);
  process.exit(1);
});
