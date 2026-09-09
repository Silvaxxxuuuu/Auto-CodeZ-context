import { scanPluginPackages, type PluginPackageFailure } from './plugin-package-scanner';
import { PluginRegistry } from './plugin-registry';
import { PluginStateStore } from './plugin-state-store';
import type {
  PluginContribution,
  PluginLifecycleState,
  PluginPermission,
  RegisteredPlugin,
} from './plugin-types';

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
  failureReason?: string;
};

export type PluginDiscoverySnapshot = {
  plugins: PluginSummary[];
  failures: PluginPackageFailure[];
};

function summarize(plugin: RegisteredPlugin): PluginSummary {
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
    ...(plugin.failureReason ? { failureReason: plugin.failureReason } : {}),
  };
}

export class PluginService {
  private readonly registry = new PluginRegistry();
  private readonly stateStore: PluginStateStore;
  private failures: PluginPackageFailure[] = [];
  private initialized = false;

  constructor(
    private readonly pluginsRoot: string,
    stateStore: PluginStateStore,
  ) {
    this.stateStore = stateStore;
  }

  async init(): Promise<PluginDiscoverySnapshot> {
    if (this.initialized) return this.snapshot();
    const scan = await scanPluginPackages(this.pluginsRoot);
    this.failures = scan.failures.map((failure) => ({ ...failure }));
    for (const discovered of scan.packages) {
      try {
        this.registry.register(discovered.manifest);
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
      plugins: this.registry.list().map(summarize),
      failures: this.failures.map((failure) => ({ ...failure })),
    };
  }

  async grant(pluginId: string, permissions: PluginPermission[]): Promise<PluginSummary> {
    this.requireInitialized();
    const plugin = this.registry.grantPermissions(pluginId, permissions);
    await this.stateStore.save(this.registry);
    return summarize(plugin);
  }

  async enable(pluginId: string): Promise<PluginSummary> {
    this.requireInitialized();
    const plugin = this.registry.enable(pluginId);
    await this.stateStore.save(this.registry);
    return summarize(plugin);
  }

  async disable(pluginId: string): Promise<PluginSummary> {
    this.requireInitialized();
    const plugin = this.registry.disable(pluginId);
    await this.stateStore.save(this.registry);
    return summarize(plugin);
  }

  async revoke(pluginId: string, permission: PluginPermission): Promise<PluginSummary> {
    this.requireInitialized();
    const plugin = this.registry.revokePermission(pluginId, permission);
    await this.stateStore.save(this.registry);
    return summarize(plugin);
  }

  listContributionOwners(contribution: PluginContribution): string[] {
    this.requireInitialized();
    return this.registry.listContributionOwners(contribution).map((owner) => owner.pluginId);
  }

  hasPermission(pluginId: string, permission: PluginPermission): boolean {
    this.requireInitialized();
    return this.registry.hasPermission(pluginId, permission);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Sistema de plugins ainda não foi inicializado.');
  }
}
