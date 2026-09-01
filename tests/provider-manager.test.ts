import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderManager, selectDefaultModel } from '../src/ai/provider-manager';
import { ProviderRequestError } from '../src/ai/provider-errors';
import type { AIModel, AIProviderAdapter } from '../src/ai/types';

function model(id: string, providerId = 'google', capabilities: AIModel['capabilities'] = ['text', 'streaming', 'tools']): AIModel {
  return { id, name: id, providerId, capabilities };
}

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

test('model selection prefers practical capabilities over a weaker model', () => {
  const models = [model('model-basic', 'google', ['text']), model('model-full', 'google', ['text', 'streaming', 'tools'])];
  assert.equal(selectDefaultModel('google', models), 'model-full');
});

test('OpenAI uses the same generic selection policy', () => {
  const models = [model('gpt-5-mini', 'openai', ['text']), model('gpt-5', 'openai', ['text', 'streaming', 'tools'])];
  assert.equal(selectDefaultModel('openai', models), 'gpt-5');
});

test('Anthropic uses the same generic selection policy', () => {
  const models = [model('claude-sonnet', 'anthropic', ['text']), model('claude-opus', 'anthropic', ['text', 'streaming', 'tools'])];
  assert.equal(selectDefaultModel('anthropic', models), 'claude-opus');
});

test('future providers use the generic policy without a provider-specific entry', () => {
  const models = [model('acme-4-preview', 'acme', ['text', 'streaming', 'tools']), model('acme-4', 'acme', ['text', 'streaming', 'tools'])];
  assert.equal(selectDefaultModel('acme', models), 'acme-4');
});

test('preview and lightweight variants lose priority to a stable general model', () => {
  const models = [model('gemini-3.7-flash-preview', 'google'), model('gemini-3.6-flash-lite', 'google'), model('gemini-3.5-flash', 'google')];
  assert.equal(selectDefaultModel('google', models), 'gemini-3.5-flash');
});

test('default model selection preserves provider order when scores tie', () => {
  const models = [model('custom-model-a'), model('custom-model-b')];
  assert.equal(selectDefaultModel('openai', models), 'custom-model-a');
});

test('default model selection returns undefined for an empty model list', () => {
  assert.equal(selectDefaultModel('google', []), undefined);
});

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
  manager.registry.register(adapter(async () => [model('model', 'openai', ['text', 'streaming', 'tools'])]));
  const result = await manager.save({ providerId: 'openai', apiKey: 'test-key' });
  assert.equal(result.models[0].id, 'model');
  assert.equal((await manager.list()).find((provider) => provider.id === 'openai')?.selectedModel, 'model');
});
