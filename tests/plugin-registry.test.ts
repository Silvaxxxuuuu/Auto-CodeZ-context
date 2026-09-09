import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePluginManifest } from '../src/plugins/plugin-manifest';
import { PluginRegistry } from '../src/plugins/plugin-registry';
import { PLUGIN_API_VERSION } from '../src/plugins/plugin-types';

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: PLUGIN_API_VERSION,
    id: 'example.plugin',
    name: 'Example Plugin',
    version: '1.2.3',
    description: 'Fixture plugin',
    homepage: 'https://example.com/plugin',
    main: 'dist/main.js',
    contributions: ['tool', 'right-sidebar'],
    permissions: ['ai:tool', 'ui:contribute'],
    ...overrides,
  };
}

test('plugin manifest validation normalizes safe metadata and deduplicates declared capabilities', () => {
  const parsed = validatePluginManifest(manifest({
    id: 'EXAMPLE.PLUGIN',
    contributions: ['tool', 'tool', 'right-sidebar'],
    permissions: ['ai:tool', 'ai:tool', 'ui:contribute'],
  }));
  assert.equal(parsed.id, 'example.plugin');
  assert.equal(parsed.homepage, 'https://example.com/plugin');
  assert.deepEqual(parsed.contributions, ['tool', 'right-sidebar']);
  assert.deepEqual(parsed.permissions, ['ai:tool', 'ui:contribute']);
});

test('plugin manifest validation fails closed for incompatible API, traversal and unknown permissions', () => {
  assert.throws(() => validatePluginManifest(manifest({ apiVersion: 999 })), /API incompatível/i);
  assert.throws(() => validatePluginManifest(manifest({ main: '../outside.js' })), /caminho inválido/i);
  assert.throws(() => validatePluginManifest(manifest({ homepage: 'http://example.com' })), /HTTPS/i);
  assert.throws(() => validatePluginManifest(manifest({ permissions: ['system:everything'] })), /permissions/i);
});

test('plugin contributions require the explicit permission that authorizes the host capability', () => {
  assert.throws(
    () => validatePluginManifest(manifest({ contributions: ['tool'], permissions: [] })),
    /ai:tool/i,
  );
  assert.throws(
    () => validatePluginManifest(manifest({ contributions: ['provider'], permissions: ['ui:contribute'] })),
    /ai:provider/i,
  );
  assert.throws(
    () => validatePluginManifest(manifest({ contributions: ['right-sidebar'], permissions: ['ai:tool'] })),
    /ui:contribute/i,
  );
});

test('registry owns lifecycle and exposes contributions only from enabled plugins', () => {
  const registry = new PluginRegistry();
  const registered = registry.register(manifest(), 100);
  assert.equal(registered.state, 'registered');
  assert.deepEqual(registry.listContributionOwners('tool'), []);

  const enabled = registry.enable('example.plugin', 200);
  assert.equal(enabled.state, 'enabled');
  assert.deepEqual(registry.listContributionOwners('tool'), [{ pluginId: 'example.plugin', contribution: 'tool' }]);
  assert.equal(registry.hasPermission('example.plugin', 'ai:tool'), true);
  assert.equal(registry.hasPermission('example.plugin', 'workspace:write'), false);

  registry.disable('example.plugin', 300);
  assert.deepEqual(registry.listContributionOwners('tool'), []);
  assert.equal(registry.hasPermission('example.plugin', 'ai:tool'), false);
});

test('registry rejects duplicate identity, isolates returned objects and supports clean unregister', () => {
  const registry = new PluginRegistry();
  registry.register(manifest());
  assert.throws(() => registry.register(manifest()), /já está registrado/i);

  const first = registry.get('example.plugin');
  assert.ok(first);
  first.manifest.permissions.push('workspace:write');
  assert.equal(registry.get('example.plugin')?.manifest.permissions.includes('workspace:write'), false);

  assert.equal(registry.unregister('example.plugin'), true);
  assert.equal(registry.unregister('example.plugin'), false);
  assert.equal(registry.get('example.plugin'), undefined);
});

test('registry keeps plugin failures explicit and clears them on a deliberate state transition', () => {
  const registry = new PluginRegistry();
  registry.register(manifest(), 10);
  const failed = registry.fail('example.plugin', 'Activation crashed', 20);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failureReason, 'Activation crashed');

  const enabled = registry.enable('example.plugin', 30);
  assert.equal(enabled.state, 'enabled');
  assert.equal(enabled.failureReason, undefined);
});
