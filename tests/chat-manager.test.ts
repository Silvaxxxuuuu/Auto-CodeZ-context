import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatManager, UNCONFIGURED_MODEL_ID, UNCONFIGURED_PROVIDER_ID } from '../src/core/chat-manager';
import type { ChatRecord } from '../src/ai/types';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, value);
  }
}

test('creates and persists a draft chat without an AI provider', async () => {
  const storage = new MemoryStorage();
  const manager = new ChatManager(storage as never);

  await manager.init();
  const chat = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });

  assert.equal(chat.title, 'Novo chat');
  assert.equal(chat.providerId, UNCONFIGURED_PROVIDER_ID);
  assert.equal(chat.model, UNCONFIGURED_MODEL_ID);
  assert.deepEqual(chat.messages, []);

  const persisted = await storage.read<ChatRecord[]>('chats.json', []);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.id, chat.id);
});

test('restores an empty draft chat after reinitialization', async () => {
  const storage = new MemoryStorage();
  const first = new ChatManager(storage as never);
  await first.init();
  const created = await first.create({ intelligence: 'normal', permissionLevel: 'safe' });

  const second = new ChatManager(storage as never);
  await second.init();
  const chats = await second.list();

  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.id, created.id);
  assert.equal(chats[0]?.messages.length, 0);
});
