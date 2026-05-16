// sidecar-bootstrap must be evaluated first; it auto-runs initSidecarRuntime
// at module load, before db.ts pulls in better-sqlite3.
import { sidecarMigrationsDir } from './sidecar-bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { createServer } from './server.js';
import { registerShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config);
  const server = createServer(config);

  const migrationsDir = sidecarMigrationsDir() ?? defaultMigrationsDir();

  try {
    runMigrations(db, migrationsDir);
  } catch (err) {
    server.log.error(err, 'Migration failed — aborting startup');
    process.exit(1);
  }

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
