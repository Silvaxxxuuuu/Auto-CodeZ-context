import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountMemoryRuntime } from '../src/account-memory-runtime';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';

const secure: SecureStorageAdapter = {
  isEncryptionAvailable: () => true,
  encrypt: (value) => Buffer.from(`enc:${value}`, 'utf8'),
  decrypt: (value) => {
    const text = value.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not encrypted');
    return text.slice(4);
  },
};

test('account memory stays isolated by account and scope and is encrypted at rest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autocodez-memory-'));
  let accountId: string | undefined = 'account-a';
  try {
    const storage = new LocalStorage(root, secure);
    await storage.init();
    const memory = new AccountMemoryRuntime(storage, () => accountId, (() => {
      let now = 1000;
      return () => ++now;
    })());
    await memory.init();

    const global = await memory.add({ scope: { type: 'global' }, content: 'Use respostas curtas.' });
    const project = await memory.add({
      scope: { type: 'project', projectId: 'project-a' },
      content: 'Este projeto usa TypeScript.',
      source: { chatId: 'chat-a', runId: 'run-a', messageCreatedAt: 99 },
    });
    await memory.add({ scope: { type: 'chat', chatId: 'chat-a' }, content: 'Contexto só desta conversa.' });

    assert.deepEqual(memory.list({ type: 'global' }).map((entry) => entry.id), [global.id]);
    assert.deepEqual(memory.list({ type: 'project', projectId: 'project-a' }).map((entry) => entry.id), [project.id]);
    assert.equal(memory.list().length, 3);
    const fullContext = memory.context({ chatId: 'chat-a', projectId: 'project-a' });
    assert.match(fullContext ?? '', /Use respostas curtas/);
    assert.match(fullContext ?? '', /Este projeto usa TypeScript/);
    assert.match(fullContext ?? '', /Contexto só desta conversa/);
    const otherContext = memory.context({ chatId: 'chat-b', projectId: 'project-b' });
    assert.match(otherContext ?? '', /Use respostas curtas/);
    assert.doesNotMatch(otherContext ?? '', /TypeScript|só desta conversa/);

    accountId = 'account-b';
    assert.deepEqual(memory.list(), []);
    await memory.add({ scope: { type: 'global' }, content: 'Preferência da conta B.' });
    assert.equal(memory.list().length, 1);

    accountId = 'account-a';
    assert.equal(memory.list().length, 3);
    assert.equal(await memory.remove(project.id), true);
    assert.equal(memory.list().length, 2);

    const raw = await fs.readFile(path.join(root, 'account-memories.json'));
    assert.equal(raw.toString('utf8').includes('Use respostas curtas.'), false);

    const restored = new AccountMemoryRuntime(storage, () => accountId);
    await restored.init();
    assert.deepEqual(restored.list().map((entry) => entry.content).sort(), [
      'Contexto só desta conversa.',
      'Use respostas curtas.',
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 30 : 0, retryDelay: 100 });
  }
});

test('account memory requires an authenticated account and validates scope/content', async () => {
  const values = new Map<string, unknown>();
  const storage = {
    read: async <T>(name: string, fallback: T): Promise<T> => values.has(name) ? values.get(name) as T : fallback,
    write: async <T>(name: string, value: T): Promise<void> => { values.set(name, value); },
  };
  let accountId: string | undefined;
  const memory = new AccountMemoryRuntime(storage as never, () => accountId);
  await memory.init();
  await assert.rejects(() => memory.add({ scope: { type: 'global' }, content: 'x' }), /Entre em uma conta/i);
  assert.throws(() => memory.list(), /Entre em uma conta/i);

  accountId = 'account-a';
  await assert.rejects(() => memory.add({ scope: { type: 'project', projectId: ' ' }, content: 'x' }), /Escopo/i);
  await assert.rejects(() => memory.add({ scope: { type: 'global' }, content: '   ' }), /vazia/i);
  await assert.rejects(() => memory.add({ scope: { type: 'global' }, content: 'x'.repeat(8001) }), /8000/);
});
