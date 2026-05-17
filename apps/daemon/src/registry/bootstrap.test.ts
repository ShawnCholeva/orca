import { describe, expect, it } from 'vitest';
import { PluginRegistry } from './plugin-registry.js';
import { SkillRegistry } from './skill-registry.js';
import { bootstrapRegistries } from './bootstrap.js';

describe('bootstrapRegistries', () => {
  it('registers exactly 3 plugins with correct ids (sorted)', () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    bootstrapRegistries({ plugins, skills });

    const list = plugins.list();
    expect(list).toHaveLength(3);
    expect(list.map((p) => p.id)).toEqual([
      'orca.default-skills',
      'orca.shell-manual',
      'orca.sqlite',
    ]);
  });

  it('registers plugins with correct capabilities', () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    bootstrapRegistries({ plugins, skills });

    expect(plugins.byId('orca.sqlite')?.capabilities).toEqual(['storage']);
    expect(plugins.byId('orca.default-skills')?.capabilities).toEqual(['skill.provider']);
    expect(plugins.byId('orca.shell-manual')?.capabilities).toEqual(['agent.adapter']);
  });

  it('registers exactly 1 skill with correct id and extensionPoint', () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    bootstrapRegistries({ plugins, skills });

    const list = skills.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('quick-goal');
    expect(list[0]?.extensionPoint).toBe('goal.create');
  });

  it('freezes both registries after bootstrap', () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    bootstrapRegistries({ plugins, skills });

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

  it('throws on second call with the same registry pair (duplicate id)', () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    bootstrapRegistries({ plugins, skills });

    // throws because registries are frozen after the first call
    expect(() => bootstrapRegistries({ plugins, skills })).toThrow();
  });
});
