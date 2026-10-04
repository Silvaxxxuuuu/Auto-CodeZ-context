import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionShadowWorkspaceStore } from '../src/execution-shadow-workspace-store';

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

const sensitiveSnapshot = {
  chatId: 'chat-shadow-sensitive',
  runId: 'run-shadow-sensitive',
  projectId: 'project-shadow-sensitive',
  createdAt: 1000,
  updatedAt: 1100,
  status: 'active' as const,
  changes: [{
    path: 'src/private-module.ts',
    type: 'modified' as const,
    before: 'const privateToken = "before-secret";\n',
    after: 'const privateToken = "after-secret";\n',
    addedLines: 1,
    removedLines: 1,
  }],
};

test('Shadow Workspace é persistido criptografado incluindo código e paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionShadowWorkspaceStore(storage);
    await store.save([sensitiveSnapshot]);

    const raw = await readFile(path.join(root, 'execution-shadow-workspaces.json'), 'utf8');
    assert.equal(raw.includes('chat-shadow-sensitive'), false);
    assert.equal(raw.includes('private-module'), false);
    assert.equal(raw.includes('before-secret'), false);
    assert.equal(raw.includes('after-secret'), false);

    const restored = await store.load();
    assert.equal(restored[0].chatId, 'chat-shadow-sensitive');
    assert.equal(restored[0].changes[0].path, 'src/private-module.ts');
    assert.equal(restored[0].changes[0].after, 'const privateToken = "after-secret";\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Shadow Workspace falha fechado quando armazenamento seguro está indisponível', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-shadow-security-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionShadowWorkspaceStore(storage);

    await assert.rejects(
      store.save([sensitiveSnapshot]),
      /armazenamento seguro indisponível/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
