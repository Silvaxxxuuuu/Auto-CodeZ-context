import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { PluginActivityRuntime } from '../src/plugins/plugin-activity-runtime';
import { PluginCapabilityBroker } from '../src/plugins/plugin-capability-broker';
import { PluginJobRuntime } from '../src/plugins/plugin-job-runtime';
import { PluginLocalBridgeRuntime, validatePluginLocalBridgeUrl } from '../src/plugins/plugin-local-bridge';
import { PluginRegistry } from '../src/plugins/plugin-registry';
import { PluginSettingsStore } from '../src/plugins/plugin-settings-store';
import { pluginToolCatalog } from '../src/plugins/plugin-tool-catalog';

class MemoryStorage {
  data = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> { return structuredClone((this.data.get(name) ?? fallback) as T); }
  async write<T>(name: string, value: T): Promise<void> { this.data.set(name, structuredClone(value)); }
}

function enabledRegistry(permissions: Array<'network:localhost' | 'network:fetch' | 'background:run' | 'ai:tool'> = []): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({
    apiVersion: 1,
    id: 'test.plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    contributions: permissions.includes('ai:tool') ? ['tool'] : [],
    permissions,
  });
  registry.grantPermissions('test.plugin', permissions);
  registry.enable('test.plugin');
  return registry;
}

test.afterEach(() => {
  pluginToolCatalog.clear('test.plugin');
});

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
  assert.throws(() => validatePluginLocalBridgeUrl('http://127.0.0.1:80/api'), /porta/i);

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

test('capability broker registers only strict tools after ai:tool grant', async () => {
  const storage = new MemoryStorage();
  const settings = new PluginSettingsStore(storage);
  await settings.init();
  const registry = enabledRegistry(['ai:tool']);
  const broker = new PluginCapabilityBroker(registry, settings);

  const registered = await broker.invoke('test.plugin', {
    id: 'req-tools',
    method: 'tools.register',
    input: {
      tools: [{
        id: 'inspect_scene',
        description: 'Inspect the connected application scene.',
        risk: 'read',
        parameters: {
          type: 'object',
          properties: { scope: { type: 'string' } },
          required: ['scope'],
          additionalProperties: false,
        },
      }],
    },
  });

  assert.equal(registered.ok, true);
  const definitions = pluginToolCatalog.listDefinitions('test.plugin');
  assert.equal(definitions.length, 1);
  assert.match(definitions[0].name, /^plugin_[a-f0-9]{10}_inspect_scene$/);
  assert.equal(definitions[0].requiresWriteAccess, false);
  assert.equal(definitions[0].requiresApproval, false);

  const invalid = await broker.invoke('test.plugin', {
    id: 'req-bad-tool',
    method: 'tools.register',
    input: {
      tools: [{
        id: 'bad_tool',
        description: 'Invalid loose schema.',
        risk: 'read',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: [],
          additionalProperties: true,
        },
      }],
    },
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error ?? '', /additionalProperties=false/);
  assert.equal(pluginToolCatalog.listDefinitions('test.plugin').length, 0);
});

test('tool catalog validates arguments before invoking the sandbox executor', async () => {
  let executions = 0;
  pluginToolCatalog.configureExecutor(async (_pluginId, toolId, input) => {
    executions += 1;
    return { toolId, input };
  });
  const [definition] = pluginToolCatalog.register('test.plugin', [{
    id: 'read_state',
    description: 'Read state from an external local integration.',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false,
    },
  }]);

  const rejected = await pluginToolCatalog.execute(definition.name, { target: 'workspace', extra: true }, {
    chatId: 'chat-a',
    projectId: 'project-a',
    permission: 'unrestricted',
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? '', /não permitido/);
  assert.equal(executions, 0);

  const accepted = await pluginToolCatalog.execute(definition.name, { target: 'workspace' }, {
    chatId: 'chat-a',
    projectId: 'project-a',
    permission: 'unrestricted',
  });
  assert.equal(accepted.ok, true);
  assert.equal(executions, 1);
  assert.deepEqual(JSON.parse(accepted.output ?? '{}'), {
    toolId: 'read_state',
    input: { target: 'workspace' },
  });
});
