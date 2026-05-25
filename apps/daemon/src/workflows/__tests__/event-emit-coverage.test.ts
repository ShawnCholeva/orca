import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { WorkflowEventType } from "@orca/contracts";
import { describe, expect, test } from "vitest";

const OPTIONAL_UNEMITTED = new Set<string>([
  "workflow.run.failed",
  "workflow.task.dag.updated",
  "workflow.validation.run",
  "workflow.validation.passed",
  "workflow.validation.failed",
  "workflow.validation.skipped",
]);

const GOAL_SCOPED_EVENT_TYPES = [
  "workflow.run.started",
  "workflow.run.paused",
  "workflow.run.blocked",
  "workflow.run.completed",
  "workflow.run.cancelled",
  "workflow.step.started",
  "workflow.step.completed",
  "workflow.step.blocked",
  "workflow.step.skipped",
  "workflow.step.failed",
  "workflow.artifact.created",
  "workflow.guardrail.evaluated",
  "workflow.operator.selected",
  "workflow.decision.requested",
  "workflow.decision.recorded",
  "workflow.user.input.requested",
  "workflow.user.input.submitted",
  "workflow.recommendation.created",
  "workflow.recommendation.accepted",
  "workflow.recommendation.rejected",
] as const;

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && abs.endsWith(".ts")) out.push(abs);
    }
  }
  return out;
}

function hasEventProducer(type: string, code: string): boolean {
  if (!code.includes(`"${type}"`) && !code.includes(`'${type}'`)) return false;
  return code.includes("appendWorkflowEvent(") || code.includes("emitEvent(");
}

describe("workflow event emit coverage", () => {
  const workflowsRoot = path.resolve("src/workflows");
  const recommendationsFile = path.resolve("src/recommendations/usecases.ts");
  const files = [...listTsFiles(workflowsRoot), recommendationsFile].filter(
    (file) => !file.endsWith(`${path.sep}workflows${path.sep}events.ts`)
  );
  const codeByFile = files.map((file) => ({ file, code: readFileSync(file, "utf8") }));

  test("every non-optional workflow event has a producer", () => {
    for (const type of WorkflowEventType.options) {
      if (OPTIONAL_UNEMITTED.has(type)) continue;
      const produced = codeByFile.some(({ code }) => hasEventProducer(type, code));
      expect(produced, `missing producer for ${type}`).toBe(true);
    }
  });

  test("goal-scoped workflow producers include goalId in payloads", () => {
    for (const type of GOAL_SCOPED_EVENT_TYPES) {
      if (OPTIONAL_UNEMITTED.has(type)) continue;
      const producers = codeByFile.filter(({ code }) => hasEventProducer(type, code));
      expect(producers.length, `no producer found for ${type}`).toBeGreaterThan(0);
      for (const producer of producers) {
        const idx = producer.code.indexOf(type);
        const window = producer.code.slice(Math.max(0, idx - 400), idx + 800);
        expect(
          window.includes("goalId") || window.includes("goal_id"),
          `${type} producer in ${producer.file} missing goalId`
        ).toBe(true);
      }
    }
  });
});
