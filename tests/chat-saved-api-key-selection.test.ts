import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatManager } from '../src/ai/chat-manager';
import { ProviderManager } from '../src/ai/provider-manager';
import type { AIModel, AIProviderAdapter } from '../src/ai/types';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  private readonly encrypted = new Map<string, string>();
  async read<T>(name: string, fallback: T): Promise<T> { return (this.values.get(name) as T | undefined) ?? fallback; }
  async write<T>(name: string, value: T): Promise<void> { this.values.set(name, value); }
  async readEncrypted(name: string): Promise<string | null> { return this.encrypted.get(name) ?? null; }
  async writeEncrypted(name: string, value: string): Promise<void> { this.encrypted.set(name, value); }
}

const adapter: AIProviderAdapter = {
  id: 'openai',
  displayName: 'OpenAI',
  listModels: async (config) => [{ id: config.selectedModel || 'model', name: config.selectedModel || 'model', providerId: config.id, capabilities: ['text', 'streaming'] } as AIModel],
  send: async () => ({ content: 'ok', model: 'model', providerId: 'openai' }),
};

test('chat persists the exact saved API key selection', async () => {
  const storage = new MemoryStorage();
  const manager = new ChatManager(storage);
  await manager.init();
  const created = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });

  const updated = await manager.updateSettings({ chatId: created.id, providerId: 'openai', model: 'model', apiKeyId: 'key-123', intelligence: 'normal', permissionLevel: 'safe' });
  assert.equal(updated.apiKeyId, 'key-123');

  const restored = new ChatManager(storage);
  await restored.init();
  assert.equal((await restored.list())[0].apiKeyId, 'key-123');
});

test('provider manager resolves the exact selected key instead of the provider active key', async () => {
  const storage = new MemoryStorage();
  const manager = new ProviderManager(storage);
  manager.registry.register(adapter);

  const first = await manager.saveKey({ providerId: 'openai', name: 'Primeira', apiKey: 'key-first-1234', model: 'model' });
  const second = await manager.saveKey({ providerId: 'openai', name: 'Segunda', apiKey: 'key-second-5678', model: 'model' });
  await manager.setActiveKey(second.key.id);

  assert.equal(manager.getConfig('openai').apiKey, 'key-second-5678');
  assert.equal(manager.getConfigForKey(first.key.id).apiKey, 'key-first-1234');
  assert.equal(manager.getConfigForKey(first.key.id).id, 'openai');
});
