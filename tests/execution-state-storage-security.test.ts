import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionStateStore } from '../src/execution-state-store';

function secureAdapter(): SecureStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encrypt: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decrypt: (value) => {
      const decoded = value.toString('utf8');
      if (!decoded.startsWith('encrypted:')) throw new Error('Invalid encrypted payload.');
      return decoded.slice('encrypted:'.length);
    },
  };
}

test('estado canônico de execução é persistido criptografado', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-execution-state-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionStateStore(storage);
    await store.save([{
      chatId: 'chat-sensitive',
      runId: 'run-sensitive',
      state: 'failed',
      startedAt: 1000,
      updatedAt: 1200,
      error: 'Falha em C:/Users/User/ProjetoPrivado',
    }]);

    const raw = await readFile(path.join(root, 'execution-state.json'), 'utf8');
    assert.equal(raw.includes('chat-sensitive'), false);
    assert.equal(raw.includes('ProjetoPrivado'), false);

    const restored = await store.load();
    assert.equal(restored[0].chatId, 'chat-sensitive');
    assert.equal(restored[0].error, 'Falha em C:/Users/User/ProjetoPrivado');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('estado canônico falha fechado sem armazenamento seguro', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-execution-state-security-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionStateStore(storage);
    await assert.rejects(store.save([{
      chatId: 'chat-a',
      runId: 'run-a',
      state: 'running',
      startedAt: 1000,
      updatedAt: 1000,
    }]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
