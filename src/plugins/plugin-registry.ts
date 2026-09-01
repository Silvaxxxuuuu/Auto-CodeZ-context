export type PluginContribution = 'left-sidebar' | 'right-sidebar' | 'command' | 'provider' | 'tool' | 'theme';

export interface AutoCodeZPlugin {
  id: string;
  name: string;
  version: string;
  contributions: PluginContribution[];
}

export class PluginRegistry {
  private readonly plugins = new Map<string, AutoCodeZPlugin>();

  register(plugin: AutoCodeZPlugin): void {
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin '${plugin.id}' já está registrado.`);
    this.plugins.set(plugin.id, plugin);
  }

  list(): AutoCodeZPlugin[] {
    return [...this.plugins.values()];
  }
}
