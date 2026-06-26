import { resolveShadowProvider } from "./registry.js";
import type { HookAssumption, HookSurface, ShadowAdapterId, ShadowProvider } from "./types.js";

export const PROVIDER_IDS: ShadowAdapterId[] = ["claude-code", "codex", "antigravity"];

// Synthetic args used to regenerate emitted config for structural conformance.
// Values are arbitrary — only the emitted structure (event keys / file paths /
// payload-field references / spawn args) is asserted, never these literals.
const SYNTHETIC = {
  goalId: "conformance-goal",
  sessionId: "conformance-session",
  resolverCommand: ["node", "resolver.js"],
  configDir: "/tmp/orca-conformance",
};

export interface EmittedConfig {
  files: { relPath: string; contents: string }[];
  spawnArgs: string[];
}

export function emittedFor(provider: ShadowProvider, surface: HookSurface): EmittedConfig {
  if (surface === "orchestrator") {
    const cfg = provider.hookConfig({ goalId: SYNTHETIC.goalId, resolverCommand: SYNTHETIC.resolverCommand });
    return { files: cfg.files, spawnArgs: [] };
  }
  const cfg = provider.workerHookConfig({
    goalId: SYNTHETIC.goalId,
    sessionId: SYNTHETIC.sessionId,
    resolverCommand: SYNTHETIC.resolverCommand,
    configDir: SYNTHETIC.configDir,
  });
  return { files: cfg.files, spawnArgs: cfg.spawnArgs };
}

/** Returns a precise drift message, or null if the entry conforms. Unverified entries are skipped. */
export function conformanceError(provider: ShadowProvider, a: HookAssumption): string | null {
  if (!a.verified) return null;
  const where = `${a.provider}/${a.surface}/${a.event ?? "?"}`;
  const emitted = emittedFor(provider, a.surface);
  const file = a.file ? emitted.files.find((f) => f.relPath === a.file) : undefined;
  if (a.file && !file) return `hook contract drift: ${where} — declared file '${a.file}' not emitted`;
  const contents = file ? file.contents : "";
  if (a.event && !contents.includes(a.event)) {
    return `hook contract drift: ${where} — event '${a.event}' not found in ${a.file}`;
  }
  for (const field of a.payloadFields) {
    if (!contents.includes(field)) {
      return `hook contract drift: ${where} — declared field '${field}' not found in ${a.file}`;
    }
  }
  if (a.assertSpawnArg && !emitted.spawnArgs.includes(a.assertSpawnArg)) {
    return `hook contract drift: ${where} — spawn arg '${a.assertSpawnArg}' not emitted`;
  }
  return null;
}

/** Boot guard: throws loud if any verified entry across all providers fails conformance. */
export function assertHookContractConformance(): void {
  const errors: string[] = [];
  for (const id of PROVIDER_IDS) {
    const provider = resolveShadowProvider(id);
    for (const entry of provider.hookContract()) {
      const err = conformanceError(provider, entry);
      if (err) errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new Error(`hook contract conformance failed:\n  ${errors.join("\n  ")}`);
  }
}
