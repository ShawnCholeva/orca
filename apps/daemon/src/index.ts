import { pathToFileURL } from 'node:url';
import { sidecarMigrationsDir } from './sidecar-bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { eventBus } from './events.js';
import { defaultMigrationsDir, runMigrations } from './migrations.js';
import { seedAgents } from './agents.js';
import { bootstrapRegistries } from './registry/bootstrap.js';
import { adapterRegistry } from './adapters/registry.js';
import { seedAdapterExecutionModes } from './adapters/execution-modes.js';
import type { ExecutionMode } from '@orca/contracts';
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
import { subscribeOrchestrationTriggers } from './generation/triggers.js';
import { reconcileInFlightGenerations } from './generation/reconcile.js';
import { reconcileBuiltInTemplates, upgradeInstalledBuiltInTemplates } from './workflows/templates/usecases.js';
import { reconcileWorkflowsOnBoot } from './workflows/reconcile.js';
import { assertHarnessRegistryConformance } from './harness-transitions/conformance.js';
import { assertHookContractConformance } from './orchestrator-llm/providers/hook-contract.js';

export interface DaemonStartHandles {
  close: () => Promise<void>;
}

async function drainSpool(dataDir: string, baseUrl: string, token: string): Promise<void> {
  const { listSpool, removeSpool, shouldAgeOut } = await import("./discovery/spool.js");
  const { writeFileSync, renameSync } = await import("node:fs");
  const now = () => new Date().toISOString();
  for (const { file, entry } of listSpool(dataDir)) {
    if (shouldAgeOut(entry, now, 5, 24 * 60 * 60 * 1000)) { removeSpool(file); continue; }
    try {
      const res = await fetch(`${baseUrl}${entry.relUrl}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: entry.body,
      });
      if (res.ok) { removeSpool(file); continue; }
    } catch { /* leave for retry */ }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...entry, attempts: entry.attempts + 1 }), "utf8");
    renameSync(tmp, file);
  }
}

export async function startDaemon(): Promise<DaemonStartHandles> {
  const config = loadConfig();

  const { acquireLock, releaseLock, breakLock } = await import("./discovery/singleton.js");
  const { writeDiscoveryFile, removeDiscoveryFile, readDiscoveryFile } = await import("./discovery/discovery-file.js");
  const { probeHealth } = await import("./discovery/health.js");
  if (!acquireLock(config.dataDir)) {
    const rec = readDiscoveryFile(config.dataDir);
    if (rec && (await probeHealth(rec.url))) {
      console.error("[orca-daemon] a healthy daemon is already running — exiting");
      process.exit(0);
    }
    // Lock holder is hung (alive pid, not serving) or stale — take over.
    console.error("[orca-daemon] stale/hung lock holder — taking over");
    breakLock(config.dataDir);
    if (!acquireLock(config.dataDir)) {
      console.error("[orca-daemon] lost takeover race — exiting");
      process.exit(0);
    }
  }

  const db = openDatabase(config);

  const migrationsDir = sidecarMigrationsDir() ?? defaultMigrationsDir();

  try {
    runMigrations(db, migrationsDir);
  } catch (err) {
    console.error('[orca-daemon] Migration failed — aborting startup:', err);
    process.exit(1);
  }

  try {
    assertHarnessRegistryConformance(db);
  } catch (err) {
    console.error('[orca-daemon] Harness registry conformance failed — aborting startup:', err);
    process.exit(1);
  }

  try {
    assertHookContractConformance();
  } catch (err) {
    console.error('[orca-daemon] Hook contract conformance failed — aborting startup:', err);
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
    const supportedByAdapter: Record<string, ExecutionMode[]> = {};
    for (const adapter of adapterRegistry.listAgentAdapters()) {
      supportedByAdapter[adapter.id] = adapter.supportedExecutionModes;
    }
    seedAdapterExecutionModes(db, () => new Date().toISOString(), supportedByAdapter);
  } catch (err) {
    console.error('[orca-daemon] Adapter execution-mode seed failed — aborting startup:', err);
    process.exit(1);
  }

  try {
    // Built-in templates are no longer auto-seeded; onboarding installs the
    // user's selection via POST /v1/workflow-templates/install. Drop any stale
    // built-ins that are no longer in the catalog and have no runs, then bring
    // already-installed built-ins up to their current catalog version (so catalog
    // version bumps reach existing users on app update — without resurrecting
    // ones they deleted or installing ones they never selected).
    reconcileBuiltInTemplates(db);
    upgradeInstalledBuiltInTemplates({ db, bus: eventBus });
  } catch (err) {
    console.error('[orca-daemon] Workflow template reconcile failed — aborting startup:', err);
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
    resumeActiveRunsOnBoot: true,
  });

  try {
    await server.listen({ host: '127.0.0.1', port: config.port });
  } catch (err) {
    server.log.error(err);
    releaseLock(config.dataDir);
    process.exit(1);
  }

  const addr = server.server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : config.port;
  const token = config.getAuthToken();
  writeDiscoveryFile(config.dataDir, {
    version: 1,
    url: `http://127.0.0.1:${boundPort}`,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    protocol: "http",
  });

  await drainSpool(config.dataDir, `http://127.0.0.1:${boundPort}`, token);

  registerShutdown(server, extractionRunner, config.dataDir);

  return {
    close: async () => {
      extractionRunner.stop();
      await server.close();
      removeDiscoveryFile(config.dataDir);
      releaseLock(config.dataDir);
    },
  };
}

function isMainEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return import.meta.url === pathToFileURL(entrypoint).href;
}

async function runHookSubcommand(relUrl: string, spool: boolean): Promise<void> {
  const { resolveAndDeliver } = await import("./hooks-resolver/resolver.js");
  const cfg = loadConfig();
  const body = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data));
    if (process.stdin.isTTY) resolve(""); // no piped input
  });
  const result = await resolveAndDeliver({
    dataDir: cfg.dataDir, relUrl, body, spoolable: spool,
    now: () => new Date().toISOString(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}

async function runStopSubcommand(): Promise<void> {
  const { readDiscoveryFile } = await import("./discovery/discovery-file.js");
  const { isPidAlive } = await import("./discovery/singleton.js");
  const cfg = loadConfig();
  const rec = readDiscoveryFile(cfg.dataDir);
  if (rec && isPidAlive(rec.pid)) {
    try { process.kill(rec.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  process.exit(0);
}

if (isMainEntrypoint()) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "hook") {
    const relUrl = rest[0] ?? "";
    runHookSubcommand(relUrl, rest.includes("--spool")).catch((err) => {
      console.error("[orca-daemon] hook error:", err);
      process.exit(0); // never block the agent
    });
  } else if (sub === "--stop") {
    runStopSubcommand().catch(() => process.exit(0));
  } else {
    startDaemon().catch((err) => {
      console.error("[orca-daemon] fatal:", err);
      process.exit(1);
    });
  }
}
