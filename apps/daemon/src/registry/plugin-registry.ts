import type { PluginCapability, PluginDescriptor } from "./types.js";

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginDescriptor>();
  private frozen = false;

  register(descriptor: PluginDescriptor): void {
    if (this.frozen) {
      throw new Error("PluginRegistry is frozen");
    }

    if (this.plugins.has(descriptor.id)) {
      throw new Error(`Duplicate plugin id: ${descriptor.id}`);
    }

    this.plugins.set(
      descriptor.id,
      Object.freeze({ ...descriptor, capabilities: Object.freeze([...descriptor.capabilities]) as PluginCapability[] }) as PluginDescriptor,
    );
  }

  freeze(): void {
    this.frozen = true;
  }

  list(): PluginDescriptor[] {
    return [...this.plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  byId(id: string): PluginDescriptor | undefined {
    return this.plugins.get(id);
  }

  byCapability(capability: PluginCapability): PluginDescriptor[] {
    return this.list().filter((plugin) => plugin.capabilities.includes(capability));
  }
}

export const pluginRegistry = new PluginRegistry();
