import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PluginRegistry, pluginRegistry } from './plugin-registry.js';
import { SkillRegistry, skillRegistry } from './skill-registry.js';
import { quickGoalSkill } from '../skills/quick-goal.js';
import { guidedGoalRefinementSkill } from '../skills/guided-goal-refinement.js';
import { AdapterRegistry, adapterRegistry } from '../adapters/registry.js';
import { ShellManualAdapter } from '../adapters/shell-manual.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { CodexAdapter } from '../adapters/codex.js';

// Sidecar (CJS-bundled SEA) sets ORCA_DAEMON_VERSION at build time; fall back
// to reading package.json at the source-tree path otherwise.
function readPackageVersion(): string {
  if (process.env.ORCA_DAEMON_VERSION) return process.env.ORCA_DAEMON_VERSION;
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export function bootstrapRegistries(registries?: {
  plugins: PluginRegistry;
  skills: SkillRegistry;
  adapters?: AdapterRegistry;
}): void {
  const plugins = registries?.plugins ?? pluginRegistry;
  const skills = registries?.skills ?? skillRegistry;
  const adapters = registries?.adapters ?? adapterRegistry;

  const version = readPackageVersion();

  try {
    plugins.register({ id: 'orca.sqlite', name: 'Orca SQLite', version, capabilities: ['storage'] });
    plugins.register({ id: 'orca.default-skills', name: 'Orca Default Skills', version, capabilities: ['skill.provider'] });
    plugins.register({ id: 'orca.shell-manual', name: 'Shell (Manual)', version, capabilities: ['agent.adapter'] });

    skills.register(quickGoalSkill);
    skills.register(guidedGoalRefinementSkill);

    adapters.register(new ShellManualAdapter());
    adapters.register(new ClaudeCodeAdapter());
    adapters.register(new OpenCodeAdapter());
    adapters.register(new CodexAdapter());

    plugins.freeze();
    skills.freeze();
    console.info(
      `registries.bootstrap.ok plugins=${plugins.list().length} skills=${skills.list().length}`
    );
  } catch (err) {
    console.error('[orca-daemon] registry bootstrap failed:', err);
    throw err;
  }
}
