import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalStorage } from '../src/core/storage';
import { ExecutionPathScopePersistence, ExecutionPathScopeStore } from '../src/execution-path-scope-store';
import type { ExecutionPathScopeSnapshot } from '../src/execution-path-scope';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  failWrites = false;

  async read<T>(name: string, fallback: T): Promise<T> {
    return structuredClone((this.values.has(name) ? this.values.get(name) : fallback) as T);
  }

  async write<T>(name: string, value: T): Promise<void> {
    if (this.failWrites) throw new Error('write failed');
    this.values.set(name, structuredClone(value));
  }

  seed(name: string, value: unknown): void {
    this.values.set(name, structuredClone(value));
  }
}

function snapshot(input: Partial<ExecutionPathScopeSnapshot> = {}): ExecutionPathScopeSnapshot {
  return {
    chatId: input.chatId ?? 'chat-a',
    runId: input.runId ?? 'run-a',
    projectId: input.projectId ?? 'project-a',
    allowedPaths: input.allowedPaths ?? ['src'],
    configuredAt: input.configuredAt ?? 1000,
  };
}

test('store salva e carrega snapshots normalizados com cópias defensivas', async () => {
  const storage = new MemoryStorage();
  const store = new ExecutionPathScopeStore(storage as unknown as LocalStorage);
  const original = snapshot({ allowedPaths: ['./src', 'tests\\unit', 'src'] });

  await store.save([original]);
  original.allowedPaths.push('mutated');

  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].allowedPaths, ['src', 'tests/unit']);
  loaded[0].allowedPaths.push('outside');
  assert.deepEqual((await store.load())[0].allowedPaths, ['src', 'tests/unit']);
});

test('store ignora registros inválidos e mantém o snapshot mais recente por execução', async () => {
  const storage = new MemoryStorage();
  storage.seed('execution-path-scopes.json', {
    version: 1,
    snapshots: [
      snapshot({ configuredAt: 1000, allowedPaths: ['src'] }),
      snapshot({ configuredAt: 2000, allowedPaths: ['tests'] }),
      { chatId: '', runId: 'broken', projectId: 'project-a', allowedPaths: ['src'], configuredAt: 3000 },
      snapshot({ runId: 'absolute', allowedPaths: ['C:/secret'] }),
    ],
  });
  const loaded = await new ExecutionPathScopeStore(storage as unknown as LocalStorage).load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].configuredAt, 2000);
  assert.deepEqual(loaded[0].allowedPaths, ['tests']);
});

test('persistence serializa a visão mais recente e expõe falha no flush', async () => {
  const storage = new MemoryStorage();
  const store = new ExecutionPathScopeStore(storage as unknown as LocalStorage);
  const persistence = new ExecutionPathScopePersistence(store);

  persistence.schedule([snapshot({ runId: 'first' })]);
  persistence.schedule([snapshot({ runId: 'second', configuredAt: 2000 })]);
  await persistence.flush();
  assert.deepEqual((await store.load()).map((item) => item.runId), ['second']);

  storage.failWrites = true;
  persistence.schedule([snapshot({ runId: 'failed' })]);
  await assert.rejects(() => persistence.flush(), /write failed/i);
});
