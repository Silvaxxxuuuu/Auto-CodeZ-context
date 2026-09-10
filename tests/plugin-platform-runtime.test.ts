import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { PluginActivityRuntime } from '../src/plugins/plugin-activity-runtime';
import { PluginCapabilityBroker } from '../src/plugins/plugin-capability-broker';
import { PluginJobRuntime } from '../src/plugins/plugin-job-runtime';
import { PluginLocalBridgeRuntime, validatePluginLocalBridgeUrl } from '../src/plugins/plugin-local-bridge';
import { PluginRegistry } from '../src/plugins/plugin-registry';
import { PluginSettingsStore } from '../src/plugins/plugin-settings-store';

class MemoryStorage {
  data = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> { return structuredClone((this.data.get(name) ?? fallback) as T); }
  async write<T>(name: string, value: T): Promise<void> { this.data.set(name, structuredClone(value)); }
}

function enabledRegistry(permissions: Array<'network:localhost' | 'network:fetch' | 'background:run'> = []): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({
    apiVersion: 1,
    id: 'test.plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    contributions: [],
    permissions,
  });
  registry.grantPermissions('test.plugin', permissions);
  registry.enable('test.plugin');
  return registry;
}

test('plugin settings remain namespaced, bounded and independent between plugins', async () => {
  const storage = new MemoryStorage();
  const settings = new PluginSettingsStore(storage);
  await settings.init();
  await settings.set('test.plugin', 'endpoint', 'http://localhost:3000');
  await settings.set('other.plugin', 'endpoint', 'http://localhost:4000');
  assert.equal(settings.get('test.plugin', 'endpoint'), 'http://localhost:3000');
  assert.equal(settings.get('other.plugin', 'endpoint'), 'http://localhost:4000');
  await assert.rejects(() => settings.set('test.plugin', '../bad', true), /Chave/);
  await assert.rejects(() => settings.set('test.plugin', 'huge', 'x'.repeat(70 * 1024)), /64 KB/);
});

test('plugin activity exposes only one current activity per plugin', () => {
  const runtime = new PluginActivityRuntime();
  runtime.publish('test.plugin', 'Conectando ao Studio...');
  runtime.publish('test.plugin', 'Lendo a cena...');
  assert.equal(runtime.list().length, 1);
  assert.equal(runtime.get('test.plugin')?.message, 'Lendo a cena...');
});

test('plugin jobs publish progress, complete and isolate listener failures', async () => {
  const jobs = new PluginJobRuntime();
  jobs.subscribe(() => { throw new Error('observer failure'); });
  const completed = new Promise<void>((resolve) => {
    const unsubscribe = jobs.subscribe((snapshot) => {
      if (snapshot.state === 'completed') {
        unsubscribe();
        resolve();
      }
    });
  });
  const started = jobs.start('test.plugin', 'Gerando terreno', async (context) => {
    context.setProgress(0.5, 'Metade concluída');
  });
  await completed;
  const final = jobs.get('test.plugin', started.id);
  assert.equal(final?.state, 'completed');
  assert.equal(final?.progress, 1);
  assert.equal(final?.activity, 'Metade concluída');
});

test('local plugin bridge rejects non-loopback destinations and redirects', async () => {
  assert.equal(validatePluginLocalBridgeUrl('http://127.0.0.1:4567/api'), 'http://127.0.0.1:4567/api');
  assert.throws(() => validatePluginLocalBridgeUrl('http://192.168.1.10:4567/api'), /loopback/);
  assert.throws(() => validatePluginLocalBridgeUrl('https://example.com:443/api'), /loopback/);
  assert.throws(() => validatePluginLocalBridgeUrl('http://127.0.0.1:80/api'), /Porta/);

  const server = http.createServer((_request, response) => {
    response.writeHead(302, { location: 'https://example.com/' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const runtime = new PluginLocalBridgeRuntime();
  await assert.rejects(() => runtime.request({ url: `http://127.0.0.1:${address.port}/` }), /Redirects/);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('capability broker enforces plugin grants before executing localhost access', async () => {
  const storage = new MemoryStorage();
  const settings = new PluginSettingsStore(storage);
  await settings.init();
  const registry = enabledRegistry([]);
  const broker = new PluginCapabilityBroker(registry, settings);

  const denied = await broker.invoke('test.plugin', {
    id: 'req-1',
    method: 'bridge.request',
    input: { url: 'http://127.0.0.1:4567/' },
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /network:localhost/);

  const saved = await broker.invoke('test.plugin', {
    id: 'req-2',
    method: 'settings.set',
    input: { key: 'mode', value: 'safe' },
  });
  assert.equal(saved.ok, true);
  assert.equal(settings.get('test.plugin', 'mode'), 'safe');
});
