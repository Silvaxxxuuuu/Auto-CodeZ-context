import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShadowWorkspaceSnapshot } from '../src/agent/shadow-workspace';
import { ExecutionShadowWorkspacePersistence, ExecutionShadowWorkspaceStore } from '../src/execution-shadow-workspace-store';

function snapshot(overrides: Partial<ShadowWorkspaceSnapshot> = {}): ShadowWorkspaceSnapshot {
  return {
    chatId: 'chat-a',
    runId: 'run-a',
    projectId: 'project-a',
    createdAt: 100,
    updatedAt: 110,
    status: 'active',
    changes: [{
      path: 'src/main.ts',
      type: 'modified',
      before: 'const value = 1;\n',
      after: 'const value = 2;\n',
      addedLines: 1,
      removedLines: 1,
    }],
    ...overrides,
  };
}

function memoryStorage(initial: unknown = { version: 1, snapshots: [] }) {
  let value = structuredClone(initial);
  return {
    read: async <T>(_name: string, fallback: T): Promise<T> => structuredClone(value ?? fallback) as T,
    write: async <T>(_name: string, next: T): Promise<void> => {
      value = structuredClone(next);
    },
    current: () => structuredClone(value),
  };
}

test('store salva e carrega snapshots ativos com cópias defensivas', async () => {
  const storage = memoryStorage();
  const store = new ExecutionShadowWorkspaceStore(storage as never);
  const original = snapshot();

  await store.save([original]);
  original.changes[0].after = 'tampered';

  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].changes[0].after, 'const value = 2;\n');

  loaded[0].changes[0].after = 'mutated-load';
  assert.equal((await store.load())[0].changes[0].after, 'const value = 2;\n');
});

test('store ignora snapshots terminais ou inválidos e deduplica chat/run pelo updatedAt', async () => {
  const older = snapshot({ updatedAt: 110 });
  const newer = snapshot({ updatedAt: 120, projectId: 'project-newer' });
  const terminal = snapshot({ chatId: 'chat-terminal', runId: 'run-terminal', status: 'discarded' });
  const malformed = { ...snapshot({ chatId: 'chat-bad', runId: 'run-bad' }), changes: [{ path: '', type: 'modified' }] };
  const storage = memoryStorage({ version: 1, snapshots: [older, terminal, malformed, newer] });
  const store = new ExecutionShadowWorkspaceStore(storage as never);

  const loaded = await store.load();

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].projectId, 'project-newer');
  assert.equal(loaded[0].updatedAt, 120);
});

test('store rejeita versão futura devolvendo lista vazia', async () => {
  const storage = memoryStorage({ version: 2, snapshots: [snapshot()] });
  const store = new ExecutionShadowWorkspaceStore(storage as never);

  assert.deepEqual(await store.load(), []);
});

test('persistence serializa a visão mais recente e expõe falha no flush', async () => {
  const writes: ShadowWorkspaceSnapshot[][] = [];
  let fail = false;
  const store = {
    save: async (snapshots: ShadowWorkspaceSnapshot[]) => {
      if (fail) throw new Error('persist failed');
      writes.push(structuredClone(snapshots));
    },
  } as unknown as ExecutionShadowWorkspaceStore;
  const persistence = new ExecutionShadowWorkspacePersistence(store);

  persistence.schedule([snapshot({ updatedAt: 110 })]);
  persistence.schedule([snapshot({ updatedAt: 120 })]);
  await persistence.flush();
  assert.equal(writes.at(-1)?.[0].updatedAt, 120);

  fail = true;
  persistence.schedule([snapshot({ updatedAt: 130 })]);
  await assert.rejects(() => persistence.flush(), /persist failed/i);
});
