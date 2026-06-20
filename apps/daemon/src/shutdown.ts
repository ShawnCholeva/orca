import type { FastifyInstance } from 'fastify';
import { closeDatabase } from './db.js';
import type { ExtractionRunner } from './extractions/runner.js';

const SHUTDOWN_BUDGET_MS = 5000;

// Registers SIGTERM/SIGINT handlers that drain in-flight requests, close WS
// clients, and flush the DB before exiting. Must be called after server.listen.
export function registerShutdown(server: FastifyInstance, extractionRunner?: ExtractionRunner, dataDir?: string): void {
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    server.log.info({ signal }, 'Graceful shutdown initiated');

    const forceTimer = setTimeout(() => {
      server.log.error('Shutdown exceeded budget — forcing exit');
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);
    forceTimer.unref();

    try {
      extractionRunner?.stop();

      // Close open WS connections with 1001 (Going Away) before draining HTTP
      for (const client of server.websocketServer.clients) {
        client.close(1001, 'Server shutting down');
      }

      await server.close();

      if (dataDir) {
        const { removeDiscoveryFile } = await import('./discovery/discovery-file.js');
        const { releaseLock } = await import('./discovery/singleton.js');
        removeDiscoveryFile(dataDir);
        releaseLock(dataDir);
      }

      closeDatabase();

      clearTimeout(forceTimer);
      process.exit(0);
    } catch (err) {
      server.log.error(err, 'Error during shutdown');
      clearTimeout(forceTimer);
      process.exit(1);
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}
