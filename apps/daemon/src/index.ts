import { pathToFileURL } from 'node:url';
import { sidecarMigrationsDir } from './sidecar-bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { eventBus } from './events.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { seedAgents } from './agents.js';
import { bootstrapRegistries } from './registry/bootstrap.js';
import { createServer } from './server.js';
import { registerShutdown } from './shutdown.js';
import { reconcileSessionsOnBoot } from './sessions/reconciliation.js';
import { createSessionOutputStore } from './sessions/output-store.js';
import { reconcileStaleExtractions } from './extractions/reconciliation.js';
import { ExtractionRunner } from './extractions/runner.js';
import { DeterministicExtractor } from './extractions/deterministic-extractor.js';
import { reconcileStaleAssemblies } from './context/reconcile.js';
import { sweepOrphanContextFiles } from './sessions/context-delivery.js';
import { createDaemonContext } from './daemon-context.js';
import { subscribeOrchestrationTriggers } from './orchestrator/triggers.js';
import { reconcileInFlightGenerations } from './orchestrator/reconcile.js';
import { seedEngineeringTemplate } from './workflows/templates/seed-engineering.js';
import { reconcileWorkflowsOnBoot } from './workflows/reconcile.js';

export interface DaemonStartHandles {
  close: () => Promise<void>;
}

export async function startDaemon(): Promise<DaemonStartHandles> {
  const config = loadConfig();
  const db = openDatabase(config);

  const migrationsDir = sidecarMigrationsDir() ?? defaultMigrationsDir();

  try {
    runMigrations(db, migrationsDir);
  } catch (err) {
    console.error('[orca-daemon] Migration failed — aborting startup:', err);
    process.exit(1);
  }

  try {
    seedAgents(db);
  } catch (err) {
    console.error('[orca-daemon] Agent seed failed — aborting startup:', err);
    process.exit(1);
  }

  try {
    bootstrapRegistries();
  } catch (err) {
    console.error('[orca-daemon] Registry bootstrap failed — aborting startup:', err);
    process.exit(1);
  }

  try {
    seedEngineeringTemplate(db, () => new Date().toISOString());
  } catch (err) {
    console.error('[orca-daemon] Workflow template seed failed — aborting startup:', err);
    process.exit(1);
  }

  // Reconcile stale sessions, extractions, and context assemblies before accepting traffic.
  const bootNow = new Date().toISOString();
  reconcileSessionsOnBoot(db, eventBus, bootNow);
  reconcileStaleExtractions(db, eventBus, bootNow);
  reconcileStaleAssemblies(db, eventBus, bootNow);
  await reconcileInFlightGenerations(db);
  reconcileWorkflowsOnBoot(db, () => new Date().toISOString());

  // Wire orchestration trigger subscriber (must be before HTTP listen).
  const daemonCtx = createDaemonContext(db, eventBus);
  subscribeOrchestrationTriggers(daemonCtx);

  // Sweep orphan context files for sessions no longer in an active state (best-effort)
  const activeSessionIds = new Set(
    (db.prepare('SELECT id FROM sessions WHERE status IN (?, ?)').all('created', 'running') as { id: string }[]).map(r => r.id)
  );
  sweepOrphanContextFiles(config.dataDir, (id) => activeSessionIds.has(id)).catch(() => {});

  const sessionOutputStore = createSessionOutputStore(db, {
    tailBytes: config.sessionOutputTailBytes,
  });

  const extractionRunner = new ExtractionRunner({
    db,
    bus: eventBus,
    outputStore: sessionOutputStore,
    extractor: new DeterministicExtractor(),
    config: {
      memoryExtractionMaxInputBytes: config.memoryExtractionMaxInputBytes,
      memoryExtractionTimeoutMs: config.memoryExtractionTimeoutMs,
    },
  });

  extractionRunner.start();

  const server = createServer(config, {
    sessionOutputStore,
    extractionRunner,
    daemonContext: daemonCtx,
  });

  try {
    await server.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  registerShutdown(server, extractionRunner);

  return {
    close: async () => {
      extractionRunner.stop();
      await server.close();
    },
  };
}

function isMainEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainEntrypoint()) {
  startDaemon().catch((err) => {
    console.error('[orca-daemon] fatal:', err);
    process.exit(1);
  });
}
