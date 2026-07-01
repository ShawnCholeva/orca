import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { MetricPeriod } from "@orca/contracts";
import { analyzeTemplate, listProposalsEnriched, type AnalyzeDeps } from "./usecases.js";
import { getProposal, updateProposalDecision } from "./store.js";
import {
  applyLearnedInstructionEdit, rollbackAppliedProposal, restoreTemplateDefault,
  StaleProposalError, ProposalNotPendingError, ProposalNotAppliedError, NoBaselineError, StepNotFoundError,
} from "./apply.js";

export interface LearningRouteDeps extends AnalyzeDeps {
  db: Database.Database;
  actor: () => string;   // resolves the acting owner id for decidedBy (single-owner today)
}

function templateExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM workflow_templates WHERE id = ?`).get(id);
}

export function registerLearningRoutes(server: FastifyInstance, deps: LearningRouteDeps): void {
  const { db } = deps;
  const now = () => new Date().toISOString();

  server.post("/v1/learning/templates/:id/analyze", async (req, reply) => {
    const period = MetricPeriod.safeParse((req.query as { period?: string }).period);
    if (!period.success) { reply.status(400); return { error: { code: "invalid_period" } }; }
    const { id } = req.params as { id: string };
    if (!templateExists(db, id)) { reply.status(404); return { error: { code: "template_not_found" } }; }
    const proposals = await analyzeTemplate(deps, db, id, period.data);
    return { proposals };
  });

  server.get("/v1/learning/templates/:id/proposals", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!templateExists(db, id)) { reply.status(404); return { error: { code: "template_not_found" } }; }
    const period = MetricPeriod.safeParse((req.query as { period?: string }).period ?? "7d");
    return { proposals: listProposalsEnriched(db, id, period.success ? period.data : "7d") };
  });

  server.post("/v1/learning/proposals/:id/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { editedInstructions?: string };
    try {
      applyLearnedInstructionEdit(db, id, { editedInstructions: body.editedInstructions, decidedBy: deps.actor(), now: now() });
      return { proposal: getProposal(db, id) };
    } catch (e) {
      if (e instanceof StepNotFoundError) { reply.status(404); return { error: { code: "not_found" } }; }
      if (e instanceof StaleProposalError) { reply.status(409); return { error: { code: "stale_proposal" } }; }
      if (e instanceof ProposalNotPendingError) { reply.status(409); return { error: { code: "not_pending" } }; }
      throw e;
    }
  });

  server.post("/v1/learning/proposals/:id/dismiss", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProposal(db, id);
    if (!p) { reply.status(404); return { error: { code: "not_found" } }; }
    if (p.status !== "pending") { reply.status(409); return { error: { code: "not_pending" } }; }
    updateProposalDecision(db, id, { status: "dismissed", decidedAt: now(), decidedBy: deps.actor() });
    return { proposal: getProposal(db, id) };
  });

  server.post("/v1/learning/proposals/:id/rollback", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      rollbackAppliedProposal(db, id, { decidedBy: deps.actor(), now: now() });
      return { proposal: getProposal(db, id) };
    } catch (e) {
      if (e instanceof StepNotFoundError) { reply.status(404); return { error: { code: "not_found" } }; }
      if (e instanceof ProposalNotAppliedError) { reply.status(409); return { error: { code: "not_applied" } }; }
      throw e;
    }
  });

  server.post("/v1/learning/templates/:id/restore-default", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!templateExists(db, id)) { reply.status(404); return { error: { code: "template_not_found" } }; }
    try {
      const { newVersion } = restoreTemplateDefault(db, id, now());
      return { restored: true, newVersion };
    } catch (e) {
      if (e instanceof NoBaselineError) { reply.status(409); return { error: { code: "no_baseline" } }; }
      throw e;
    }
  });
}
