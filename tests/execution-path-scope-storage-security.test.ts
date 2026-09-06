import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionPathScopeStore } from '../src/execution-path-scope-store';

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

test('Execution Path Scope é persistido criptografado incluindo paths permitidos', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-path-scope-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionPathScopeStore(storage);
    await store.save([{
      chatId: 'chat-sensitive',
      runId: 'run-sensitive',
      projectId: 'project-sensitive',
      allowedPaths: ['src/private-module', 'tests/private'],
      configuredAt: 1000,
    }]);

    const raw = await readFile(path.join(root, 'execution-path-scopes.json'), 'utf8');
    assert.equal(raw.includes('chat-sensitive'), false);
    assert.equal(raw.includes('private-module'), false);
    assert.equal(raw.includes('project-sensitive'), false);

    const restored = await store.load();
    assert.equal(restored[0].chatId, 'chat-sensitive');
    assert.equal(restored[0].projectId, 'project-sensitive');
    assert.deepEqual(restored[0].allowedPaths, ['src/private-module', 'tests/private']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Execution Path Scope falha fechado quando armazenamento seguro não está disponível', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-path-scope-security-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionPathScopeStore(storage);
    await assert.rejects(store.save([{
      chatId: 'chat-a',
      runId: 'run-a',
      projectId: 'project-a',
      allowedPaths: ['src'],
      configuredAt: 1000,
    }]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
