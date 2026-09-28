import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { OperationJournalStore } from '../src/agent-core/operation-journal-store';

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

const sensitiveRecord = {
  contractVersion: 1 as const,
  operationId: 'op-sensitive',
  runId: 'run-sensitive',
  toolCallId: 'tool-sensitive',
  capabilityId: 'workspace.write_file',
  projectId: 'project-sensitive',
  target: 'src/private-module.ts',
  status: 'verified' as const,
  resources: [{
    target: 'src/private-module.ts',
    before: { exists: true, kind: 'file' as const, hash: 'before-secret-hash', contentRef: 'blob:private-before' },
    after: { exists: true, kind: 'file' as const, hash: 'after-secret-hash', contentRef: 'blob:private-after' },
    rollbackRef: 'blob:private-before',
  }],
  createdAt: 1000,
  updatedAt: 1100,
  verifiedAt: 1100,
};

test('Agent Core Operation Journal is encrypted at rest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-operation-journal-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new OperationJournalStore(storage);
    await store.save([sensitiveRecord]);

    const raw = await readFile(path.join(root, 'agent-core-operation-journal.json'), 'utf8');
    assert.equal(raw.includes('private-module'), false);
    assert.equal(raw.includes('before-secret-hash'), false);
    assert.equal(raw.includes('project-sensitive'), false);

    const restored = await store.load();
    assert.equal(restored[0].target, 'src/private-module.ts');
    assert.equal(restored[0].resources[0].before.hash, 'before-secret-hash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent Core Operation Journal fails closed without secure storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-operation-journal-security-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new OperationJournalStore(storage);
    await assert.rejects(() => store.save([sensitiveRecord]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
