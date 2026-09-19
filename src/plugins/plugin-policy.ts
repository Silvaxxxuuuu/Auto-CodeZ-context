import type { PluginContribution, PluginManifest, PluginPermission } from './plugin-types';

const CONTRIBUTION_PERMISSIONS: Readonly<Partial<Record<PluginContribution, PluginPermission>>> = {
  'left-sidebar': 'ui:contribute',
  'right-sidebar': 'ui:contribute',
  command: 'ui:contribute',
  provider: 'ai:provider',
  tool: 'ai:tool',
  theme: 'ui:contribute',
};

export function requiredPermissionForContribution(contribution: PluginContribution): PluginPermission | undefined {
  return CONTRIBUTION_PERMISSIONS[contribution];
}

export function validatePluginContributionPermissions(manifest: PluginManifest): void {
  for (const contribution of manifest.contributions) {
    const required = requiredPermissionForContribution(contribution);
    if (required && !manifest.permissions.includes(required)) {
      throw new Error(`Plugin '${manifest.id}' declara '${contribution}' sem a permissão '${required}'.`);
    }
  }
}

export function canPluginUsePermission(manifest: PluginManifest, permission: PluginPermission): boolean {
  return manifest.permissions.includes(permission);
}
