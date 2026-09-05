import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionChangeBudgetStore } from '../src/execution-change-budget-store';

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

test('Change Budget é persistido criptografado incluindo paths tocados', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-change-budget-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionChangeBudgetStore(storage);
    await store.save([{
      chatId: 'chat-sensitive',
      runId: 'run-sensitive',
      budget: { maxFiles: 4, maxChangedLines: 100, maxCommands: 3, maxToolCalls: 12, maxDurationMs: 60_000 },
      usage: { files: ['src/private-module.ts'], changedLines: 20, commands: 1, toolCalls: 4 },
      startedAt: 1000,
    }]);

    const raw = await readFile(path.join(root, 'execution-change-budget.json'), 'utf8');
    assert.equal(raw.includes('chat-sensitive'), false);
    assert.equal(raw.includes('private-module'), false);

    const restored = await store.load();
    assert.equal(restored[0].chatId, 'chat-sensitive');
    assert.deepEqual(restored[0].usage.files, ['src/private-module.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Change Budget falha fechado quando armazenamento seguro não está disponível', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-change-budget-security-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionChangeBudgetStore(storage);
    await assert.rejects(store.save([{
      chatId: 'chat-a',
      runId: 'run-a',
      budget: { maxFiles: 1 },
      usage: { files: [], changedLines: 0, commands: 0, toolCalls: 0 },
      startedAt: 1000,
    }]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
