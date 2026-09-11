import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionPlanStore } from '../src/execution-plan-store';
import type { ExecutionPlan } from '../src/execution-planner';

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

function plan(): ExecutionPlan {
  return {
    id: 'plan-a',
    chatId: 'chat-a',
    runId: 'run-a',
    objective: 'Corrigir segredo do login',
    status: 'pending',
    createdAt: 1000,
    updatedAt: 1000,
    steps: [{
      id: 'step-a',
      title: 'Ler arquivo privado',
      status: 'pending',
      createdAt: 1000,
      updatedAt: 1000,
      evidence: [{ type: 'file', summary: 'Arquivo sensível', reference: 'src/private.ts', createdAt: 1000 }],
    }],
  };
}

test('planos de execução são persistidos criptografados e restaurados', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plan-security-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionPlanStore(storage);
    await store.save([plan()]);

    const raw = await readFile(path.join(root, 'execution-plans.json'), 'utf8');
    assert.equal(raw.includes('Corrigir segredo do login'), false);
    assert.equal(raw.includes('src/private.ts'), false);

    const restored = await store.load();
    assert.equal(restored[0].objective, 'Corrigir segredo do login');
    assert.equal(restored[0].steps[0].evidence[0].reference, 'src/private.ts');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistência de plano falha fechada sem armazenamento seguro', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-plan-security-'));
  try {
    const adapter: SecureStorageAdapter = {
      ...secureAdapter(),
      isEncryptionAvailable: () => false,
    };
    const storage = new LocalStorage(root, adapter);
    await storage.init();
    const store = new ExecutionPlanStore(storage);

    await assert.rejects(store.save([plan()]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
