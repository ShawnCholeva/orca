import { sidecarMigrationsDir } from './sidecar-bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { eventBus } from './events.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { bootstrapRegistries } from './registry/bootstrap.js';
import { createServer } from './server.js';
import { registerShutdown } from './shutdown.js';
import { reconcileSessionsOnBoot } from './sessions/reconciliation.js';
import { createSessionOutputStore } from './sessions/output-store.js';
import { reconcileStaleExtractions } from './extractions/reconciliation.js';
import { ExtractionRunner } from './extractions/runner.js';
import { DeterministicExtractor } from './extractions/deterministic-extractor.js';

async function main(): Promise<void> {
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
    bootstrapRegistries();
  } catch (err) {
    console.error('[orca-daemon] Registry bootstrap failed — aborting startup:', err);
    process.exit(1);
  }

  // Reconcile stale sessions and extractions before accepting traffic.
  const bootNow = new Date().toISOString();
  reconcileSessionsOnBoot(db, eventBus, bootNow);
  reconcileStaleExtractions(db, eventBus, bootNow);

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

  const server = createServer(config, { sessionOutputStore, extractionRunner });

  try {
    await server.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  registerShutdown(server, extractionRunner);
}

main().catch((err) => {
  console.error('[orca-daemon] fatal:', err);
  process.exit(1);
});
