import { describe, expect, it } from 'vitest';
import { PluginRegistry } from './plugin-registry.js';
import { SkillRegistry } from './skill-registry.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { bootstrapRegistries } from './bootstrap.js';

function makeRegistries() {
  return {
    plugins: new PluginRegistry(),
    skills: new SkillRegistry(),
    adapters: new AdapterRegistry(),
  };
}

describe('bootstrapRegistries', () => {
  it('registers exactly 3 plugins with correct ids (sorted)', () => {
    const { plugins, skills, adapters } = makeRegistries();

    bootstrapRegistries({ plugins, skills, adapters });

    const list = plugins.list();
    expect(list).toHaveLength(3);
    expect(list.map((p) => p.id)).toEqual([
      'orca.default-skills',
      'orca.shell-manual',
      'orca.sqlite',
    ]);
  });

  it('registers plugins with correct capabilities', () => {
    const { plugins, skills, adapters } = makeRegistries();

    bootstrapRegistries({ plugins, skills, adapters });

    expect(plugins.byId('orca.sqlite')?.capabilities).toEqual(['storage']);
    expect(plugins.byId('orca.default-skills')?.capabilities).toEqual(['skill.provider']);
    expect(plugins.byId('orca.shell-manual')?.capabilities).toEqual(['agent.adapter']);
  });

  it('registers exactly 2 skills with correct ids and extensionPoints', () => {
    const { plugins, skills, adapters } = makeRegistries();

    bootstrapRegistries({ plugins, skills, adapters });

    const list = skills.list();
    expect(list).toHaveLength(2);
    // list() returns sorted by id
    expect(list[0]?.id).toBe('guided-goal-refinement');
    expect(list[0]?.extensionPoint).toBe('goal.refine');
    expect(list[1]?.id).toBe('quick-goal');
    expect(list[1]?.extensionPoint).toBe('goal.create');
  });

  it('registers all four agent adapters', () => {
    const { plugins, skills, adapters } = makeRegistries();

    bootstrapRegistries({ plugins, skills, adapters });

    expect(adapters.get('shell-manual')).toBeDefined();
    expect(adapters.get('claude-code')).toBeDefined();
    expect(adapters.get('opencode')).toBeDefined();
    expect(adapters.get('codex')).toBeDefined();
  });

  it('registered adapters have correct ids', async () => {
    const { plugins, skills, adapters } = makeRegistries();

    bootstrapRegistries({ plugins, skills, adapters });

    const list = await adapters.list();
    const ids = list.map((a) => a.id).sort();
    expect(ids).toEqual(['claude-code', 'codex', 'opencode', 'shell-manual']);
  });

  it('freezes both plugin and skill registries after bootstrap', () => {
    const { plugins, skills, adapters } = makeRegistries();

    bootstrapRegistries({ plugins, skills, adapters });

    expect(() =>
      plugins.register({ id: 'extra.plugin', name: 'Extra', version: '0.0.0', capabilities: [] })
    ).toThrow();

    expect(() =>
      skills.register({
        id: 'extra-skill',
        pluginId: 'extra.plugin',
        extensionPoint: 'goal.create',
        title: 'Extra',
        description: 'Extra skill',
        invoke: () => ({}),
      })
    ).toThrow();
  });

  it('throws on second call with the same plugin registry (duplicate id)', () => {
    const { plugins, skills, adapters } = makeRegistries();

    bootstrapRegistries({ plugins, skills, adapters });

    // throws because plugin registry is frozen after the first call
    expect(() => bootstrapRegistries({ plugins, skills, adapters: new AdapterRegistry() })).toThrow();
  });
});
