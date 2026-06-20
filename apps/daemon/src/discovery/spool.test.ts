import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueSpool, listSpool, removeSpool, shouldAgeOut, spoolDir } from "./spool.js";

const clock = (iso: string) => () => iso;

describe("hook spool", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orca-spool-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("enqueues then lists oldest-first", () => {
    enqueueSpool(dir, { relUrl: "/v1/agent-hooks/stop?sessionId=b", body: "{}" }, clock("2026-06-20T00:00:02.000Z"));
    enqueueSpool(dir, { relUrl: "/v1/agent-hooks/stop?sessionId=a", body: "{}" }, clock("2026-06-20T00:00:01.000Z"));
    const items = listSpool(dir);
    expect(items.map((i) => i.entry.relUrl)).toEqual([
      "/v1/agent-hooks/stop?sessionId=a",
      "/v1/agent-hooks/stop?sessionId=b",
    ]);
    expect(items[0].entry.attempts).toBe(0);
  });

  it("removeSpool deletes the file", () => {
    const file = enqueueSpool(dir, { relUrl: "/x", body: "{}" }, clock("2026-06-20T00:00:00.000Z"));
    removeSpool(file);
    expect(existsSync(file)).toBe(false);
  });

  it("creates the spool dir on demand", () => {
    enqueueSpool(dir, { relUrl: "/x", body: "{}" }, clock("2026-06-20T00:00:00.000Z"));
    expect(existsSync(spoolDir(dir))).toBe(true);
  });

  it("ages out past max attempts", () => {
    const entry = { relUrl: "/x", body: "{}", enqueuedAt: "2026-06-20T00:00:00.000Z", attempts: 5 };
    expect(shouldAgeOut(entry, clock("2026-06-20T00:00:01.000Z"), 5, 86_400_000)).toBe(true);
  });

  it("ages out past max age", () => {
    const entry = { relUrl: "/x", body: "{}", enqueuedAt: "2026-06-19T00:00:00.000Z", attempts: 0 };
    expect(shouldAgeOut(entry, clock("2026-06-21T00:00:00.000Z"), 5, 86_400_000)).toBe(true);
  });
});
