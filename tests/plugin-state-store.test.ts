import assert from 'node:assert/strict';
import test from 'node:test';
import { PluginRegistry } from '../src/plugins/plugin-registry';
import { PluginStateStore, type PluginStateStorage } from '../src/plugins/plugin-state-store';
import { PLUGIN_API_VERSION } from '../src/plugins/plugin-types';

class MemoryStorage implements PluginStateStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return (this.values.has(name) ? this.values.get(name) : fallback) as T;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

function manifest(version = '1.0.0') {
  return {
    apiVersion: PLUGIN_API_VERSION,
    id: 'example.plugin',
    name: 'Example',
    version,
    contributions: ['tool'] as const,
    permissions: ['ai:tool'] as const,
  };
}

test('plugin state store restores grants and enabled state only for the same plugin version', async () => {
  const storage = new MemoryStorage();
  const first = new PluginRegistry();
  first.register(manifest());
  first.grantPermissions('example.plugin', ['ai:tool']);
  first.enable('example.plugin');
  await new PluginStateStore(storage).save(first);

  const restored = new PluginRegistry();
  restored.register(manifest());
  await new PluginStateStore(storage).restore(restored);
  assert.equal(restored.get('example.plugin')?.state, 'enabled');
  assert.deepEqual(restored.get('example.plugin')?.grantedPermissions, ['ai:tool']);

  const upgraded = new PluginRegistry();
  upgraded.register(manifest('2.0.0'));
  await new PluginStateStore(storage).restore(upgraded);
  assert.equal(upgraded.get('example.plugin')?.state, 'registered');
  assert.deepEqual(upgraded.get('example.plugin')?.grantedPermissions, []);
});

test('plugin state store ignores malformed or undeclared persisted grants', async () => {
  const storage = new MemoryStorage();
  await storage.write('plugins.json', [
    { id: 'example.plugin', version: '1.0.0', enabled: true, grantedPermissions: ['ai:tool', 'workspace:write'] },
    { broken: true },
  ]);
  const registry = new PluginRegistry();
  registry.register(manifest());
  await new PluginStateStore(storage).restore(registry);
  assert.equal(registry.get('example.plugin')?.state, 'enabled');
  assert.deepEqual(registry.get('example.plugin')?.grantedPermissions, ['ai:tool']);
});
