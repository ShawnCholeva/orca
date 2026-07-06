import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { MetricPeriod } from "@orca/contracts";
import { analyzeTemplate, listProposalsEnriched, judgeProposal, type AnalyzeDeps } from "./usecases.js";
import { getProposal } from "./store.js";
import {
  applyLearnedInstructionEdit, rollbackAppliedProposal, restoreTemplateDefault, dismissProposal,
  StaleProposalError, ProposalNotPendingError, ProposalNotAppliedError, NoBaselineError, StepNotFoundError,
  InvalidSchemaEditError,
} from "./apply.js";
import type { RollbackOutcomeSnapshot } from "@orca/contracts";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";

export interface LearningRouteDeps extends AnalyzeDeps {
  db: Database.Database;
  actor: () => string;   // resolves the acting owner id for decidedBy (single-owner today)
  shadowAsk: ShadowAsk;
  terminateShadow: (key: string) => Promise<void> | void;
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
      if (e instanceof InvalidSchemaEditError) { reply.status(422); return { error: { code: "invalid_schema_edit", message: e.message } }; }
      throw e;
    }
  });

  server.post("/v1/learning/proposals/:id/dismiss", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      dismissProposal(db, id, { decidedBy: deps.actor(), now: now() });
      return { proposal: getProposal(db, id) };
    } catch (e) {
      if (e instanceof StepNotFoundError) { reply.status(404); return { error: { code: "not_found" } }; }
      if (e instanceof ProposalNotPendingError) { reply.status(409); return { error: { code: "not_pending" } }; }
      throw e;
    }
  });

  server.post("/v1/learning/proposals/:id/judge", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const proposal = await judgeProposal({ shadowAsk: deps.shadowAsk, terminateShadow: deps.terminateShadow }, db, id);
      return { proposal };
    } catch (e) {
      if (e instanceof StepNotFoundError) { reply.status(404); return { error: { code: "not_found" } }; }
      if (e instanceof ProposalNotPendingError) { reply.status(409); return { error: { code: "not_pending" } }; }
      throw e;
    }
  });

  server.post("/v1/learning/proposals/:id/rollback", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProposal(db, id);
    if (!p) { reply.status(404); return { error: { code: "not_found" } }; }
    let outcome: RollbackOutcomeSnapshot | undefined;
    if (p.status === "applied") {
      const enriched = listProposalsEnriched(db, p.templateId, "30d").find((x) => x.id === id);
      outcome = {
        targetDelta: enriched?.targetDelta ?? null,
        targetDeltaVersions: enriched?.targetDeltaVersions ?? null,
        invalidOutputRateDelta: enriched?.invalidOutputRateDelta ?? null,
        regressionDetected: enriched?.regressionDetected ?? false,
      };
    }
    try {
      rollbackAppliedProposal(db, id, { decidedBy: deps.actor(), now: now(), outcome });
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
