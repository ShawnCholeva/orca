import { describe, expect, it } from "vitest";

import { PluginRegistry, pluginRegistry } from "./plugin-registry.js";
import type { PluginDescriptor } from "./types.js";

function makePlugin(descriptor: Partial<PluginDescriptor> & Pick<PluginDescriptor, "id">) {
  return {
    name: descriptor.id,
    version: "0.0.1",
    capabilities: [],
    ...descriptor,
  } satisfies PluginDescriptor;
}

describe("PluginRegistry", () => {
  it("registers plugins and lists them sorted by id", () => {
    const registry = new PluginRegistry();

    const bPlugin = makePlugin({ id: "plugin.b", capabilities: ["storage"] });
    const aPlugin = makePlugin({ id: "plugin.a", capabilities: ["agent.adapter"] });

    registry.register(bPlugin);
    registry.register(aPlugin);

    expect(registry.list()).toEqual([aPlugin, bPlugin]);
  });

  it("throws when registering a duplicate id", () => {
    const registry = new PluginRegistry();
    const plugin = makePlugin({ id: "plugin.core" });

    registry.register(plugin);

    expect(() => registry.register(plugin)).toThrowError("Duplicate plugin id: plugin.core");
  });

  it("throws when registering after freeze", () => {
    const registry = new PluginRegistry();

    registry.freeze();

    expect(() => registry.register(makePlugin({ id: "plugin.core" }))).toThrowError(
      "PluginRegistry is frozen"
    );
  });

  it("filters by capability", () => {
    const registry = new PluginRegistry();
    const storagePlugin = makePlugin({ id: "plugin.storage", capabilities: ["storage"] });
    const skillPlugin = makePlugin({
      id: "plugin.skills",
      capabilities: ["skill.provider"],
    });

    registry.register(skillPlugin);
    registry.register(storagePlugin);

    expect(registry.byCapability("storage")).toEqual([storagePlugin]);
  });

  it("looks up plugins by id", () => {
    const registry = new PluginRegistry();
    const plugin = makePlugin({ id: "plugin.match" });

    registry.register(plugin);

    expect(registry.byId("plugin.match")).toEqual(plugin);
    expect(registry.byId("plugin.unknown")).toBeUndefined();
  });
});

describe("pluginRegistry singleton", () => {
  it("exports a module-level instance", () => {
    expect(pluginRegistry).toBeInstanceOf(PluginRegistry);
  });
});
