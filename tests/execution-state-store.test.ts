import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStorage } from '../src/core/storage';
import { ExecutionStatePersistence, ExecutionStateStore } from '../src/execution-state-store';
import type { ExecutionSnapshot } from '../src/execution-manager';

async function withStorage<T>(callback: (storage: LocalStorage, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-codez-execution-state-'));
  try {
    const storage = new LocalStorage(root, {
      isEncryptionAvailable: () => true,
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: (value) => value.toString('utf8'),
    });
    await storage.init();
    return await callback(storage, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function snapshot(overrides: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    state: 'running',
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test('persiste e restaura snapshots válidos', async () => {
  await withStorage(async (storage) => {
    const store = new ExecutionStateStore(storage);
    await store.save([
      snapshot({ state: 'completed', updatedAt: 1400 }),
      snapshot({ chatId: 'chat-b', runId: 'run-b', state: 'failed', updatedAt: 1500, error: 'falhou' }),
    ]);

    assert.deepEqual(await store.load(), [
      snapshot({ state: 'completed', updatedAt: 1400 }),
      snapshot({ chatId: 'chat-b', runId: 'run-b', state: 'failed', updatedAt: 1500, error: 'falhou' }),
    ]);
  });
});

test('normaliza execução ativa de uma sessão anterior para interrupted', async () => {
  await withStorage(async (storage) => {
    const store = new ExecutionStateStore(storage);
    await store.save([
      snapshot({ state: 'running', currentTool: 'run_command' }),
      snapshot({ chatId: 'chat-b', runId: 'run-b', state: 'waiting_approval', currentTool: 'write_file' }),
    ]);

    const restored = await store.load();
    assert.deepEqual(restored.map((item) => ({ chatId: item.chatId, state: item.state, currentTool: item.currentTool })), [
      { chatId: 'chat-a', state: 'interrupted', currentTool: undefined },
      { chatId: 'chat-b', state: 'interrupted', currentTool: undefined },
    ]);
  });
});

test('ignora payload inválido e mantém somente o snapshot mais novo por chat', async () => {
  await withStorage(async (storage, root) => {
    await writeFile(path.join(root, 'execution-state.json'), JSON.stringify({
      version: 1,
      snapshots: [
        snapshot({ runId: 'old', updatedAt: 1100, state: 'completed' }),
        { chatId: '', runId: 'invalid', state: 'running', startedAt: 1, updatedAt: 1 },
        snapshot({ runId: 'new', updatedAt: 1500, state: 'failed', error: 'newest' }),
        { chatId: 'broken', runId: 'x', state: 'unknown', startedAt: 1, updatedAt: 2 },
      ],
    }), 'utf8');

    const store = new ExecutionStateStore(storage);
    const restored = await store.load();
    assert.equal(restored.length, 1);
    assert.equal(restored[0].runId, 'new');
    assert.equal(restored[0].error, 'newest');
  });
});

test('rejeita versão futura sem tentar interpretar o conteúdo', async () => {
  await withStorage(async (storage, root) => {
    await writeFile(path.join(root, 'execution-state.json'), JSON.stringify({ version: 99, snapshots: [snapshot()] }), 'utf8');
    const store = new ExecutionStateStore(storage);
    assert.deepEqual(await store.load(), []);
  });
});

test('fila de persistência preserva a última visão agendada', async () => {
  await withStorage(async (storage) => {
    const store = new ExecutionStateStore(storage);
    const persistence = new ExecutionStatePersistence(store);

    persistence.schedule([snapshot({ state: 'running', updatedAt: 1000 })]);
    persistence.schedule([snapshot({ state: 'waiting_approval', updatedAt: 1200, currentTool: 'write_file' })]);
    persistence.schedule([snapshot({ state: 'completed', updatedAt: 1400 })]);
    await persistence.flush();

    assert.deepEqual(await store.load(), [snapshot({ state: 'completed', updatedAt: 1400 })]);
  });
});
