import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { createServer } from './server.js';

const config = loadConfig();
const db = openDatabase(config);
const server = createServer(config);

try {
  runMigrations(db, defaultMigrationsDir);
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
