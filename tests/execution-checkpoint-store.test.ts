import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalStorage } from '../src/core/storage';
import { ExecutionCheckpointRuntime, type ExecutionCheckpoint } from '../src/execution-checkpoint';
import { ExecutionCheckpointPersistence, ExecutionCheckpointStore } from '../src/execution-checkpoint-store';

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

function checkpoint(input: Partial<ExecutionCheckpoint> = {}): ExecutionCheckpoint {
  return {
    id: input.id ?? 'checkpoint-a',
    chatId: input.chatId ?? 'chat-a',
    runId: input.runId ?? 'run-a',
    projectId: input.projectId ?? 'project-a',
    toolCallId: input.toolCallId ?? 'tool-a',
    createdAt: input.createdAt ?? 1000,
    status: input.status ?? 'ready',
    changes: input.changes ?? [{
      path: 'src/a.ts',
      type: 'modified',
      before: 'old',
      after: 'new',
      addedLines: 1,
      removedLines: 1,
    }],
    ...(input.restoredAt !== undefined ? { restoredAt: input.restoredAt } : {}),
  };
}

test('salva e carrega checkpoints válidos sem compartilhar referências', async () => {
  const storage = new MemoryStorage();
  const store = new ExecutionCheckpointStore(storage as unknown as LocalStorage);
  const original = checkpoint();

  await store.save([original]);
  original.changes[0].path = 'mutated.ts';

  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].changes[0].path, 'src/a.ts');

  loaded[0].changes[0].path = 'mutated-again.ts';
  assert.equal((await store.load())[0].changes[0].path, 'src/a.ts');
});

test('ignora registros inválidos e deduplica por id', async () => {
  const storage = new MemoryStorage();
  storage.seed('execution-checkpoints.json', {
    version: 1,
    checkpoints: [
      checkpoint({ id: 'same', createdAt: 1000 }),
      checkpoint({ id: 'same', createdAt: 2000, runId: 'run-new' }),
      { ...checkpoint({ id: 'bad' }), status: 'unknown' },
      { ...checkpoint({ id: 'bad-time' }), createdAt: -1 },
    ],
  });
  const store = new ExecutionCheckpointStore(storage as unknown as LocalStorage);

  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'same');
  assert.equal(loaded[0].runId, 'run-new');
});

test('preserva checkpoints restaurados somente com restoredAt coerente', async () => {
  const storage = new MemoryStorage();
  storage.seed('execution-checkpoints.json', {
    version: 1,
    checkpoints: [
      checkpoint({ id: 'restored', status: 'restored', createdAt: 1000, restoredAt: 1500 }),
      checkpoint({ id: 'invalid-restored', status: 'restored', createdAt: 2000, restoredAt: 1500 }),
      checkpoint({ id: 'invalid-ready', status: 'ready', restoredAt: 3000 }),
    ],
  });
  const store = new ExecutionCheckpointStore(storage as unknown as LocalStorage);

  const loaded = await store.load();
  assert.deepEqual(loaded.map((item) => item.id), ['restored']);
});

test('hydrate restaura o estado persistido sem compartilhar referências', () => {
  const runtime = new ExecutionCheckpointRuntime(() => 5000, () => 'generated');
  const persisted = checkpoint({ id: 'persisted' });

  runtime.hydrate([persisted]);
  persisted.changes[0].path = 'outside.ts';

  const loaded = runtime.get('persisted');
  assert.equal(loaded?.changes[0].path, 'src/a.ts');
  loaded!.changes[0].path = 'inside.ts';
  assert.equal(runtime.get('persisted')?.changes[0].path, 'src/a.ts');
});

test('hydrate é atômico diante de checkpoint inválido ou duplicado', () => {
  const runtime = new ExecutionCheckpointRuntime(() => 5000, () => 'generated');
  runtime.hydrate([checkpoint({ id: 'existing' })]);

  assert.throws(() => runtime.hydrate([
    checkpoint({ id: 'next' }),
    { ...checkpoint({ id: 'broken' }), status: 'restored', restoredAt: 500 },
  ]), /restauração/i);
  assert.equal(runtime.get('existing')?.id, 'existing');

  assert.throws(() => runtime.hydrate([
    checkpoint({ id: 'duplicate' }),
    checkpoint({ id: 'duplicate', runId: 'run-b' }),
  ]), /duplicado/i);
  assert.equal(runtime.get('existing')?.id, 'existing');
});

test('persistence serializa gravações e expõe erro no flush', async () => {
  const storage = new MemoryStorage();
  const store = new ExecutionCheckpointStore(storage as unknown as LocalStorage);
  const persistence = new ExecutionCheckpointPersistence(store);

  persistence.schedule([checkpoint({ id: 'first', createdAt: 1000 })]);
  persistence.schedule([checkpoint({ id: 'second', createdAt: 2000 })]);
  await persistence.flush();
  assert.deepEqual((await store.load()).map((item) => item.id), ['second']);

  storage.failWrites = true;
  persistence.schedule([checkpoint({ id: 'failed' })]);
  await assert.rejects(() => persistence.flush(), /write failed/i);
});
