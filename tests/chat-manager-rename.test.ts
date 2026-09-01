import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatManager } from '../src/ai/chat-manager';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }

  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, value);
  }
}

test('renames a chat and persists the normalized title', async () => {
  const storage = new MemoryStorage();
  const manager = new ChatManager(storage);
  await manager.init();

  const chat = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });
  const renamed = await manager.rename(chat.id, '  Meu   projeto   novo  ');

  assert.equal(renamed.title, 'Meu projeto novo');
  assert.equal((await manager.list())[0]?.title, 'Meu projeto novo');
});

test('rejects empty and oversized chat names', async () => {
  const storage = new MemoryStorage();
  const manager = new ChatManager(storage);
  await manager.init();

  const chat = await manager.create({ intelligence: 'normal', permissionLevel: 'safe' });
  await assert.rejects(() => manager.rename(chat.id, '   '), /não pode ficar vazio/);
  await assert.rejects(() => manager.rename(chat.id, 'x'.repeat(81)), /no máximo 80/);
});
