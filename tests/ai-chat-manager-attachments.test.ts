import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatManager } from '../src/ai/chat-manager';
import type { ChatRecord } from '../src/ai/types';

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async read<T>(name: string, fallback: T): Promise<T> {
    return this.values.has(name) ? this.values.get(name) as T : fallback;
  }
  async write<T>(name: string, value: T): Promise<void> {
    this.values.set(name, structuredClone(value));
  }
}

test('AI ChatManager strips ephemeral attachment bytes before persistence and public snapshots', async () => {
  const storage = new MemoryStorage();
  const manager = new ChatManager(storage);
  await manager.init();
  const chat = await manager.create({
    providerId: 'openai',
    model: 'gpt-5.6',
    intelligence: 'normal',
    permissionLevel: 'safe',
  });

  const updated = await manager.addMessage(chat.id, {
    role: 'user',
    content: 'Analise.',
    attachments: [{
      id: 'att-1',
      kind: 'image',
      name: 'screen.png',
      mediaType: 'image/png',
      size: 5,
      storageKey: 'a'.repeat(64),
      sha256: 'a'.repeat(64),
      createdAt: 1,
      dataBase64: 'SECRET_BASE64',
    }],
  });

  assert.equal(updated.messages[0]?.attachments?.[0]?.dataBase64, undefined);
  const persisted = storage.values.get('chats.json') as ChatRecord[];
  assert.equal(persisted[0]?.messages[0]?.attachments?.[0]?.dataBase64, undefined);
  assert.equal(JSON.stringify(persisted).includes('SECRET_BASE64'), false);
});
