export const PLUGIN_API_VERSION = 1 as const;

export type PluginContribution =
  | 'left-sidebar'
  | 'right-sidebar'
  | 'command'
  | 'provider'
  | 'tool'
  | 'theme'
  | 'settings';

export type PluginPermission =
  | 'workspace:read'
  | 'workspace:write'
  | 'terminal:execute'
  | 'git:read'
  | 'git:write'
  | 'network:fetch'
  | 'network:localhost'
  | 'secrets:use'
  | 'background:run'
  | 'ai:provider'
  | 'ai:tool'
  | 'ui:contribute';

export interface PluginManifest {
  apiVersion: typeof PLUGIN_API_VERSION;
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  homepage?: string;
  main?: string;
  contributions: PluginContribution[];
  permissions: PluginPermission[];
}

export type PluginLifecycleState = 'registered' | 'enabled' | 'disabled' | 'failed';

export interface RegisteredPlugin {
  manifest: PluginManifest;
  state: PluginLifecycleState;
  grantedPermissions: PluginPermission[];
  registeredAt: number;
  updatedAt: number;
  failureReason?: string;
}

export interface PluginContributionOwner {
  pluginId: string;
  contribution: PluginContribution;
}

export type PersistedPluginState = {
  id: string;
  version: string;
  enabled: boolean;
  grantedPermissions: PluginPermission[];
};

export type PluginHealthState = 'inactive' | 'starting' | 'healthy' | 'degraded' | 'failed';

export type PluginHealth = {
  pluginId: string;
  state: PluginHealthState;
  message?: string;
  updatedAt: number;
};

export type PluginJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type PluginJobSnapshot = {
  id: string;
  pluginId: string;
  label: string;
  state: PluginJobState;
  progress?: number;
  activity?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};
