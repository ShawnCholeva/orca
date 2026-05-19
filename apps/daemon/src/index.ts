import { sidecarMigrationsDir } from './sidecar-bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { eventBus } from './events.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { bootstrapRegistries } from './registry/bootstrap.js';
import { createServer } from './server.js';
import { registerShutdown } from './shutdown.js';
import { reconcileSessionsOnBoot } from './sessions/reconciliation.js';
import { reconcileStaleExtractions } from './extractions/reconciliation.js';

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

  // Reconcile stale sessions before accepting traffic.
  const bootNow = new Date().toISOString();
  reconcileSessionsOnBoot(db, eventBus, bootNow);
  reconcileStaleExtractions(db, eventBus, bootNow);

  const server = createServer(config);

  try {
    await server.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  registerShutdown(server);
}

main().catch((err) => {
  console.error('[orca-daemon] fatal:', err);
  process.exit(1);
});
