#!/usr/bin/env node
// CONDITIONAL approver (NOT a blanket allow) — the HITL safety gate from the
// harness principles. Auto-allows only reversible read/edit tools in this
// git-tracked repo; refuses to auto-approve Bash, network, or any other tool,
// surfacing it for explicit human review.
//
// Usage: node approve-pending.mjs <goalId>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SAFE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "LS"]);
const rec = JSON.parse(readFileSync(join(homedir(), ".orca", "daemon.json"), "utf8"));
const goalId = process.argv[2];
if (!goalId) { console.error("usage: approve-pending.mjs <goalId>"); process.exit(2); }
const auth = { Authorization: `Bearer ${rec.token}` };

const msgs = await (await fetch(`${rec.url}/v1/goals/${goalId}/orchestrator-messages`, { headers: auth })).json();
const list = msgs.messages || msgs;
const pending = [...list].reverse().find((m) => m.pendingApproval);
if (!pending) { console.log("no-pending"); process.exit(0); }
const { approvalId, toolName, summary } = pending.pendingApproval;

if (!SAFE.has(toolName)) {
  console.log(`NEEDS REVIEW: tool=${toolName} summary=${JSON.stringify(summary)} approvalId=${approvalId}`);
  process.exit(0);
}
const res = await fetch(
  `${rec.url}/v1/goals/${goalId}/permission-approvals/${approvalId}`,
  { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) },
);
console.log(`auto-allowed ${toolName} -> ${res.status}`);
