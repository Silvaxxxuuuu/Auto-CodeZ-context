import { validatePluginManifest } from './plugin-manifest';
import type {
  PluginContribution,
  PluginContributionOwner,
  PluginLifecycleState,
  PluginManifest,
  PluginPermission,
  RegisteredPlugin,
} from './plugin-types';

export type { PluginContribution, PluginManifest, PluginPermission, RegisteredPlugin } from './plugin-types';
export type AutoCodeZPlugin = PluginManifest;

function cloneManifest(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    contributions: [...manifest.contributions],
    permissions: [...manifest.permissions],
  };
}

function clonePlugin(plugin: RegisteredPlugin): RegisteredPlugin {
  return {
    ...plugin,
    manifest: cloneManifest(plugin.manifest),
    grantedPermissions: [...plugin.grantedPermissions],
  };
}

function uniqueRequestedPermissions(manifest: PluginManifest, permissions: PluginPermission[]): PluginPermission[] {
  const requested = new Set(manifest.permissions);
  const output: PluginPermission[] = [];
  for (const permission of permissions) {
    if (!requested.has(permission)) throw new Error(`Plugin '${manifest.id}' não solicitou a permissão '${permission}'.`);
    if (!output.includes(permission)) output.push(permission);
  }
  return output;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();

  register(input: unknown, now = Date.now()): RegisteredPlugin {
    const manifest = validatePluginManifest(input);
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin '${manifest.id}' já está registrado.`);
    }
    const plugin: RegisteredPlugin = {
      manifest,
      state: 'registered',
      grantedPermissions: [],
      registeredAt: now,
      updatedAt: now,
    };
    this.plugins.set(manifest.id, plugin);
    return clonePlugin(plugin);
  }

  unregister(pluginId: string): boolean {
    return this.plugins.delete(pluginId);
  }

  grantPermissions(pluginId: string, permissions: PluginPermission[], now = Date.now()): RegisteredPlugin {
    const plugin = this.require(pluginId);
    plugin.grantedPermissions = uniqueRequestedPermissions(plugin.manifest, permissions);
    plugin.updatedAt = now;
    if (plugin.state === 'enabled' && !this.hasAllRequiredPermissions(plugin)) plugin.state = 'disabled';
    return clonePlugin(plugin);
  }

  revokePermission(pluginId: string, permission: PluginPermission, now = Date.now()): RegisteredPlugin {
    const plugin = this.require(pluginId);
    plugin.grantedPermissions = plugin.grantedPermissions.filter((item) => item !== permission);
    plugin.updatedAt = now;
    if (plugin.state === 'enabled') plugin.state = 'disabled';
    return clonePlugin(plugin);
  }

  enable(pluginId: string, now = Date.now()): RegisteredPlugin {
    const plugin = this.require(pluginId);
    const missing = plugin.manifest.permissions.filter((permission) => !plugin.grantedPermissions.includes(permission));
    if (missing.length) {
      throw new Error(`Plugin '${plugin.manifest.id}' ainda não recebeu as permissões solicitadas: ${missing.join(', ')}.`);
    }
    return this.transition(pluginId, 'enabled', now);
  }

  disable(pluginId: string, now = Date.now()): RegisteredPlugin {
    return this.transition(pluginId, 'disabled', now);
  }

  fail(pluginId: string, reason: string, now = Date.now()): RegisteredPlugin {
    const normalized = reason.trim();
    if (!normalized) throw new Error('Falha de plugin precisa de um motivo.');
    const plugin = this.require(pluginId);
    plugin.state = 'failed';
    plugin.failureReason = normalized.slice(0, 2048);
    plugin.updatedAt = now;
    return clonePlugin(plugin);
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    const plugin = this.plugins.get(pluginId);
    return plugin ? clonePlugin(plugin) : undefined;
  }

  list(): RegisteredPlugin[] {
    return [...this.plugins.values()]
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.manifest.id.localeCompare(b.manifest.id))
      .map(clonePlugin);
  }

  listEnabled(): RegisteredPlugin[] {
    return this.list().filter((plugin) => plugin.state === 'enabled');
  }

  listContributionOwners(contribution: PluginContribution, enabledOnly = true): PluginContributionOwner[] {
    return [...this.plugins.values()]
      .filter((plugin) => (!enabledOnly || plugin.state === 'enabled') && plugin.manifest.contributions.includes(contribution))
      .map((plugin) => ({ pluginId: plugin.manifest.id, contribution }));
  }

  hasPermission(pluginId: string, permission: PluginPermission): boolean {
    const plugin = this.plugins.get(pluginId);
    return Boolean(
      plugin?.state === 'enabled'
      && plugin.manifest.permissions.includes(permission)
      && plugin.grantedPermissions.includes(permission),
    );
  }

  private hasAllRequiredPermissions(plugin: RegisteredPlugin): boolean {
    return plugin.manifest.permissions.every((permission) => plugin.grantedPermissions.includes(permission));
  }

  private transition(pluginId: string, state: Exclude<PluginLifecycleState, 'failed' | 'registered'>, now: number): RegisteredPlugin {
    const plugin = this.require(pluginId);
    plugin.state = state;
    plugin.updatedAt = now;
    delete plugin.failureReason;
    return clonePlugin(plugin);
  }

  private require(pluginId: string): RegisteredPlugin {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin '${pluginId}' não está registrado.`);
    return plugin;
  }
}
