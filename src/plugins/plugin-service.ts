import fs from 'node:fs/promises';
import { scanPluginPackages, type DiscoveredPluginPackage, type PluginPackageFailure } from './plugin-package-scanner';
import { PluginRegistry } from './plugin-registry';
import { PluginStateStore } from './plugin-state-store';
import { PluginSettingsStore } from './plugin-settings-store';
import { PluginCapabilityBroker, type PluginCapabilityRequest, type PluginCapabilityResponse } from './plugin-capability-broker';
import type {
  PluginContribution,
  PluginHealth,
  PluginLifecycleState,
  PluginPermission,
  RegisteredPlugin,
} from './plugin-types';

const MAX_PLUGIN_SOURCE_BYTES = 2 * 1024 * 1024;

export type PluginSummary = {
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  homepage?: string;
  state: PluginLifecycleState;
  contributions: PluginContribution[];
  requestedPermissions: PluginPermission[];
  grantedPermissions: PluginPermission[];
  missingPermissions: PluginPermission[];
  hasMain: boolean;
  health: PluginHealth;
  failureReason?: string;
};

export type PluginDiscoverySnapshot = {
  plugins: PluginSummary[];
  failures: PluginPackageFailure[];
};

function inactiveHealth(pluginId: string, now = Date.now()): PluginHealth {
  return { pluginId, state: 'inactive', updatedAt: now };
}

export class PluginService {
  private readonly registry = new PluginRegistry();
  private readonly packages = new Map<string, DiscoveredPluginPackage>();
  private readonly health = new Map<string, PluginHealth>();
  private readonly broker?: PluginCapabilityBroker;
  private failures: PluginPackageFailure[] = [];
  private initialized = false;

  constructor(
    private readonly pluginsRoot: string,
    private readonly stateStore: PluginStateStore,
    private readonly settingsStore?: PluginSettingsStore,
  ) {
    if (settingsStore) this.broker = new PluginCapabilityBroker(this.registry, settingsStore);
  }

  async init(): Promise<PluginDiscoverySnapshot> {
    if (this.initialized) return this.snapshot();
    if (this.settingsStore) await this.settingsStore.init();
    const scan = await scanPluginPackages(this.pluginsRoot);
    this.failures = scan.failures.map((failure) => ({ ...failure }));
    for (const discovered of scan.packages) {
      try {
        this.registry.register(discovered.manifest);
        this.packages.set(discovered.manifest.id, discovered);
        this.health.set(discovered.manifest.id, inactiveHealth(discovered.manifest.id));
      } catch (error) {
        this.failures.push({
          directory: discovered.rootPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.stateStore.restore(this.registry);
    this.initialized = true;
    return this.snapshot();
  }

  snapshot(): PluginDiscoverySnapshot {
    this.requireInitialized();
    return {
      plugins: this.registry.list().map((plugin) => this.summarize(plugin)),
      failures: this.failures.map((failure) => ({ ...failure })),
    };
  }

  async grant(pluginId: string, permissions: PluginPermission[]): Promise<PluginSummary> {
    this.requireInitialized();
    const plugin = this.registry.grantPermissions(pluginId, permissions);
    await this.stateStore.save(this.registry);
    return this.summarize(plugin);
  }

  async enable(pluginId: string): Promise<PluginSummary> {
    this.requireInitialized();
    const plugin = this.registry.enable(pluginId);
    this.setHealth(pluginId, 'starting', 'Inicializando plugin.');
    await this.stateStore.save(this.registry);
    return this.summarize(plugin);
  }

  async disable(pluginId: string): Promise<PluginSummary> {
    this.requireInitialized();
    this.broker?.cancelPluginWork(pluginId);
    const plugin = this.registry.disable(pluginId);
    this.health.set(pluginId, inactiveHealth(pluginId));
    await this.stateStore.save(this.registry);
    return this.summarize(plugin);
  }

  async revoke(pluginId: string, permission: PluginPermission): Promise<PluginSummary> {
    this.requireInitialized();
    this.broker?.cancelPluginWork(pluginId);
    const plugin = this.registry.revokePermission(pluginId, permission);
    this.health.set(pluginId, inactiveHealth(pluginId));
    await this.stateStore.save(this.registry);
    return this.summarize(plugin);
  }

  async markHealthy(pluginId: string, message = 'Plugin ativo.'): Promise<PluginSummary> {
    this.requireEnabled(pluginId);
    this.setHealth(pluginId, 'healthy', message);
    return this.summarize(this.registry.get(pluginId)!);
  }

  async markFailed(pluginId: string, reason: string): Promise<PluginSummary> {
    this.requireInitialized();
    this.broker?.cancelPluginWork(pluginId);
    const plugin = this.registry.fail(pluginId, reason);
    this.setHealth(pluginId, 'failed', reason);
    await this.stateStore.save(this.registry);
    return this.summarize(plugin);
  }

  async invoke(pluginId: string, request: PluginCapabilityRequest): Promise<PluginCapabilityResponse> {
    this.requireInitialized();
    if (!this.broker) return { id: request.id, ok: false, error: 'Capability Broker não foi configurado.' };
    return this.broker.invoke(pluginId, request);
  }

  async readMainSource(pluginId: string): Promise<string> {
    this.requireEnabled(pluginId);
    const discovered = this.packages.get(pluginId);
    if (!discovered?.mainPath) throw new Error(`Plugin '${pluginId}' não possui entry point.`);
    const stat = await fs.stat(discovered.mainPath);
    if (!stat.isFile() || stat.size > MAX_PLUGIN_SOURCE_BYTES) throw new Error('Entry point do plugin excede o limite permitido.');
    return fs.readFile(discovered.mainPath, 'utf8');
  }

  listContributionOwners(contribution: PluginContribution): string[] {
    this.requireInitialized();
    return this.registry.listContributionOwners(contribution).map((owner) => owner.pluginId);
  }

  hasPermission(pluginId: string, permission: PluginPermission): boolean {
    this.requireInitialized();
    return this.registry.hasPermission(pluginId, permission);
  }

  getBroker(): PluginCapabilityBroker {
    this.requireInitialized();
    if (!this.broker) throw new Error('Capability Broker não foi configurado.');
    return this.broker;
  }

  private summarize(plugin: RegisteredPlugin): PluginSummary {
    const requestedPermissions = [...plugin.manifest.permissions];
    const grantedPermissions = [...plugin.grantedPermissions];
    return {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
      ...(plugin.manifest.publisher ? { publisher: plugin.manifest.publisher } : {}),
      ...(plugin.manifest.homepage ? { homepage: plugin.manifest.homepage } : {}),
      state: plugin.state,
      contributions: [...plugin.manifest.contributions],
      requestedPermissions,
      grantedPermissions,
      missingPermissions: requestedPermissions.filter((permission) => !grantedPermissions.includes(permission)),
      hasMain: Boolean(plugin.manifest.main),
      health: { ...(this.health.get(plugin.manifest.id) ?? inactiveHealth(plugin.manifest.id)) },
      ...(plugin.failureReason ? { failureReason: plugin.failureReason } : {}),
    };
  }

  private setHealth(pluginId: string, state: PluginHealth['state'], message?: string): void {
    this.health.set(pluginId, {
      pluginId,
      state,
      ...(message ? { message: message.slice(0, 512) } : {}),
      updatedAt: Date.now(),
    });
  }

  private requireEnabled(pluginId: string): void {
    this.requireInitialized();
    if (this.registry.get(pluginId)?.state !== 'enabled') throw new Error(`Plugin '${pluginId}' não está habilitado.`);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Sistema de plugins ainda não foi inicializado.');
  }
}
