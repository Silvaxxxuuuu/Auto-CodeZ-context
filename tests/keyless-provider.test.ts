import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderManager } from '../src/ai/provider-manager';
import { ModelResolver } from '../src/ai/model-resolver';
import { ProviderRegistry } from '../src/ai/provider-registry';
import type { AIProviderAdapter } from '../src/ai/types';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  private readonly encrypted = new Map<string, string>();
  async read<T>(name: string, fallback: T): Promise<T> { return (this.values.get(name) as T | undefined) ?? fallback; }
  async write<T>(name: string, value: T): Promise<void> { this.values.set(name, value); }
  async readEncrypted(name: string): Promise<string | null> { return this.encrypted.get(name) ?? null; }
  async writeEncrypted(name: string, value: string): Promise<void> { this.encrypted.set(name, value); }
}

function keylessAdapter(): AIProviderAdapter {
  return {
    id: 'local-test',
    displayName: 'Local Test',
    requiresApiKey: false,
    fallbackCapabilities: ['text', 'streaming'],
    listModels: async () => [{ id: 'local-model', name: 'Local Model', providerId: 'local-test', capabilities: ['text', 'streaming'] }],
    send: async () => ({ content: 'ok', model: 'local-model', providerId: 'local-test' }),
  };
}

test('keyless providers are configured without creating a fake API key', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(keylessAdapter());
  await manager.init();

  const summary = (await manager.list()).find((provider) => provider.id === 'local-test');
  assert.equal(summary?.configured, true);
  assert.equal(summary?.apiKeyConfigured, false);
  assert.equal(summary?.requiresApiKey, false);
  assert.equal(manager.getConfig('local-test').apiKey, '');
  assert.equal((await manager.listKeys()).some((key) => key.providerId === 'local-test'), false);
});

test('named API-key storage rejects keyless providers instead of persisting placeholder secrets', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(keylessAdapter());
  await manager.init();

  await assert.rejects(
    () => manager.saveKey({ providerId: 'local-test', name: 'Local', apiKey: 'placeholder' }),
    /não utiliza API key/i,
  );
  assert.equal((await manager.listKeys()).length, 0);
});

test('keyless provider model discovery works with an empty credential', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(keylessAdapter());
  await manager.init();

  const models = await manager.listModels('local-test');
  assert.equal(models[0]?.id, 'local-model');
});

test('model fallback honors provider-specific conservative capabilities', () => {
  const registry = new ProviderRegistry();
  registry.register(keylessAdapter());
  const resolver = new ModelResolver(registry);
  const fallback = resolver.fallbackForConfiguredModel({ id: 'local-test', displayName: 'Local Test', apiKey: '', enabled: true }, 'local-model');
  assert.deepEqual(fallback.capabilities, ['text', 'streaming']);
  assert.equal(fallback.capabilities.includes('tools'), false);
});
