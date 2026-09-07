import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionTaskCapsulePersistence, ExecutionTaskCapsuleStore } from '../src/execution-task-capsule-store';
import type { ExecutionTaskCapsule } from '../src/execution-task-capsule';

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

function capsule(): ExecutionTaskCapsule {
  return {
    id: 'capsule-a',
    chatId: 'chat-a',
    runId: 'run-a',
    objective: 'Alterar C:/Users/User/ProjetoPrivado',
    projectId: 'project-a',
    providerId: 'openai',
    model: 'model-a',
    permissionLevel: 'ask',
    createdAt: 1000,
  };
}

test('Task Capsule é persistida criptografada', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-task-capsules-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionTaskCapsuleStore(storage);
    await store.save([capsule()]);

    const raw = await readFile(path.join(root, 'execution-task-capsules.json'), 'utf8');
    assert.equal(raw.includes('ProjetoPrivado'), false);
    assert.equal(raw.includes('chat-a'), false);
    assert.deepEqual(await store.load(), [capsule()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fila da Task Capsule preserva o snapshot mais recente', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-task-capsules-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionTaskCapsuleStore(storage);
    const persistence = new ExecutionTaskCapsulePersistence(store);
    const second = { ...capsule(), id: 'capsule-b', chatId: 'chat-b', runId: 'run-b', objective: 'Outra tarefa' };

    persistence.schedule([capsule()]);
    persistence.schedule([capsule(), second]);
    await persistence.flush();

    assert.equal((await store.load()).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Task Capsule falha fechado sem armazenamento seguro', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-task-capsules-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionTaskCapsuleStore(storage);
    await assert.rejects(store.save([capsule()]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
