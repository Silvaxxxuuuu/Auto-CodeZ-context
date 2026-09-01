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

function createManager(storage: MemoryStorage): ChatManager {
  return new ChatManager(storage as never);
}

test('creates a temporary draft chat without an AI provider', async () => {
  const storage = new MemoryStorage();
  const manager = createManager(storage);

  await manager.init();
  const chat = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });

  assert.equal(chat.title, 'Novo chat');
  assert.equal(chat.providerId, UNCONFIGURED_PROVIDER_ID);
  assert.equal(chat.model, UNCONFIGURED_MODEL_ID);
  assert.deepEqual(chat.messages, []);

  const persisted = await storage.read<ChatRecord[]>('chats.json', []);
  assert.deepEqual(persisted, []);
});

test('does not restore an empty draft chat after reinitialization', async () => {
  const storage = new MemoryStorage();
  const first = createManager(storage);
  await first.init();
  const created = await first.create({ intelligence: 'normal', permissionLevel: 'safe' });

  const second = createManager(storage);
  await second.init();
  const chats = await second.list();

  assert.equal(chats.length, 0);
  assert.notEqual(created.id, '');
});

test('persists a draft when the first user message is added and derives its title', async () => {
  const storage = new MemoryStorage();
  const first = createManager(storage);
  await first.init();
  const created = await first.create({ intelligence: 'normal', permissionLevel: 'safe' });

  const userMessage = { role: 'user' as const, content: 'Como funciona o Auto CodeZ?' };
  await first.addMessage(created.id, userMessage);
  await first.addMessage(created.id, { role: 'assistant', content: 'Ele conecta o chat ao projeto local.' });

  const second = createManager(storage);
  await second.init();
  const [restored] = await second.list();

  assert.ok(restored);
  assert.equal(restored.id, created.id);
  assert.equal(restored.title, userMessage.content);
  assert.deepEqual(restored.messages.map(({ role, content }) => ({ role, content })), [
    userMessage,
    { role: 'assistant', content: 'Ele conecta o chat ao projeto local.' },
  ]);
});

test('lists chats by most recently updated timestamp', async () => {
  const storage = new MemoryStorage();
  const manager = createManager(storage);
  await manager.init();

  const older = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });
  const newer = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });
  await manager.addMessage(older.id, { role: 'user', content: 'Persistir este chat' });
  await manager.addMessage(newer.id, { role: 'user', content: 'Persistir este também' });

  assert.deepEqual((await manager.list()).map((chat) => chat.id), [newer.id, older.id]);

  await manager.addMessage(older.id, { role: 'user', content: 'Atualizar este chat' });

  const chats = await manager.list();
  assert.deepEqual(chats.map((chat) => chat.id), [older.id, newer.id]);
});

test('deletes a chat and persists the deletion', async () => {
  const storage = new MemoryStorage();
  const manager = createManager(storage);
  await manager.init();

  const keep = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });
  const remove = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });
  await manager.addMessage(keep.id, { role: 'user', content: 'Manter este chat' });
  await manager.addMessage(remove.id, { role: 'user', content: 'Excluir este chat' });

  await manager.delete(remove.id);

  assert.deepEqual((await manager.list()).map((chat) => chat.id), [keep.id]);
  const persisted = await storage.read<ChatRecord[]>('chats.json', []);
  assert.deepEqual(persisted.map((chat) => chat.id), [keep.id]);
});
