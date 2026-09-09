export const PLUGIN_API_VERSION = 1 as const;

export type PluginContribution =
  | 'left-sidebar'
  | 'right-sidebar'
  | 'command'
  | 'provider'
  | 'tool'
  | 'theme';

export type PluginPermission =
  | 'workspace:read'
  | 'workspace:write'
  | 'terminal:execute'
  | 'git:read'
  | 'git:write'
  | 'network:fetch'
  | 'secrets:use'
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
  registeredAt: number;
  updatedAt: number;
  failureReason?: string;
}

export interface PluginContributionOwner {
  pluginId: string;
  contribution: PluginContribution;
}
