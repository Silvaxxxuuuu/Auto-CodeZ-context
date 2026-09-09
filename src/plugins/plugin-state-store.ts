import { PluginRegistry } from './plugin-registry';
import type { PersistedPluginState, PluginPermission } from './plugin-types';

const STORAGE_FILE = 'plugins.json';

export interface PluginStateStorage {
  read<T>(name: string, fallback: T): Promise<T>;
  write<T>(name: string, value: T): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parsePersistedState(value: unknown): PersistedPluginState[] {
  if (!Array.isArray(value)) return [];
  const result: PersistedPluginState[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.id !== 'string' || typeof item.version !== 'string' || typeof item.enabled !== 'boolean') continue;
    if (!Array.isArray(item.grantedPermissions) || !item.grantedPermissions.every((permission) => typeof permission === 'string')) continue;
    result.push({
      id: item.id,
      version: item.version,
      enabled: item.enabled,
      grantedPermissions: [...new Set(item.grantedPermissions as PluginPermission[])],
    });
  }
  return result;
}

export class PluginStateStore {
  constructor(private readonly storage: PluginStateStorage) {}

  async restore(registry: PluginRegistry): Promise<void> {
    const persisted = parsePersistedState(await this.storage.read<unknown>(STORAGE_FILE, []));
    for (const state of persisted) {
      const plugin = registry.get(state.id);
      if (!plugin || plugin.manifest.version !== state.version) continue;
      const allowed = state.grantedPermissions.filter((permission) => plugin.manifest.permissions.includes(permission));
      registry.grantPermissions(plugin.manifest.id, allowed);
      if (state.enabled && plugin.manifest.permissions.every((permission) => allowed.includes(permission))) {
        registry.enable(plugin.manifest.id);
      } else {
        registry.disable(plugin.manifest.id);
      }
    }
  }

  async save(registry: PluginRegistry): Promise<void> {
    const persisted: PersistedPluginState[] = registry.list().map((plugin) => ({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      enabled: plugin.state === 'enabled',
      grantedPermissions: [...plugin.grantedPermissions],
    }));
    await this.storage.write(STORAGE_FILE, persisted);
  }
}
