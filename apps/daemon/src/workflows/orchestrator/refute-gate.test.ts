import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { riskClassAtLeast } from "../../harness-risk/rank.js";
import { stepToolRiskClass, shouldRefute } from "./refute-gate.js";

function seedTx(db: Database.Database, stepRunId: string, riskClass: string) {
  db.prepare("INSERT INTO harness_transitions (id, goal_id, workflow_run_id, workflow_step_run_id, boundary, risk_json, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(`t-${Math.random()}`, "g", "r", stepRunId, "tool_gate", JSON.stringify({ risk_class: riskClass, permission_tier: "sandbox_edit", classification_reasons: [], gate_decision: "allow", hard_constraint_violations: [] }), "2026-07-03T00:00:00.000Z");
}

describe("riskClassAtLeast", () => {
  it("orders low<medium<high<critical", () => {
    expect(riskClassAtLeast("high", "high")).toBe(true);
    expect(riskClassAtLeast("critical", "high")).toBe(true);
    expect(riskClassAtLeast("medium", "high")).toBe(false);
  });
});

describe("stepToolRiskClass", () => {
  it("returns the max risk over the step's tool_gate rows; low when none", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE harness_transitions (id TEXT PRIMARY KEY, goal_id TEXT, workflow_run_id TEXT, workflow_step_run_id TEXT, boundary TEXT, risk_json TEXT, created_at TEXT)");
    expect(stepToolRiskClass(db, "s1")).toBe("low");
    seedTx(db, "s1", "medium"); seedTx(db, "s1", "high"); seedTx(db, "s2", "critical");
    expect(stepToolRiskClass(db, "s1")).toBe("high");
    expect(stepToolRiskClass(db, "s2")).toBe("critical");
  });
});

describe("shouldRefute", () => {
  it("fires on high tool-risk, on null evidence, and on oracle gaps; skips a well-verified low-risk step", () => {
    expect(shouldRefute("high", { oracleAdequacy: { gaps: [] } })).toEqual({ refute: true, triggers: ["high_risk"] });
    expect(shouldRefute("low", null)).toEqual({ refute: true, triggers: ["no_oracle"] });
    expect(shouldRefute("low", { oracleAdequacy: { gaps: ["integration"] } })).toEqual({ refute: true, triggers: ["weak_oracle"] });
    expect(shouldRefute("low", { oracleAdequacy: { gaps: [] } })).toEqual({ refute: false, triggers: [] });
  });
});
