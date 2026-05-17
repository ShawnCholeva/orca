import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PluginRegistry, pluginRegistry } from './plugin-registry.js';
import { SkillRegistry, skillRegistry } from './skill-registry.js';
import { quickGoalSkill } from '../skills/quick-goal.js';

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
}): void {
  const plugins = registries?.plugins ?? pluginRegistry;
  const skills = registries?.skills ?? skillRegistry;

  const version = readPackageVersion();

  try {
    plugins.register({ id: 'orca.sqlite', name: 'Orca SQLite', version, capabilities: ['storage'] });
    plugins.register({ id: 'orca.default-skills', name: 'Orca Default Skills', version, capabilities: ['skill.provider'] });
    plugins.register({ id: 'orca.shell-manual', name: 'Shell (Manual)', version, capabilities: ['agent.adapter'] });

    skills.register(quickGoalSkill);

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
