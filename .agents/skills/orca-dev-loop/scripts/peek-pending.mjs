#!/usr/bin/env node
// Read-only: print the latest pending worker-permission request (and its body)
// for a goal, so each approval is an informed, reviewed decision — not a blind
// allow. Pending approvals are surfaced as orchestrator-chat messages; there is
// no list route, so we scan the message stream.
//
// Usage: node peek-pending.mjs <goalId>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const rec = JSON.parse(readFileSync(join(homedir(), ".orca", "daemon.json"), "utf8"));
const goalId = process.argv[2];
if (!goalId) { console.error("usage: peek-pending.mjs <goalId>"); process.exit(2); }
const auth = { Authorization: `Bearer ${rec.token}` };

const msgs = await (await fetch(`${rec.url}/v1/goals/${goalId}/orchestrator-messages`, { headers: auth })).json();
const list = msgs.messages || msgs;
const pending = [...list].reverse().find((m) => m.pendingApproval);
if (!pending) { console.log("no-pending"); process.exit(0); }
console.log(JSON.stringify(pending.pendingApproval, null, 2));
console.log("body:", pending.body);
