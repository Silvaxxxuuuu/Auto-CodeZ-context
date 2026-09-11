import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage, type SecureStorageAdapter } from '../src/core/storage';
import { ExecutionQualityGatePersistence, ExecutionQualityGateStore } from '../src/execution-quality-gate-store';
import type { ExecutionQualityGate } from '../src/execution-quality-gate';

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

function gate(): ExecutionQualityGate {
  return {
    id: 'gate-a',
    chatId: 'chat-a',
    runId: 'run-a',
    requireVerifiedCompletion: true,
    requirements: [{ type: 'test', minimum: 1, label: 'npm test' }],
    createdAt: 1000,
  };
}

test('quality gates são persistidos criptografados', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-quality-gates-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionQualityGateStore(storage);
    await store.save([gate()]);

    const raw = await readFile(path.join(root, 'execution-quality-gates.json'), 'utf8');
    assert.equal(raw.includes('npm test'), false);
    assert.equal(raw.includes('chat-a'), false);
    assert.deepEqual(await store.load(), [gate()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fila de persistência preserva a configuração mais recente', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-quality-gates-'));
  try {
    const storage = new LocalStorage(root, secureAdapter());
    await storage.init();
    const store = new ExecutionQualityGateStore(storage);
    const persistence = new ExecutionQualityGatePersistence(store);
    const second = structuredClone(gate());
    second.id = 'gate-b';
    second.runId = 'run-b';

    persistence.schedule([gate()]);
    persistence.schedule([gate(), second]);
    await persistence.flush();

    assert.equal((await store.load()).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('quality gate persistence falha fechado sem armazenamento seguro', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-quality-gates-'));
  try {
    const storage = new LocalStorage(root, { ...secureAdapter(), isEncryptionAvailable: () => false });
    await storage.init();
    const store = new ExecutionQualityGateStore(storage);
    await assert.rejects(store.save([gate()]), /armazenamento seguro indisponível/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
