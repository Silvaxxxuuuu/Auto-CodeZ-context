import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionPlanHistoryPersistence, ExecutionPlanHistoryStore } from '../src/execution-plan-history-store';
import type { ExecutionPlanHistoryRecord } from '../src/execution-plan-history';

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

function record(): ExecutionPlanHistoryRecord {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    planId: 'plan-a',
    firstSeenAt: 1000,
    lastSeenAt: 1200,
    plan: {
      id: 'plan-a',
      chatId: 'chat-a',
      runId: 'run-a',
      objective: 'Editar C:/Users/User/ProjetoPrivado',
      status: 'completed',
      createdAt: 1000,
      updatedAt: 1200,
      steps: [{
        id: 'step-a',
        title: 'Editar arquivo',
        status: 'completed',
        createdAt: 1000,
        updatedAt: 1200,
        evidence: [{ type: 'file', summary: 'Arquivo alterado', reference: 'src/private.ts', createdAt: 1150 }],
      }],
    },
  };
}

test('histórico de planos é persistido criptografado', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plan-history-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionPlanHistoryStore(storage);
    await store.save([record()]);

    const raw = await readFile(path.join(root, 'execution-plan-history.json'), 'utf8');
    assert.equal(raw.includes('ProjetoPrivado'), false);
    assert.equal(raw.includes('src/private.ts'), false);
    assert.deepEqual(await store.load(), [record()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fila de histórico preserva o snapshot mais recente', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plan-history-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionPlanHistoryStore(storage);
    const persistence = new ExecutionPlanHistoryPersistence(store);
    const first = record();
    const second = structuredClone(first);
    second.lastSeenAt = 1300;
    second.plan.updatedAt = 1300;
    second.plan.objective = 'Versão final';

    persistence.schedule([first]);
    persistence.schedule([second]);
    await persistence.flush();

    assert.equal((await store.load())[0].plan.objective, 'Versão final');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('histórico de planos falha fechado sem armazenamento seguro', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plan-history-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionPlanHistoryStore(storage);
    await assert.rejects(store.save([record()]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
