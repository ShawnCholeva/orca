import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SessionStatus } from "@orca/contracts";
import { LIVE_SESSION, liveSessionSql } from "./live-session.js";

// Every status the contract knows about, partitioned by whether a session in
// that state can still be doing work. Adding a value to SessionStatus without
// classifying it here fails the exhaustiveness test below — which is the whole
// point: the bug this predicate exists to prevent was a new status (`created`)
// silently falling outside a hand-written allow-list.
const LIVE: SessionStatus[] = ["created", "starting", "running"];
const TERMINAL: SessionStatus[] = ["exited", "failed", "stopped", "archived"];

describe("liveSessionSql", () => {
  it("classifies every status in the contract — no value may be left undecided", () => {
    expect([...LIVE, ...TERMINAL].sort()).toEqual([...SessionStatus.options].sort());
  });

  it("admits every live status and excludes every terminal one", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO sessions (id, status) VALUES (?, ?)");
    for (const s of SessionStatus.options) insert.run(s, s);

    const matched = db
      .prepare(`SELECT id FROM sessions WHERE ${LIVE_SESSION} ORDER BY id`)
      .all() as Array<{ id: string }>;

    expect(matched.map((r) => r.id)).toEqual([...LIVE].sort());
  });

  it("qualifies the column so it can be used in a joined query", () => {
    expect(liveSessionSql("s.status")).toContain("s.status NOT IN");
  });
});
