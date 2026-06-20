import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscoveryFile } from "../discovery/discovery-file.js";
import { listSpool } from "../discovery/spool.js";
import { resolveAndDeliver } from "./resolver.js";

const now = () => "2026-06-20T00:00:00.000Z";
const disc = {
  version: 1 as const, url: "http://127.0.0.1:9", token: "tok", pid: 1,
  startedAt: now(), protocol: "http" as const,
};

describe("resolveAndDeliver", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-res-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("delivers and relays the daemon response on 2xx", async () => {
    writeDiscoveryFile(dir, { ...disc, url: "http://daemon.test" });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://daemon.test/v1/agent-hooks/stop?sessionId=s1");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/stop?sessionId=s1",
      body: "{}", spoolable: true, now, fetchImpl,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{"ok":true}');
    expect(listSpool(dir)).toHaveLength(0);
  });

  it("spools when discovery file is missing and spoolable", async () => {
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/stop?sessionId=s1",
      body: "{}", spoolable: true, now,
    });
    expect(r.exitCode).toBe(0);
    expect(listSpool(dir)).toHaveLength(1);
  });

  it("denies (no spool) when not spoolable and daemon unreachable", async () => {
    writeDiscoveryFile(dir, disc); // url points at closed port
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/permission?sessionId=s1",
      body: "{}", spoolable: false, now, fetchImpl,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("deny");
    expect(listSpool(dir)).toHaveLength(0);
  });

  it("spools on connection error when spoolable", async () => {
    writeDiscoveryFile(dir, disc);
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveAndDeliver({
      dataDir: dir, relUrl: "/v1/agent-hooks/stop?sessionId=s1",
      body: "{}", spoolable: true, now, fetchImpl,
    });
    expect(r.exitCode).toBe(0);
    expect(listSpool(dir)).toHaveLength(1);
  });
});
