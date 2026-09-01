import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderManager } from '../src/ai/provider-manager';
import { ProviderRequestError } from '../src/ai/provider-errors';
import type { AIModel, AIProviderAdapter } from '../src/ai/types';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  private readonly encrypted = new Map<string, string>();
  async read<T>(name: string, fallback: T): Promise<T> { return (this.values.get(name) as T | undefined) ?? fallback; }
  async write<T>(name: string, value: T): Promise<void> { this.values.set(name, value); }
  async readEncrypted(name: string): Promise<string | null> { return this.encrypted.get(name) ?? null; }
  async writeEncrypted(name: string, value: string): Promise<void> { this.encrypted.set(name, value); }
}

function adapter(listModels: AIProviderAdapter['listModels']): AIProviderAdapter {
  return { id: 'openai', displayName: 'OpenAI', listModels, send: async () => ({ content: 'ok', model: 'model', providerId: 'openai' }) };
}

const model: AIModel = { id: 'model', name: 'Model', providerId: 'openai', capabilities: ['text', 'streaming', 'tools'] };

test('provider manager preserves a key when model discovery temporarily fails', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(adapter(async () => { throw new Error('quota exceeded'); }));
  const result = await manager.save({ providerId: 'openai', apiKey: 'test-key' });
  assert.equal(result.models.length, 0);
  assert.match(result.discoveryError || '', /quota exceeded/);
  assert.equal((await manager.list()).find((provider) => provider.id === 'openai')?.configured, true);
  assert.equal(manager.getConfig('openai').apiKey, 'test-key');
});

test('provider manager refuses an authentication failure before persisting the key', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(adapter(async () => { throw new Error('Invalid API key'); }));
  await assert.rejects(() => manager.save({ providerId: 'openai', apiKey: 'bad-key' }), /Invalid API key/);
  assert.equal((await manager.list()).find((provider) => provider.id === 'openai')?.configured, false);
});

test('provider manager preserves typed authentication failures as well', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(adapter(async () => { throw new ProviderRequestError('Unauthorized', 401); }));
  await assert.rejects(() => manager.save({ providerId: 'openai', apiKey: 'bad-key' }), /Unauthorized/);
  assert.equal((await manager.list()).find((provider) => provider.id === 'openai')?.configured, false);
});

test('provider manager selects a default model after successful discovery', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(adapter(async () => [model]));
  const result = await manager.save({ providerId: 'openai', apiKey: 'test-key' });
  assert.equal(result.models[0].id, 'model');
  assert.equal((await manager.list()).find((provider) => provider.id === 'openai')?.selectedModel, 'model');
});
