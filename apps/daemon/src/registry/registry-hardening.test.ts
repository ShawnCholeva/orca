import { describe, expect, it } from "vitest";

import { bootstrapRegistries } from "./bootstrap.js";
import { PluginRegistry } from "./plugin-registry.js";
import { SkillRegistry } from "./skill-registry.js";
import { AdapterRegistry } from "../adapters/registry.js";

describe("registry hardening", () => {
  it("throws on register-after-freeze for both registries", () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    plugins.register({
      id: "plugin.one",
      name: "Plugin One",
      version: "0.0.0",
      capabilities: ["storage"],
    });
    skills.register({
      id: "skill.one",
      pluginId: "plugin.one",
      extensionPoint: "goal.create",
      title: "Skill One",
      description: "test",
      invoke: () => ({}),
    });

    plugins.freeze();
    skills.freeze();

    expect(() => {
      plugins.register({
        id: "plugin.two",
        name: "Plugin Two",
        version: "0.0.0",
        capabilities: ["agent.adapter"],
      });
    }).toThrowError("PluginRegistry is frozen");

    expect(() => {
      skills.register({
        id: "skill.two",
        pluginId: "plugin.one",
        extensionPoint: "goal.create",
        title: "Skill Two",
        description: "test",
        invoke: () => ({}),
      });
    }).toThrowError("SkillRegistry is frozen");
  });

  it("fails fast when bootstrap hits a duplicate built-in plugin id", () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    plugins.register({
      id: "orca.sqlite",
      name: "Pre-registered",
      version: "0.0.0",
      capabilities: ["storage"],
    });

    expect(() => bootstrapRegistries({ plugins, skills })).toThrowError(
      "Duplicate plugin id: orca.sqlite"
    );
  });

  it("throws on attempted re-bootstrap with the same registry pair", () => {
    const plugins = new PluginRegistry();
    const skills = new SkillRegistry();

    bootstrapRegistries({ plugins, skills });

    expect(() => bootstrapRegistries({ plugins, skills })).toThrowError("PluginRegistry is frozen");
  });

  it("freezes the adapter registry after bootstrap; rejects duplicate ids before freeze", () => {
    const adapters = new AdapterRegistry();
    bootstrapRegistries({ plugins: new PluginRegistry(), skills: new SkillRegistry(), adapters });

    expect(() =>
      adapters.register({
        id: 'codex' as const,
        title: 'Fake',
        supportedExecutionModes: ["one_shot", "shadow_session"] as const,
        contextDelivery: { mode: 'preview_only' as const, maxBytes: 32768 },
        resolveSpawn: async () => ({ command: '', args: [], env: {}, cwd: '' }),
        probeAvailability: async () => ({ status: 'unknown' as const }),
        checkInstalled: async () => ({ name: 'installed' as const, ok: true, command: '' }),
        checkAuth: async () => ({ name: 'authenticated' as const, ok: true, authStatus: 'ready' as const, command: '' }),
        repairFor: () => undefined,
      })
    ).toThrowError("AdapterRegistry is frozen");
  });

  it("rejects duplicate adapter id before freeze", () => {
    const adapters = new AdapterRegistry();
    adapters.register({
      id: 'shell-manual' as const,
      title: 'First',
      supportedExecutionModes: ["shadow_session"] as const,
      contextDelivery: { mode: 'preview_only' as const, maxBytes: 32768 },
      resolveSpawn: async () => ({ command: '', args: [], env: {}, cwd: '' }),
      probeAvailability: async () => ({ status: 'unknown' as const }),
      checkInstalled: async () => ({ name: 'installed' as const, ok: true, command: '' }),
      checkAuth: async () => ({ name: 'authenticated' as const, ok: true, authStatus: 'ready' as const, command: '' }),
      repairFor: () => undefined,
    });

    expect(() =>
      adapters.register({
        id: 'shell-manual' as const,
        title: 'Duplicate',
        supportedExecutionModes: ["shadow_session"] as const,
        contextDelivery: { mode: 'preview_only' as const, maxBytes: 32768 },
        resolveSpawn: async () => ({ command: '', args: [], env: {}, cwd: '' }),
        probeAvailability: async () => ({ status: 'unknown' as const }),
        checkInstalled: async () => ({ name: 'installed' as const, ok: true, command: '' }),
        checkAuth: async () => ({ name: 'authenticated' as const, ok: true, authStatus: 'ready' as const, command: '' }),
        repairFor: () => undefined,
      })
    ).toThrowError("Duplicate adapter id: shell-manual");
  });
});
