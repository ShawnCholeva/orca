import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DocumentSnapshotError,
  SNAPSHOT_MAX_BYTES,
  snapshotFile,
  snapshotUrl,
} from "./snapshot.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-doc-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

async function expectSnapshotError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy(
    (e: unknown) => e instanceof DocumentSnapshotError && e.code === code,
  );
}

describe("snapshotFile", () => {
  it("reads content with a stable sha256 hash", async () => {
    const file = path.join(tempDir(), "spec.md");
    writeFileSync(file, "# Spec\nhello");
    const a = await snapshotFile(file);
    const b = await snapshotFile(file);
    expect(a.content).toBe("# Spec\nhello");
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentBytes).toBe(Buffer.byteLength("# Spec\nhello", "utf8"));
    expect(a.truncated).toBe(false);
  });

  it("rejects a relative path", async () => {
    await expectSnapshotError(snapshotFile("relative/spec.md"), "invalid_ref");
  });

  it("rejects a missing file with file_not_found", async () => {
    await expectSnapshotError(snapshotFile(path.join(tempDir(), "nope.md")), "file_not_found");
  });

  it("rejects a binary file (NUL byte) with binary_file_unsupported", async () => {
    const file = path.join(tempDir(), "bin.dat");
    writeFileSync(file, Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
    await expectSnapshotError(snapshotFile(file), "binary_file_unsupported");
  });

  it("caps oversize files and marks them truncated", async () => {
    const file = path.join(tempDir(), "big.txt");
    writeFileSync(file, "x".repeat(SNAPSHOT_MAX_BYTES + 100));
    const s = await snapshotFile(file);
    expect(s.truncated).toBe(true);
    expect(s.contentBytes).toBe(SNAPSHOT_MAX_BYTES);
  });
});

describe("snapshotUrl", () => {
  it("snapshots a 200 text response", async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/markdown" });
        res.end("# Remote doc");
      }),
    );
    const s = await snapshotUrl(`${base}/doc.md`, 2000);
    expect(s.content).toBe("# Remote doc");
    expect(s.truncated).toBe(false);
  });

  it("rejects non-http(s) URLs", async () => {
    await expectSnapshotError(snapshotUrl("ftp://example.com/x", 2000), "invalid_ref");
  });

  it("rejects a 404 with url_fetch_failed", async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.writeHead(404);
        res.end("gone");
      }),
    );
    await expectSnapshotError(snapshotUrl(`${base}/missing`, 2000), "url_fetch_failed");
  });

  it("rejects a hung socket with url_fetch_timeout", async () => {
    const base = await listen(createServer(() => { /* never respond */ }));
    await expectSnapshotError(snapshotUrl(`${base}/hang`, 200), "url_fetch_timeout");
  });

  it("rejects binary content types with unsupported_content_type", async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end("%PDF-1.4");
      }),
    );
    await expectSnapshotError(snapshotUrl(`${base}/doc.pdf`, 2000), "unsupported_content_type");
  });

  it("caps oversized bodies and marks them truncated", async () => {
    const base = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("y".repeat(SNAPSHOT_MAX_BYTES + 4096));
      }),
    );
    const s = await snapshotUrl(`${base}/big.txt`, 5000);
    expect(s.truncated).toBe(true);
    expect(s.contentBytes).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  });
});
